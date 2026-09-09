import type { Server } from "socket.io";
import { C2S, S2C, typingPayloadSchema, type TypingUpdateEvent } from "@chat/shared";
import { prisma } from "../lib/prisma.js";
import { conversationRoom } from "../rooms.js";
import type { ChatSocket } from "../auth.js";

/**
 * Typing indicators — the deliberate broadcast-only design (PLAN §Redis):
 * NOTHING is persisted anywhere, not even Redis. Each server keeps an
 * in-memory per-instance registry; each client holds its own map and evicts
 * users after 4 s without a refresh. Ephemeral data that no code path ever
 * queries doesn't earn a key.
 *
 * Cross-instance note: the registry is instance-local, so the recomputed
 * `userIds` set reflects typers known to the *emitting* instance (relayed to
 * all instances via the Redis adapter). Clients therefore MERGE incoming sets
 * (add/refresh each listed user) instead of replacing — removal happens by
 * the client's own 4 s timeout. Worst case after an abrupt disconnect is a
 * ≤4 s ghost typer, which beats shared-state machinery for UX frosting.
 */

/** Client eviction window — keep in sync with web/src/lib/typing-store.ts. */
export const TYPING_TTL_MS = 4_000;
/** Server-side broadcast throttle: at most one typing:update per user+conv. */
export const TYPING_BROADCAST_THROTTLE_MS = 2_000;

/**
 * Fixed-window throttle — pure enough to unit-test with injected `now`.
 * Returns true (and stamps the key) on the first call inside a window and
 * once per subsequent window; false in between.
 */
export function createThrottle(windowMs: number) {
  const lastFired = new Map<string, number>();
  return function fire(key: string, now: number = Date.now()): boolean {
    const prev = lastFired.get(key);
    if (prev !== undefined && now - prev < windowMs) return false;
    lastFired.set(key, now);
    return true;
  };
}

/**
 * Instance-local typing registry: conversationId → Map<userId, cleanup timer>.
 * The timer is memory hygiene only (a crashed client that never sends
 * typing:stop must not leak an entry); the client's own timeout is what
 * actually clears the indicator.
 */
export function createTypingRegistry() {
  const typers = new Map<string, Map<string, NodeJS.Timeout>>();

  function getMap(conversationId: string) {
    let m = typers.get(conversationId);
    if (!m) {
      m = new Map();
      typers.set(conversationId, m);
    }
    return m;
  }

  /** Mark a user as typing; true if this is a NEW entry (not a refresh). */
  function start(conversationId: string, userId: string): boolean {
    const m = getMap(conversationId);
    const isNew = !m.has(userId);
    const prev = m.get(userId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => stop(conversationId, userId), TYPING_TTL_MS);
    timer.unref?.();
    m.set(userId, timer);
    return isNew;
  }

  /** Clear a user's typing state; true if they were actually typing. */
  function stop(conversationId: string, userId: string): boolean {
    const m = typers.get(conversationId);
    const timer = m?.get(userId);
    if (!m || !timer) return false;
    clearTimeout(timer);
    m.delete(userId);
    if (m.size === 0) typers.delete(conversationId);
    return true;
  }

  /** Snapshot of typers known to this instance for a conversation. */
  function getUserIds(conversationId: string): string[] {
    return [...(typers.get(conversationId)?.keys() ?? [])];
  }

  /** Drop every entry for a user (multi-tab disconnect); affected conv ids. */
  function clearUser(userId: string): string[] {
    const affected: string[] = [];
    for (const [conversationId, m] of typers) {
      if (m.has(userId)) {
        stop(conversationId, userId);
        affected.push(conversationId);
      }
    }
    return affected;
  }

  return { start, stop, getUserIds, clearUser };
}

export type TypingRegistry = ReturnType<typeof createTypingRegistry>;

function broadcastTyping(io: Server, conversationId: string, userIds: string[]) {
  const payload: TypingUpdateEvent = { conversationId, userIds };
  io.to(conversationRoom(conversationId)).emit(S2C.TYPING_UPDATE, payload);
}

/**
 * Wire typing:start / typing:stop for one socket. Membership is re-checked
 * in Postgres on every *broadcast* (bounded to 1/2s by the throttle, so a
 * keystroke storm can't hammer the DB) — a kicked member's stale room
 * doesn't earn them a typing indicator.
 */
export function registerTypingHandlers(
  io: Server,
  socket: ChatSocket,
  registry: TypingRegistry
) {
  const throttle = createThrottle(TYPING_BROADCAST_THROTTLE_MS);

  socket.on(C2S.TYPING_START, async (raw: unknown) => {
    const parsed = typingPayloadSchema.safeParse(raw);
    if (!parsed.success) return; // typing is best-effort; invalid payloads are dropped
    const { conversationId } = parsed.data;
    const userId = socket.data.userId;

    if (!throttle(`${userId}:${conversationId}`)) return;

    const member = await prisma.conversationMember
      .findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { id: true },
      })
      .catch((err) => {
        console.error("[typing] membership check failed:", err);
        return null;
      });
    if (!member) return;

    registry.start(conversationId, userId);
    broadcastTyping(io, conversationId, registry.getUserIds(conversationId));
  });

  socket.on(C2S.TYPING_STOP, (raw: unknown) => {
    const parsed = typingPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    const { conversationId } = parsed.data;
    const userId = socket.data.userId;

    // Only broadcast if this instance actually had them typing — a
    // state-clearing event needs no DB hit and can't leak room membership.
    if (!registry.stop(conversationId, userId)) return;
    broadcastTyping(io, conversationId, registry.getUserIds(conversationId));
  });
}

/**
 * Implicit typing:stop on disconnect (called from app.ts next to the presence
 * offline transition) — no ghost typers after a dropped connection.
 * Multi-tab caveat: another tab of the same user that is still typing is
 * dropped too and re-broadcasts within its next throttled keystroke — a ≤2s
 * indicator gap, acceptable to keep this function stateless.
 */
export function clearTypingOnDisconnect(
  io: Server,
  registry: TypingRegistry,
  userId: string
) {
  for (const conversationId of registry.clearUser(userId)) {
    broadcastTyping(io, conversationId, registry.getUserIds(conversationId));
  }
}