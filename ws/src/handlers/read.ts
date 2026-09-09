import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import {
  C2S,
  S2C,
  conversationReadPayloadSchema,
  type ConversationReadAck,
  type ReceiptUpdateEvent,
  type UnreadUpdateEvent,
} from "@chat/shared";
import { prisma } from "../lib/prisma.js";
import { conversationRoom, userRoom } from "../rooms.js";
import { ackError } from "../errors.js";
import type { ChatSocket } from "../auth.js";

/**
 * conversation:read — the read-receipt pipeline (PLAN §socket events):
 *
 *   zod validate → membership re-check in Postgres (rooms are a routing
 *   cache, never an auth check) → advance the member's `lastReadAt`
 *   watermark → HDEL unread:{userId} (the hot badge counter) → receipt:update
 *   to the conversation room (adapter relays to ALL instances — drives the
 *   ✓✓ ticks / "Seen by N") → unread:update {count: 0} to the READER's
 *   user:{id} room so every device of theirs clears the badge → ack.
 *
 * Non-members get NOT_FOUND (404-not-403, same as REST and message:send —
 * existence probing stays impossible).
 */
export function registerReadHandler(io: Server, socket: ChatSocket, redis: Redis) {
  socket.on(
    C2S.CONVERSATION_READ,
    async (raw: unknown, ack?: (res: ConversationReadAck) => void) => {
      const reply = (res: ConversationReadAck) => ack?.(res);
      const userId = socket.data.userId;

      const parsed = conversationReadPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return reply(ackError("VALIDATION", "Invalid conversation:read payload"));
      }
      const { conversationId } = parsed.data;

      const member = await prisma.conversationMember
        .findUnique({
          where: { conversationId_userId: { conversationId, userId } },
          select: { id: true },
        })
        .catch((err) => {
          console.error("[read] membership check failed:", err);
          return null;
        });
      if (!member) {
        return reply(ackError("NOT_FOUND", "Conversation not found"));
      }

      // Advance the watermark. Timestamps only move forward, so a redundant
      // read is an idempotent no-op for the receipt math.
      const lastReadAt = new Date();
      try {
        await prisma.conversationMember.update({
          where: { conversationId_userId: { conversationId, userId } },
          data: { lastReadAt },
          select: { lastReadAt: true },
        });
      } catch (err) {
        console.error(`[read] watermark update failed for ${userId}:`, err);
        return reply(ackError("INTERNAL", "Could not mark conversation read"));
      }

      // Clear the hot unread counter — REST re-derives from Postgres anyway,
      // so a missed HDEL self-heals on the next inbox fetch.
      await redis.hdel(`unread:${userId}`, conversationId).catch((err) =>
        console.error("[read] unread HDEL failed:", err)
      );

      const lastReadAtIso = lastReadAt.toISOString();
      io.to(conversationRoom(conversationId)).emit(S2C.RECEIPT_UPDATE, {
        conversationId,
        userId,
        lastReadAt: lastReadAtIso,
      } satisfies ReceiptUpdateEvent);
      // Badge authority for the reader's OTHER devices/tabs (this device gets
      // it too — the inbox patch is idempotent).
      io.to(userRoom(userId)).emit(S2C.UNREAD_UPDATE, {
        conversationId,
        count: 0,
      } satisfies UnreadUpdateEvent);

      return reply({ ok: true, lastReadAt: lastReadAtIso });
    }
  );
}