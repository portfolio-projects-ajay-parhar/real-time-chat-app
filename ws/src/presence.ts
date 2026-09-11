import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import { S2C } from "@chat/shared";
import { prisma } from "./lib/prisma.js";
import { getMutualUserIds, userRoom } from "./rooms.js";
import type { ChatSocket } from "./auth.js";

/**
 * Presence = Redis TTL keys + heartbeats.
 *
 * - `presence:{userId}` string "1", TTL 70 s — the online signal. If a server
 *   dies, its heartbeats stop, keys expire, users auto-offline with zero
 *   cleanup code (self-healing by design).
 * - `sockets:{userId}` SET of socket ids — multi-tab/device tracking. The
 *   offline transition fires only when the LAST socket goes away.
 *
 * Deliberately NOT here: typing state (broadcast-only, see PLAN §Redis design).
 */

export const PRESENCE_TTL_S = 70;
export const HEARTBEAT_INTERVAL_MS = 30_000;

const presenceKey = (userId: string) => `presence:${userId}`;
const socketsKey = (userId: string) => `sockets:${userId}`;

// First/last-socket detection must be ATOMIC with respect to the set
// membership change: SADD returns "1 whenever the member was newly added"
// (i.e. for every new tab), not "1 for the first socket". Two instances
// racing on connect/disconnect must also agree on exactly one transition.
//
// The same script self-heals after a server crash: if the presence TTL key
// is GONE, no live socket for this user exists anywhere in the cluster
// (heartbeats stopped, key expired) — so any leftover entries in the
// sockets set are garbage from sockets whose disconnect was never processed
// (hard kill). They would otherwise suppress the online broadcast forever.
const CONNECT_LUA = `
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[1])
end
redis.call('SADD', KEYS[1], ARGV[1])
local cardinality = redis.call('SCARD', KEYS[1])
redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
return cardinality
`;

const SREM_SCARD_LUA = `
local removed = redis.call('SREM', KEYS[1], ARGV[1])
if removed == 0 then return -1 end
return redis.call('SCARD', KEYS[1])
`;

interface PresenceUpdatePayload {
  userId: string;
  status: "online" | "offline";
  lastSeenAt?: string;
}

/** Broadcast a presence transition to mutual-conversation members only. */
async function broadcastPresence(
  io: Server,
  userId: string,
  status: "online" | "offline",
  lastSeenAt?: Date
): Promise<void> {
  const mutuals = await getMutualUserIds(userId);
  if (mutuals.length === 0) return;
  const payload: PresenceUpdatePayload = {
    userId,
    status,
    ...(lastSeenAt ? { lastSeenAt: lastSeenAt.toISOString() } : {}),
  };
  for (const mutualId of mutuals) {
    io.to(userRoom(mutualId)).emit(S2C.PRESENCE_UPDATE, payload);
  }
}

/** Track a newly connected socket; first socket for the user → online broadcast. */
export async function onSocketConnected(
  io: Server,
  socket: ChatSocket,
  redis: Redis
): Promise<void> {
  const userId = socket.data.userId;

  // Atomic connect: stale-set cleanup (see script comment) + SADD + SET EX.
  // Returns the new set cardinality. 1 → this socket is the user's first
  // live socket (any tab/device, on any instance).
  const cardinality = Number(
    await redis.eval(CONNECT_LUA, 2, socketsKey(userId), presenceKey(userId), socket.id, PRESENCE_TTL_S)
  );

  if (cardinality === 1) {
    // Came online: stamp lastSeenAt on the way (offline writes a sharper one).
    const lastSeenAt = new Date();
    await prisma.user
      .update({ where: { id: userId }, data: { lastSeenAt } })
      .catch((err) => console.error(`[presence] lastSeenAt update failed for ${userId}:`, err));
    await broadcastPresence(io, userId, "online");
  }
}

/**
 * Un-track a disconnecting socket; last socket for the user → offline.
 *
 * Atomic SREM + SCARD via Lua: returns -1 when the socket id wasn't tracked
 * (e.g. after a Redis flush — no transition), otherwise the remaining socket
 * count. 0 → this was the LAST socket (any tab/device, on any instance).
 */
export async function onSocketDisconnected(
  io: Server,
  socket: ChatSocket,
  redis: Redis
): Promise<void> {
  const userId = socket.data.userId;
  if (!userId) return;

  const remaining = Number(await redis.eval(SREM_SCARD_LUA, 1, socketsKey(userId), socket.id));
  if (remaining !== 0) return;

  // (The implicit typing:stop broadcast happens in app.ts via
  // clearTypingOnDisconnect — kept out of presence so this module stays
  // single-purpose.)

  await redis.del(presenceKey(userId));
  const lastSeenAt = new Date();
  await prisma.user
    .update({ where: { id: userId }, data: { lastSeenAt } })
    .catch((err) => console.error(`[presence] lastSeenAt update failed for ${userId}:`, err));
  await broadcastPresence(io, userId, "offline", lastSeenAt);
}

/**
 * ONE interval per server (not per socket): refresh the presence TTL of every
 * user with a live socket on this instance. Cross-instance safety: any
 * instance refreshing the shared key is equivalent — heartbeats keep the user
 * online as long as at least one socket exists somewhere in the cluster.
 * Returns the timer so `close()` can clear it.
 */
export function startHeartbeat(io: Server, redis: Redis): NodeJS.Timeout {
  return setInterval(() => {
    const userIds = new Set<string>();
    for (const socket of io.of("/").sockets.values()) {
      if (socket.data.userId) userIds.add(socket.data.userId);
    }
    if (userIds.size === 0) return;

    const pipeline = redis.pipeline();
    for (const userId of userIds) {
      pipeline.set(presenceKey(userId), "1", "EX", PRESENCE_TTL_S);
    }
    pipeline.exec().catch((err) => console.error("[presence] heartbeat failed:", err));
  }, HEARTBEAT_INTERVAL_MS);
}
