import type { Server } from "socket.io";
import type { Prisma } from "@prisma/client";
import {
  C2S,
  S2C,
  messageSendPayloadSchema,
  type ChatMessage,
  type ChatUser,
  type MessageSendAck,
  type MessageType,
} from "@chat/shared";
import type { Redis } from "ioredis";
import { prisma } from "../lib/prisma.js";
import { conversationRoom, userRoom } from "../rooms.js";
import { checkSendRateLimit } from "../rateLimit.js";
import { validateAttachment } from "../lib/attachment.js";
import { ackError } from "../errors.js";
import type { ChatSocket } from "../auth.js";

/**
 * message:send — the full send pipeline (PLAN §request flow):
 *
 *   zod validate → membership re-check in Postgres (rooms are a routing
 *   cache, never an auth check) → Redis rate limit (30/10 s) → Prisma insert
 *   (unique clientId dedupes a reconnect double-send) → lastMessageAt bump →
 *   HINCRBY unread:{member} pipeline → message:new to the conversation room
 *   (relayed to ALL instances by the Redis adapter) → unread:update to every
 *   other member's user:{id} room → ack with the persisted message.
 */

// Same wire shape as GET /api/conversations/[id]/messages — one serialization
// for history, live fan-out and the ack.
const userCardSelect = {
  id: true,
  name: true,
  image: true,
  bio: true,
  lastSeenAt: true,
} satisfies Prisma.UserSelect;

const messageInclude = {
  sender: { select: userCardSelect },
  replyTo: { include: { sender: { select: userCardSelect } } },
} as const;

type MessageWithRelations = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

function serializeUser(u: {
  id: string;
  name: string;
  image: string | null;
  bio: string | null;
  lastSeenAt: Date;
}): ChatUser {
  return { ...u, lastSeenAt: u.lastSeenAt.toISOString() };
}

/** Prisma row → wire shape (Dates → ISO strings), shared by ack + fan-out. */
function serializeMessage(m: MessageWithRelations): ChatMessage {
  const replyTo = m.replyTo
    ? {
        id: m.replyTo.id,
        type: m.replyTo.type as MessageType,
        body: m.replyTo.body,
        senderId: m.replyTo.senderId,
        sender: m.replyTo.sender ? serializeUser(m.replyTo.sender) : null,
      }
    : null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    type: m.type as MessageType,
    body: m.body,
    attachmentKey: m.attachmentKey,
    attachmentName: m.attachmentName,
    attachmentSize: m.attachmentSize,
    attachmentMime: m.attachmentMime,
    attachmentWidth: m.attachmentWidth,
    attachmentHeight: m.attachmentHeight,
    clientId: m.clientId,
    replyToId: m.replyToId,
    replyTo,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    sender: m.sender ? serializeUser(m.sender) : null,
  };
}

/** Prisma P2002 (unique violation) — the clientId dedupe path. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

export function registerMessageHandler(io: Server, socket: ChatSocket, redis: Redis) {
  socket.on(C2S.MESSAGE_SEND, async (raw: unknown, ack?: (res: MessageSendAck) => void) => {
    const reply = (res: MessageSendAck) => ack?.(res);
    const userId = socket.data.userId;

    // 1. Validate — shared zod schema, same file the client validated with.
    const parsed = messageSendPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return reply(ackError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid payload"));
    }
    const { conversationId, clientId, type, body, attachment, replyToId } = parsed.data;

    // 1b. Attachment defense in depth — mime allowlist + key ownership.
    //     The REST upload route already sniffed magic bytes; here we reject
    //     keys the sender never uploaded (a socket payload is not evidence).
    if (attachment) {
      const check = validateAttachment({ type, mime: attachment.mime, key: attachment.key, userId });
      if (!check.ok) {
        return reply(ackError("VALIDATION", check.reason));
      }
    }

    // 2. Membership — re-verified in Postgres on EVERY send; being kicked
    //    (or removed after connect) takes effect immediately.
    const membership = await prisma.conversationMember
      .findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { id: true },
      })
      .catch(() => null);
    if (!membership) {
      // 404, not 403 — non-members can't probe conversation existence
      // (same semantics as the REST guards).
      return reply(ackError("NOT_FOUND", "Conversation not found"));
    }

    // 3. Rate limit — Redis fixed window, 30 messages / 10 s per user.
    if (!(await checkSendRateLimit(redis, userId))) {
      return reply(ackError("RATE_LIMITED", "Sending too fast — slow down"));
    }

    // 4. Reply target must live in the same conversation.
    if (replyToId) {
      const parent = await prisma.message
        .findFirst({ where: { id: replyToId, conversationId }, select: { id: true } })
        .catch(() => null);
      if (!parent) {
        return reply(ackError("VALIDATION", "Reply target not found in this conversation"));
      }
    }

    // 5. Persist. The unique clientId makes the server the dedupe authority:
    //    a reconnect double-send loses the insert race (P2002) and gets the
    //    original row back instead of a duplicate.
    let message: MessageWithRelations;
    try {
      message = await prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId,
            senderId: userId,
            type,
            body: body ?? null,
            attachmentKey: attachment?.key ?? null,
            attachmentName: attachment?.name ?? null,
            attachmentSize: attachment?.size ?? null,
            attachmentMime: attachment?.mime ?? null,
            attachmentWidth: attachment?.width ?? null,
            attachmentHeight: attachment?.height ?? null,
            clientId,
            replyToId: replyToId ?? null,
          },
          include: messageInclude,
        });
        // Denormalized sort key for the inbox — one UPDATE, not a MAX() scan.
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: created.createdAt },
        });
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err) && clientId) {
        const existing = await prisma.message
          .findUnique({ where: { clientId }, include: messageInclude })
          .catch(() => null);
        if (existing) {
          return reply({ ok: true, message: serializeMessage(existing) });
        }
      }
      console.error(`[message] send failed for ${userId}:`, err);
      return reply(ackError("INTERNAL", "Could not send message"));
    }

    const wireMessage = serializeMessage(message);

    // 6. Fan out to the conversation room — the Redis adapter relays this to
    //    ALL instances, so members on other servers receive it live.
    io.to(conversationRoom(conversationId)).emit(S2C.MESSAGE_NEW, { message: wireMessage });

    // 7. Unread badges: bump the hot counter for every OTHER member and push
    //    their fresh count to every device (user:{id} room). One pipeline:
    //    HINCRBY each member, then HGET the post-increment values.
    const others = await prisma.conversationMember
      .findMany({
        where: { conversationId, NOT: { userId } },
        select: { userId: true },
      })
      .catch(() => [] as { userId: string }[]);

    if (others.length > 0) {
      const pipeline = redis.pipeline();
      for (const o of others) pipeline.hincrby(`unread:${o.userId}`, conversationId, 1);
      for (const o of others) pipeline.hget(`unread:${o.userId}`, conversationId);
      const results = await pipeline.exec().catch(() => null);
      if (results) {
        others.forEach((o, i) => {
          const raw2 = results[others.length + i]?.[1];
          const count = raw2 === null || raw2 === undefined ? 0 : Number(raw2);
          io.to(userRoom(o.userId)).emit(S2C.UNREAD_UPDATE, { conversationId, count });
        });
      }
    }

    // 8. Ack the sender — the client swaps its optimistic bubble for this row.
    return reply({ ok: true, message: wireMessage });
  });
}