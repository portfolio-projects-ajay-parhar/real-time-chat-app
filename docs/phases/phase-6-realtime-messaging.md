# Phase 6 — Real-Time Messaging

## Goals
1. The `message:send` pipeline: validate → authorize → rate-limit → persist → fan-out → unread push → ack
2. Typing indicators (broadcast-only)
3. Client: singleton socket, event-driven cache, optimistic sends

## Steps

### 6.1 The send pipeline (`ws/src/handlers/message.ts`)
```ts
socket.on(CLIENT_EVENTS.MESSAGE_SEND, async (payload, ack) => {
  const parsed = MessageSendSchema.safeParse(payload);          // shared zod contract
  if (!parsed.success) return ackError(ack, "VALIDATION");

  const { conversationId, clientId } = parsed.data;
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: socket.data.userId } },
  });
  if (!membership) return ackError(ack, "FORBIDDEN");           // DB re-check, not room trust

  const allowed = await rateLimit(redis, `ratelimit:${socket.data.userId}:msg`, 30, 10);
  if (!allowed) return ackError(ack, "RATE_LIMITED");

  const message = await persistMessage(parsed.data, socket.data.userId); // INSERT + clientId dedupe + lastMessageAt bump
  await bumpUnread(redis, conversationId, socket.data.userId);  // HINCRBY pipeline for other members

  const dto = await toMessageDto(message);                      // sender + replyTo preloaded
  io.to(`conversation:${conversationId}`).emit(SERVER_EVENTS.MESSAGE_NEW, { message: dto });
  for (const memberId of await otherMemberIds(conversationId, socket.data.userId)) {
    io.to(`user:${memberId}`).emit(SERVER_EVENTS.UNREAD_UPDATE, { conversationId, count: await unreadCount(redis, memberId, conversationId) });
  }
  ack({ ok: true, message: dto });
});
```
- `persistMessage`: `prisma.message.create` inside a transaction that bumps `conversation.lastMessageAt`; on `P2002` (unique `clientId`) → fetch + ack the **existing** row (idempotent resend).
- Attachment messages: `attachment.key` was already uploaded via `POST /api/media` (client does media first, then sends the key) — server re-validates mime against allowlist.
- SYSTEM messages (joins/leaves/renames) go through the same pipeline with `senderId: null`.

### 6.2 Rate limiter (`ws/src/rateLimit.ts`)
```ts
export async function rateLimit(redis: Redis, key: string, limit: number, windowS: number) {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowS);
  return n <= limit;                       // fixed window: simple + honest for chat sends
}
```

### 6.3 Typing (`ws/src/handlers/typing.ts`)
- `typing:start` → throttle map `Map<"${userId}:${conversationId}", ts>` (1 broadcast / 2 s) → recompute typing set for the conversation → `TYPING_UPDATE { conversationId, userIds }` to the room.
- `typing:stop` / disconnect → drop from set + broadcast. Clients also evict after 4 s (belt and braces).

### 6.4 Client socket layer (web)
- `src/lib/socket-client.ts` — singleton; `io({ path: "/socket.io", transports: ["websocket"], auth: { token } })` (token fetched once from `/api/ws-token` as fallback); returns typed socket (`@chat/shared` event map).
- `src/hooks/useSocket.ts` — connect when session exists, `disconnect()` on sign-out; `connectionState` exposed for a banner.
- `src/hooks/useChatEvents.ts` — mounted once in `(app)/layout.tsx`:
```ts
socket.on(SERVER_EVENTS.MESSAGE_NEW, ({ message }) => {
  queryClient.setQueryData(messageKeys.list(message.conversationId), (old) => appendDedupe(old, message));
  queryClient.setQueryData(inboxKeys.all, (old) => patchPreview(old, message)); // reorder + preview
});
socket.on(SERVER_EVENTS.UNREAD_UPDATE, ({ conversationId, count }) => patchInboxBadge(conversationId, count));
socket.on("connect", () => {  // reconnect → backfill the gap
  const active = useActiveConversation();
  if (active) queryClient.fetchQuery(messageKeys.backfill(active, lastSeenAt));
  queryClient.invalidateQueries({ queryKey: inboxKeys.all });
});
```

### 6.5 Optimistic composer
- Generate `clientId = crypto.randomUUID()` → append bubble `{ status: "pending" }` → `socket.emit(MESSAGE_SEND, payload, ack)` → ack `ok` swaps pending → dto; `ok: false` marks bubble `failed` + retry affordance + toast (`RATE_LIMITED` → "You're sending too fast").

## Verify (Definition of Done)
- [ ] **Two windows, two users**: send in A → appears in B instantly; inbox of B reorders with preview + badge
- [ ] Kill ws (`pkill -f tsx`) → UI shows reconnecting banner; restart ws → message sent during outage appears via backfill; no duplicates (clientId)
- [ ] Rapid-fire 31 sends → ack 31 = `RATE_LIMITED` (test asserts via client acks)
- [ ] `clientId` resend (emit twice, same id) → one DB row, both acks return the same message id
- [ ] Typing dots show in B while A types; disappear ≤ 4 s after A stops (even if ws dies mid-typing)
