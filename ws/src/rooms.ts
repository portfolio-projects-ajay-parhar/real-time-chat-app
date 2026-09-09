import { prisma } from "./lib/prisma.js";
import type { ChatSocket } from "./auth.js";

export const userRoom = (userId: string) => `user:${userId}`;
export const conversationRoom = (id: string) => `conversation:${id}`;

/**
 * Join the socket's personal room + one room per conversation membership.
 *
 * Rooms are a routing cache, NOT an authorization check: every state-changing
 * handler re-verifies membership in Postgres, so being kicked takes effect
 * without waiting for a reconnect. A conversation created after this socket
 * connected is picked up on the next (re)connect — the REST create response
 * triggers the client to reconnect/refetch (documented trade-off, see PLAN §Socket).
 */
export async function joinUserRooms(socket: ChatSocket): Promise<void> {
  const userId = socket.data.userId;
  socket.join(userRoom(userId));

  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    select: { conversationId: true },
  });
  for (const m of memberships) {
    socket.join(conversationRoom(m.conversationId));
  }
  socket.data.joinedConversationIds = memberships.map((m) => m.conversationId);
}

/**
 * Users who share at least one conversation with `userId`, minus themselves.
 * Presence is broadcast ONLY to these mutuals — a busy instance must not
 * emit a global event per connect (PLAN §presence privacy).
 */
export async function getMutualUserIds(userId: string): Promise<string[]> {
  const rows = await prisma.conversationMember.findMany({
    where: {
      conversation: { members: { some: { userId } } },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  return rows.map((r) => r.userId).filter((id) => id !== userId);
}
