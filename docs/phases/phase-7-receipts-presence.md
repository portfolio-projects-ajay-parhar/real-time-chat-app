# Phase 7 — Read Receipts & Presence UX

## Goals
1. `conversation:read` handler — watermark update, Redis unread clear, receipt broadcast
2. UI: ticks (pending → sent → read), presence dots, "Seen by N" in groups, live unread badges + title count

## Steps

### 7.1 Read handler (`ws/src/handlers/read.ts`)
```ts
socket.on(CLIENT_EVENTS.CONVERSATION_READ, async ({ conversationId }, ack) => {
  if (!(await isMember(socket.data.userId, conversationId))) return ackError(ack, "FORBIDDEN");
  const lastReadAt = new Date();
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId: socket.data.userId } },
    data: { lastReadAt },
  });
  await redis.hdel(`unread:${socket.data.userId}`, conversationId);
  io.to(`conversation:${conversationId}`).emit(SERVER_EVENTS.RECEIPT_UPDATE, {
    conversationId, userId: socket.data.userId, lastReadAt: lastReadAt.toISOString(),
  });
  ack({ ok: true, lastReadAt });
});
```
- Client triggers on: conversation open, window focus while open, new `MESSAGE_NEW` while conversation is active + scrolled to bottom (debounced 500 ms).

### 7.2 Ticks on `MessageBubble` (own messages)
```text
status = pending (clientId not yet acked)  → 🕐
       → sent    (persisted, no watermark coverage)  → ✓
       → read    (∃ member.lastReadAt ≥ message.createdAt, excluding self; DIRECT: other member; GROUP: "Seen by N")
```
- Data source: conversation detail / inbox already ships member `lastReadAt`; `RECEIPT_UPDATE` patches it live.
- GROUP variant: under the newest own message render `Seen by {n}/{m-1}` + avatar stack; individual ticks stay DIRECT-only (documented).

### 7.3 Presence UX
- `PresenceDot` (green ring online / gray offline) on inbox rows + chat header.
- Header subtitle: "online" | "last seen {date-fns humanize} < 1 week" | "offline" (GROUP: member count + N online).
- `PRESENCE_UPDATE` patches the client presence map (Zustand-lite context store) — inbox + header subscribe.

### 7.4 Unread badges + title
- Inbox `ConversationItem` badge ← `unread:update` → `HDEL`-driven `UNREAD_UPDATE` for self.
- `useDocumentTitleBadge(totalUnread)` — `(n) Chat`; clears when totals hit zero; recomputed from inbox cache, never from DOM counts.
- `isMuted` conversation: badge renders as dot without count; no browser notification (Phase 9).

## Verify (Definition of Done)
- [ ] A sends → B's badge `+1`; B opens conversation → A's bubble flips ✓→✓✓ live; B's badge clears
- [ ] GROUP: C also reads → A sees "Seen by 2/3" update live
- [ ] B reads from a second device → receipt still broadcast (user room fan-out), both B devices' badges clear
- [ ] Unit tests: watermark math table — `createdAt ≤ lastReadAt` → read; equality boundary; self excluded; muted badge variant
- [ ] Title badge: receive 3 unread in background tab → title `(3) Chat`; focus + read → `Chat`
