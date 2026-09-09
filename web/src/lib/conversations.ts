import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { userCard } from "./selects";
import { ApiError } from "./api";
import { redis } from "./rate-limit";

/**
 * Find-or-create a DIRECT conversation between two users.
 *
 * There is no relational constraint for "the DIRECT conversation whose member
 * set is exactly {A, B}", so concurrent "start chat" clicks from both sides
 * could create duplicate DMs. Instead we serialize on a Postgres transaction-
 * scoped advisory lock keyed by the sorted user pair, then find-or-create.
 */
export async function findOrCreateDirectConversation(aId: string, bId: string) {
  const [lo, hi] = [aId, bId].sort();
  return prisma.$transaction(async (tx) => {
    // Lock the pair for the lifetime of this transaction; concurrent callers
    // block here until the first one commits.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`dm:${lo}~${hi}`}))::text`;

    const existing = await tx.conversation.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: aId } } },
          { members: { some: { userId: bId } } },
        ],
      },
      include: { members: true },
    });
    if (existing && existing.members.length === 2) return existing;

    return tx.conversation.create({
      data: {
        type: "DIRECT",
        createdById: aId,
        members: {
          create: [{ userId: aId }, { userId: bId }],
        },
      },
      include: { members: true },
    });
  });
}

/** GROUP create: creator is OWNER, everyone else MEMBER, plus the chat-native audit trail. */
export async function createGroupConversation(
  creatorId: string,
  name: string,
  memberIds: string[]
) {
  return prisma.$transaction(async (tx) => {
    const creator = await tx.user.findUniqueOrThrow({
      where: { id: creatorId },
      select: { name: true },
    });
    const conversation = await tx.conversation.create({
      data: {
        type: "GROUP",
        name,
        createdById: creatorId,
        members: {
          create: [
            { userId: creatorId, role: "OWNER" as const },
            ...memberIds
              .filter((id) => id !== creatorId)
              .map((userId) => ({ userId, role: "MEMBER" as const })),
          ],
        },
      },
      include: {
        members: { include: { user: { select: userCard } } },
      },
    });
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        type: "SYSTEM",
        body: `${creator.name} created the group`,
      },
    });
    return conversation;
  });
}

/**
 * Membership guard for every conversation-scoped route.
 * 404 (not 403) so non-members can't probe conversation existence.
 */
export async function requireMembership(conversationId: string, userId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    include: { conversation: true },
  });
  if (!member) throw ApiError.notFound("Conversation not found");
  return member;
}

/**
 * Inbox projection — everything the list UI needs in one round-trip:
 * conversations (sorted by lastMessageAt), members, last-message preview,
 * unread counts (single raw SQL join against per-member `lastReadAt`
 * watermarks) and presence of the other members (Redis MGET on the presence
 * TTL keys; Phase 5 owns writing those keys).
 */
export async function getInbox(userId: string) {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    orderBy: { conversation: { lastMessageAt: "desc" } },
    include: {
      conversation: {
        include: {
          members: {
            include: { user: { select: userCard } },
          },
          messages: {
            where: { deletedAt: null },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 1,
            include: { sender: { select: userCard } },
          },
        },
      },
    },
  });

  const conversationIds = memberships.map((m) => m.conversationId);

  // Unread per conversation: messages newer than MY watermark, not mine,
  // not soft-deleted. One grouped query instead of one COUNT per row (N+1).
  const unreadRows = conversationIds.length
    ? await prisma.$queryRaw<{ conversationId: string; count: number }[]>`
        SELECT m."conversationId" AS "conversationId", COUNT(*)::int AS count
        FROM "Message" m
        JOIN "ConversationMember" cm
          ON cm."conversationId" = m."conversationId" AND cm."userId" = ${userId}
        WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
          AND m."createdAt" > cm."lastReadAt"
          AND m."deletedAt" IS NULL
          AND (m."senderId" IS NULL OR m."senderId" <> ${userId})
        GROUP BY m."conversationId"`
    : [];
  const unreadByConversation = new Map(
    unreadRows.map((r) => [r.conversationId, r.count])
  );

  // Presence of every other member across all my conversations (deduped).
  const otherUserIds = [
    ...new Set(
      memberships.flatMap((m) =>
        m.conversation.members
          .map((mem) => mem.userId)
          .filter((id) => id !== userId)
      )
    ),
  ];
  const presence = await getPresenceMap(otherUserIds);

  return memberships.map((m) => ({
    id: m.conversation.id,
    type: m.conversation.type,
    name: m.conversation.name,
    avatarKey: m.conversation.avatarKey,
    createdById: m.conversation.createdById,
    lastMessageAt: m.conversation.lastMessageAt,
    myRole: m.role,
    myLastReadAt: m.lastReadAt,
    isMuted: m.isMuted,
    unread: unreadByConversation.get(m.conversation.id) ?? 0,
    members: m.conversation.members.map((mem) => ({
      id: mem.userId,
      role: mem.role,
      lastReadAt: mem.lastReadAt,
      isMuted: mem.isMuted,
      user: {
        id: mem.user.id,
        name: mem.user.name,
        image: mem.user.image,
        bio: mem.user.bio,
      },
      online: presence[mem.user.id] === "online",
    })),
    lastMessage: m.conversation.messages[0]
      ? {
          id: m.conversation.messages[0].id,
          type: m.conversation.messages[0].type,
          body: m.conversation.messages[0].body,
          senderId: m.conversation.messages[0].senderId,
          createdAt: m.conversation.messages[0].createdAt,
          senderName: m.conversation.messages[0].sender?.name ?? null,
        }
      : null,
  }));
}

/**
 * Bulk presence read of the `presence:{userId}` TTL keys (written by the WS
 * server in Phase 5). Best-effort: if Redis is down everyone reads offline
 * and the UI self-heals on the next presence event.
 */
export async function getPresenceMap(
  userIds: string[]
): Promise<Record<string, "online" | "offline">> {
  const result: Record<string, "online" | "offline"> = {};
  if (userIds.length === 0) return result;
  try {
    if (redis.status !== "ready") await redis.connect().catch(() => {});
    const values = await redis.mget(...userIds.map((id) => `presence:${id}`));
    userIds.forEach((id, i) => {
      result[id] = values[i] === "1" ? "online" : "offline";
    });
    return result;
  } catch (err) {
    console.error("[presence] redis unavailable:", err);
    for (const id of userIds) result[id] = "offline";
    return result;
  }
}


