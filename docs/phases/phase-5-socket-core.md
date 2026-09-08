# Phase 5 — Socket Server Core

## Goals
1. Socket.IO server with the Redis adapter — the horizontal-scale backbone
2. Authenticated handshake (JWE), per-user/per-conversation rooms from the DB
3. Presence: TTL keys, heartbeats, multi-tab tracking, mutual-only broadcast

## Steps

### 5.1 Bootstrap with the adapter
`ws/src/index.ts`:
```ts
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";

const pub = new Redis(process.env.REDIS_URL!);
const sub = pub.duplicate();
io.adapter(createAdapter(pub, sub));   // every io.to(room) now fans out to ALL instances
```
- `WS_PORT` from env; integration tests boot a **second** instance on 4002 with the same Redis.
- Health endpoint (Phase 1) extended: `{ ok, sockets: io.engine.clientsCount }`.

### 5.2 Handshake auth (Phase 3 middleware) + typed errors
- `io.use(authMiddleware)` — sets `socket.data.userId`; rejects with `UNAUTHENTICATED`.
- `socket.data = { userId, joinedConversationIds: Set<string> }`.
- Shared `emitError(socket, code, scope?)` → `SERVER_EVENTS.ERROR`.

### 5.3 Room join from the database
`ws/src/rooms.ts`:
```ts
export async function joinUserRooms(io: Server, socket: Socket) {
  const userId = socket.data.userId;
  socket.join(`user:${userId}`);
  const memberships = await prisma.conversationMember.findMany({
    where: { userId }, select: { conversationId: true },
  });
  for (const m of memberships) socket.join(`conversation:${m.conversationId}`);
  socket.data.joinedConversationIds = memberships.map((m) => m.conversationId);
}
```
> Rooms are a **routing cache**, not an authorization check. Every state-changing handler re-verifies membership in Postgres — being kicked must take effect without waiting for a reconnect. (Phase 6 tests this.)

### 5.4 Presence service
`ws/src/presence.ts`:
```ts
const HEARTBEAT_S = 30, PRESENCE_TTL_S = 70;

export async function onSocketConnected(io, socket, redis) {
  const userId = socket.data.userId;
  const added = await redis.sadd(`sockets:${userId}`, socket.id);
  await redis.set(`presence:${userId}`, "1", "EX", PRESENCE_TTL_S);
  if (added === 1) {                       // first tab/device
    await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
    await broadcastPresence(io, userId, "online");       // to mutual members only
  }
}

export async function onSocketDisconnected(io, socket, redis) {
  const userId = socket.data.userId;
  const remaining = await redis.srem(`sockets:${userId}`, socket.id);
  await emitTypingStopToAllRooms(socket);                  // no ghost typers
  if (remaining === 0) {                                   // last tab closed
    await redis.del(`presence:${userId}`);
    const lastSeenAt = new Date();
    await prisma.user.update({ where: { id: userId }, data: { lastSeenAt } });
    await broadcastPresence(io, userId, "offline", lastSeenAt);
  }
}
```
- Heartbeat: one `setInterval` per server (not per socket) refreshes TTL for all connected users (`pipeline SET … EX 70`).
- `broadcastPresence` resolves **mutuals** = distinct members of my conversations, minus me → `io.to("user:{mutualId}").emit(PRESENCE_UPDATE, …)`; cache the mutual set on `socket.data` (invalidate: recompute on `MEMBER_JOINED`).
- Presence reads for the inbox: `redis.mget(visibleUserIds.map(id => `presence:${id}`))` in `GET /api/conversations` (web needs an ioredis client too — `REDIS_URL` already shared).

## Verify (Definition of Done)
- [ ] Two browser tabs signed in as different users: presence dot flips online/offline on tab close; **only** users sharing a conversation see the event (log assertion)
- [ ] `docker compose down redis && up -d` mid-session → within 70 s the heartbeat key expires; on ws restart users re-appear online (TTL self-heal, no zombie presence)
- [ ] Multi-tab: open 2 tabs as alice, close one → alice still online; close both → offline + `lastSeenAt` persisted
- [ ] Integration smoke test (`ws/test/presence.test.ts`): two clients, connect/disconnect, assert exactly one `PRESENCE_UPDATE` pair with correct `status`/`lastSeenAt`
