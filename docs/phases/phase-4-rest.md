# Phase 4 — REST Core

## Goals
1. Everything the UI needs that is naturally request/response: directory, conversations, members, **keyset-paginated history**, media
2. Inbox projection: last message + unread count + presence in one list response

## Steps

### 4.1 Directory & profile
- [ ] `GET /api/users?q=` — `ILIKE` on `name`/`email`, ≥2 chars, `take: 20`, exclude self; returns `{ id, name, image, bio, lastSeenAt }` (presence rendered client-side from the map, not trusted here)

### 4.2 Conversations
- [ ] `POST /api/conversations` — DIRECT: `{ type: "DIRECT", userId }` → `findOrCreateDirectConversation` (Phase 2); GROUP: `{ type: "GROUP", name, memberIds[] }` → OWNER for creator, MEMBER rows for others, SYSTEM message `"X created the group"`; after create → `io.to(user:{id})` fan-out is Phase 6's job (REST responds; sockets notify)
- [ ] `GET /api/conversations` — the inbox projection (one query per concern, not N+1):
```ts
const me = await prisma.conversationMember.findMany({
  where: { userId },
  orderBy: { conversation: { lastMessageAt: "desc" } },
  include: {
    conversation: {
      include: {
        members: { include: { user: { select: userCard } } },
        messages: { orderBy: { createdAt: "desc" }, take: 1 },   // last message preview
      },
    },
  },
});
// unread per member row: COUNT messages WHERE conversationId = c.id AND createdAt > m.lastReadAt AND deletedAt IS NULL AND senderId != me
```
- [ ] `GET /api/conversations/[id]` — membership guard → details + members (+ `lastReadAt` each, drives receipts UI)
- [ ] `PATCH /api/conversations/[id]` — GROUP rename/avatar, OWNER only; `DELETE` = leave (GROUP; last owner → 409)
- [ ] `POST /api/conversations/[id]/members` `{ userIds[] }` (OWNER, GROUP only) / `DELETE …/members/[userId]` (OWNER removes other, self = leave) + SYSTEM messages

### 4.3 History — keyset pagination
`web/src/lib/cursor.ts`:
```ts
export const encodeCursor = (m: { createdAt: Date; id: string }) =>
  Buffer.from(`${m.createdAt.toISOString()}~${m.id}`).toString("base64url");
export const decodeCursor = (c: string) => {
  const [iso, id] = Buffer.from(c, "base64url").toString().split("~");
  if (!iso || !id) throw new ApiError(400, "VALIDATION");
  return { createdAt: new Date(iso), id };
};
```
`GET /api/conversations/[id]/messages?cursor=&limit=30`:
```ts
const where = cursor
  ? { conversationId: id, deletedAt: null,
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },   // tiebreak → stable under same-ms bursts
      ] }
  : { conversationId: id, deletedAt: null };
const messages = await prisma.message.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  take: limit + 1, include: { sender: { select: userCard }, replyTo: { include: { sender: { select: userCard } } } } });
// nextCursor = encodeCursor(rows[limit - 1]) if rows.length > limit; respond ascending (oldest → newest) for render
```
Backfill variant for reconnects: `?after=<iso>` ascending — returns messages created while the socket was down.

### 4.4 Read fallback + message lifecycle
- [ ] `POST /api/conversations/[id]/read` — set `lastReadAt = now()` (REST fallback; the socket path in Phase 7 is primary)
- [ ] `PATCH /api/messages/[id]` — sender only, `type: TEXT`, ≤ 15 min (`Date.now() - createdAt < 900_000`), body zod ≤ 4000; sets `editedAt`
- [ ] `DELETE /api/messages/[id]` — sender or conversation OWNER; sets `deletedAt` (tombstone stays in history)

### 4.5 Media (Project 8 pattern, now for chat)
- [ ] `src/lib/storage.ts` — `getStorage()` → `s3 | cloudinary | local` (same interface as Project 8: `upload / getDownloadUrl(key, ttl) / delete`); local = disk + HMAC-signed `/api/media/[...key]?exp=&sig=`
- [ ] `POST /api/media` — multipart; allowlist `image/jpeg|png|webp|gif, application/pdf, text/plain`; magic-byte sniff (`file-type` or hand-rolled headers); 10 MB; key `attachments/{userId}/{cuid()}-{safeName}`
- [ ] Unit tests: cursor encode/decode round-trip + malformed cursor → `VALIDATION`; keyset SQL returns strictly older pages (compose Postgres); magic-byte rejection table

## Verify (Definition of Done)
- [ ] `POST /api/conversations` twice with same DM pair (parallel via `Promise.all`) → both 200/201, **one** conversation in DB
- [ ] Seed 40 messages → page through with `cursor` until `nextCursor: null`; no duplicates across page boundaries; insert a new message mid-paging → cursor page unchanged (that's the keyset win)
- [ ] Edit another user's message → 403; edit after 15 min → 422; non-member reads history → 403
- [ ] Upload `invoice.pdf` via curl → local provider writes file; fetch signed URL → 200; tampered `sig` → 403
