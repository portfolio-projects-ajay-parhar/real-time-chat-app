# Real-Time Chat App — Complete Build Guide

## Project Overview

The third **Intermediate** project of the 20-project curriculum — **Project 9: Real-Time Chat Application**, a Slack/WhatsApp-style messenger where the whole point is the architecture behind the chat, not just the chat UI:

- **Users** — register, set a profile (display name + avatar), search the user directory, start direct messages
- **Conversations** — 1:1 direct messages and named group chats with member management
- **Real-time layer** — instant message delivery, typing indicators, presence (online/offline/last seen), read receipts, live unread badges
- **History** — cursor-paginated message history with edit/delete, replies, and image/file attachments

Project 9 introduces eight genuinely new production concerns (reusing auth, storage, pagination, and testing patterns from Projects 2–8):

1. **WebSockets with Socket.IO** — persistent bidirectional connections, an auth handshake, rooms, ack callbacks, reconnection with gap recovery, and a strict typed event contract shared between client and server
2. **Redis Pub/Sub for horizontal scale** — the Socket.IO Redis adapter fans every emit out to **all** server instances, proving the "Client → WS Server → Redis → PostgreSQL" architecture from the curriculum with two instances in docker-compose
3. **Presence system** — Redis TTL keys + heartbeats, multi-tab socket tracking, last-seen timestamps persisted to Postgres, presence broadcast only to users who share a conversation
4. **Ephemeral state (typing indicators)** — deliberately broadcast-only with client-side timeouts; never persisted. A documented engineering trade-off
5. **Read receipts & unread counts** — a per-member `lastReadAt` watermark (Slack-style) instead of per-message receipt rows; unread counts derived from the DB on fetch and pushed in real time from a Redis counter
6. **Cursor (keyset) pagination for message history** — `WHERE (createdAt, id) < cursor` over `(conversationId, createdAt DESC)` — the correct pagination for an ever-growing, real-time-appended table (contrast with Project 8's offset pagination)
7. **Monorepo with a shared event-contract package** — npm workspaces: `web` (Next.js), `ws` (Socket.IO server), `shared` (zod schemas for every socket payload) so both sides literally share one type-checked contract
8. **Socket-level security** — JWT verification on the WS handshake, per-user Redis rate limiting on sends, room-membership authorization on every subscription, attachment validation

---

## Tech Stack

```text
Next.js 16 (App Router)          # web app: REST API + chat UI (same foundation as Projects 7–8)
TypeScript                       # everywhere, including the socket server
Tailwind CSS v4                  # styling
Node.js 20 + Socket.IO 4.8       # dedicated WS server process (apps/ws) — scales independently
@socket.io/redis-adapter         # cross-instance fan-out via Redis Pub/Sub
Redis 7                          # presence TTL keys, unread counters, rate limiting, Pub/Sub
PostgreSQL 16                    # message persistence (docker-compose locally, Supabase optional in prod)
Prisma 6                         # ORM (+ raw SQL advisory lock for DM uniqueness)
NextAuth v4                      # Credentials + JWT; next-auth/jwt decode() shared with the WS server
npm workspaces                   # web | ws | shared monorepo
TanStack Query v5 + Axios        # REST fetching + cache updates driven by socket events
Zod + React Hook Form            # validation, including every socket payload
Pluggable storage                # S3 | Cloudinary | local (same provider pattern as Project 8)
jose / next-auth/jwt             # JWE session-token verification inside the WS server
Vitest + socket.io-client        # unit tests + two-client integration tests against real Redis/Postgres
Docker + docker-compose          # postgres + redis (+ 2 ws instances to prove the adapter)
GitHub Actions                   # CI/CD
```

> **Why a separate WS server?** The core lesson of Project 9. Next.js can't own a long-lived socket process (serverless-style lifecycle, no easy multi-instance room tracking). A dedicated Socket.IO process scales horizontally, and the Redis adapter is what makes "2 instances, clients connected to both, still receive each other's messages" demonstrable — the exact scenario the integration tests prove.

> **Why Redis?** Four jobs: (1) Pub/Sub fan-out between WS instances, (2) presence via TTL keys — if a server dies, heartbeats stop and the key expires itself, (3) hot counters (unread, rate-limit buckets) that would hammer Postgres, (4) proof of the curriculum's `Client → WS → Redis → PostgreSQL` data path.

---

## Monorepo Layout

```text
real-time-chat-app/
├── package.json                    # npm workspaces: ["web", "ws", "shared"]
├── docker-compose.yml              # postgres, redis (dev) — plus web/ws for the prod-image test
├── .env.example
├── docs/                           # this plan, TASKS.md, phases/
├── shared/                         # @chat/shared — single source of truth for socket contract
│   ├── package.json
│   └── src/
│       ├── events.ts               # event name constants (client→server, server→client)
│       ├── schemas.ts              # zod schemas for every payload (both directions)
│       └── types.ts               # inferred TS types, ApiError codes
├── ws/                             # @chat/ws — Socket.IO server (independent process)
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                # http + socket.io bootstrap, adapter wiring, 2nd-instance port flag
│   │   ├── config.ts               # env parsing (zod)
│   │   ├── auth.ts                 # handshake middleware: next-auth/jwt decode()
│   │   ├── rooms.ts                # join user:{id} + conversation:{id} rooms from DB memberships
│   │   ├── presence.ts             # TTL keys, heartbeats, online/offline broadcast
│   │   ├── rateLimit.ts            # Redis fixed-window limiter
│   │   ├── handlers/
│   │   │   ├── message.ts          # message:send → validate → limit → persist → fan-out
│   │   │   ├── typing.ts           # typing:start/stop broadcast
│   │   │   └── read.ts             # conversation:read → lastReadAt → receipt broadcast
│   │   └── lib/prisma.ts           # singleton client
│   └── test/                       # vitest: unit + socket.io-client integration
└── web/                            # @chat/web — Next.js 16
    ├── package.json
    ├── prisma/
    │   ├── schema.prisma
    │   └── seed.ts
    ├── src/
    │   ├── app/
    │   │   ├── (auth)/signin|signup/page.tsx
    │   │   ├── (app)/layout.tsx                    # session guard + SocketProvider
    │   │   ├── (app)/conversations/page.tsx        # list (mobile: full-page, desktop: split)
    │   │   ├── (app)/conversations/[id]/page.tsx   # chat view
    │   │   ├── (app)/new/page.tsx                  # start DM / create group
    │   │   ├── (app)/settings/page.tsx             # profile + avatar
    │   │   └── api/…                               # REST surface (see §API)
    │   ├── components/chat/…                       # MessageList, MessageBubble, Composer, TypingDots, …
    │   ├── lib/
    │   │   ├── prisma.ts, auth.ts, storage.ts      # same patterns as Projects 7–8
    │   │   ├── socket-client.ts                    # singleton socket with reconnect + auth fallback
    │   │   └── cursor.ts                           # encode/decode keyset cursors
    │   └── hooks/
    │       ├── useSocket.ts                        # connect/disconnect on session, exposes socket
    │       └── useChatEvents.ts                    # socket events → TanStack Query cache updates
    └── test/
```

**Request flow — send a message (happy path):**

```text
Composer → socket.emit("message:send", payload, ack)
   → ws server: JWT already verified at handshake
      1. zod validate payload (shared/schemas.ts)        → ack 422 on failure
      2. membership check: socket is in conversation room? → ack 403 otherwise
      3. Redis rate limit INCR ratelimit:{userId}:msg     → ack 429 over 30/10s
      4. Prisma: INSERT Message (+ upsert Conversation.lastMessageAt)
         — unique clientId dedupes a reconnect double-send
      5. Redis pipeline: HINCRBY unread:{memberId} convId 1 for every other member
      6. io.to("conversation:{id}").emit("message:new")   → Redis adapter relays to ALL instances
      7. io.to("user:{memberId}").emit("unread:update")   → badge on every device of every member
      8. ack({ message }) to sender → replaces the optimistic bubble (clientId match)
```

---

## Database Schema (PostgreSQL / Prisma)

```text
User ─┬─< ConversationMember >─┬─ Conversation ───< Message >─┐
      │                        │                              ├── replyToId ──> Message (self-relation)
      └────────< Message (senderId) >────────────────────────┘
```

### Models

```prisma
enum ConversationType { DIRECT GROUP }
enum MemberRole       { OWNER MEMBER }
enum MessageType      { TEXT IMAGE FILE SYSTEM }

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String                              // display name
  passwordHash  String
  image         String?                             // avatar storage key (served via /api/media/[...key])
  bio           String?
  lastSeenAt    DateTime  @default(now())           // presence persistence (updated on last socket disconnect)
  createdAt     DateTime  @default(now())
  // + NextAuth models: Account, Session, VerificationToken
  memberships   ConversationMember[]
  messages      Message[]
}

model Conversation {
  id            String           @id @default(cuid())
  type          ConversationType
  name          String?          // GROUP only
  avatarKey     String?          // GROUP only
  createdById   String
  createdAt     DateTime         @default(now())
  lastMessageAt DateTime         @default(now())   // denormalized: conversation list sorts on this
  members       ConversationMember[]
  messages      Message[]
  @@index([lastMessageAt(sort: Desc)])
}

model ConversationMember {
  id             String     @id @default(cuid())
  conversationId String
  userId         String
  role           MemberRole @default(MEMBER)
  lastReadAt     DateTime   @default(now())  // READ-RECEIPT WATERMARK: messages with
                                             // createdAt <= my lastReadAt are "read by me";
                                             // others' lastReadAt determines "seen by" on my messages
  isMuted        Boolean    @default(false)
  joinedAt       DateTime   @default(now())
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([conversationId, userId])
  @@index([userId])                          // "all my conversations" + WS room join on connect
}

model Message {
  id               String       @id @default(cuid())
  conversationId   String
  senderId         String?      // null → SYSTEM (e.g. "Alice added Bob")
  type             MessageType  @default(TEXT)
  body             String?      @db.Text  // TEXT body / IMAGE caption (markdown-lite, sanitized)
  attachmentKey    String?                // storage key (S3/Cloudinary/local)
  attachmentName   String?
  attachmentSize   Int?
  attachmentMime   String?
  attachmentWidth  Int?                   // client-measured, images only
  attachmentHeight Int?
  clientId         String?      // client-generated UUID → idempotent resend after reconnect
  replyToId        String?
  replyTo          Message?     @relation("Replies", fields: [replyToId], references: [id])
  replies          Message[]    @relation("Replies")
  createdAt        DateTime     @default(now())
  editedAt         DateTime?
  deletedAt        DateTime?              // soft delete → tombstone "message deleted"
  conversation     Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sender           User?        @relation(fields: [senderId], references: [id])
  @@unique([clientId])                     // NULL clientId allowed repeatedly in Postgres
  @@index([conversationId, createdAt(sort: Desc), id])   // keyset pagination over history
  @@index([senderId])
}
```

### Key data-layer decisions

- **Read receipts = `lastReadAt` watermark, not per-message receipt rows.** A WhatsApp-style `MessageReceipt(messageId, userId)` table grows by `members × messages` and turns "seen by" into a heavy join. The watermark answers both questions with one indexed column: *have I read this?* (`msg.createdAt <= my.lastReadAt`) and *who has seen my message?* (`member.lastReadAt >= msg.createdAt` per member). This is the Slack/Discord model and the honest trade-off to document in the README.
- **DM uniqueness without a unique constraint.** There is no clean way to constrain "the DIRECT conversation whose member set is exactly {A, B}" in a relational schema. Instead: within one transaction, take a Postgres **advisory lock** on the sorted user pair (`pg_advisory_xact_lock(hashtext(...))` via `$queryRaw`), then `findFirst({ type: DIRECT, members: { some: A } & { some: B } })` before inserting. Concurrent "start chat" clicks from both sides serialize on the lock — no duplicate DMs.
- **`lastMessageAt` denormalized** on Conversation — the inbox sorts by it on every load; recomputing `MAX(messages.createdAt)` per conversation is an N+1 magnet.
- **Soft-delete messages** (`deletedAt`) — group members' `unread` math and receipt watermarks stay valid if a message disappears from view only.
- **SYSTEM messages** (`senderId: null`) record joins/leaves/renames in the timeline — the chat-native audit trail, reused from Project 13's mindset.

---

## Redis Data Design

| Key | Type | TTL | Purpose |
| --- | --- | --- | --- |
| `presence:{userId}` | string `"1"` | 70 s | **Presence heartbeat.** Every connected user's server refreshes it every 30 s. Server death → key expires → user auto-offline with zero cleanup code. |
| `sockets:{userId}` | SET of socketIds | — | Multi-tab/device tracking. Offline transition fires only when the last socket disconnects. |
| `unread:{userId}` | HASH `conversationId → count` | — | Hot unread badge. `HINCRBY` per message send, `HDEL` on read. REST list re-derives from Postgres (`COUNT WHERE createdAt > lastReadAt`) — if Redis flushes, the next fetch self-heals. |
| `ratelimit:{userId}:msg` | string counter | 10 s | Fixed-window send limiter — 30 messages / 10 s, else ack `429`. |

Plus the Socket.IO **Redis adapter's** own Pub/Sub channels (`socket.io#...`) — the thing that makes two server instances one logical cluster.

**Deliberately NOT in Redis: typing state.** Typing indicators are broadcast-only (`typing:start`/`typing:stop` events relayed through the adapter); each client keeps `typingUsers` in local state and removes a user after a 4 s timeout. Ephemeral data that no other code path ever reads doesn't earn a key — this is a documented trade-off, not an omission.

---

## Socket Event Contract (`@chat/shared`)

Every payload below has a zod schema in `shared/src/schemas.ts`; both the WS server and the web app import the same file. Event names live in `shared/src/events.ts`.

### Client → Server

| Event | Payload | Ack | Notes |
| --- | --- | --- | --- |
| `message:send` | `{ conversationId, clientId, type: TEXT \| IMAGE \| FILE, body?, attachment? { key, name, size, mime, width?, height? }, replyToId? }` | `{ ok: true, message }` or `{ ok: false, code, message }` | Membership + rate-limit + zod inside. `clientId` (UUID) dedupes reconnect double-sends. |
| `typing:start` | `{ conversationId }` | — | Server throttles to 1 broadcast / 2 s / (user, conversation). |
| `typing:stop` | `{ conversationId }` | — | Also fired implicitly on disconnect. |
| `conversation:read` | `{ conversationId }` | `{ ok, lastReadAt }` | Updates watermark + clears Redis unread. |

### Server → Client

| Event | Payload | Emitted to | Notes |
| --- | --- | --- | --- |
| `message:new` | `{ message }` (with sender + replyTo preloaded) | `conversation:{id}` room | Cross-instance via Redis adapter. |
| `typing:update` | `{ conversationId, userIds: string[] }` | `conversation:{id}` room | Recomputed set; clients diff it. |
| `receipt:update` | `{ conversationId, userId, lastReadAt }` | `conversation:{id}` room | Drives "seen by" ticks. |
| `presence:update` | `{ userId, status: online \| offline, lastSeenAt }` | `user:{id}` rooms of **mutual-conversation members only** | No global presence broadcast — a 10k-user instance must not emit 10k events per connect. |
| `unread:update` | `{ conversationId, count }` | `user:{id}` room | One event per member per message; badges live on every device. |
| `conversation:new` | `{ conversation }` | `user:{id}` room of each added member | Someone created a DM/group with you. |
| `member:joined` / `member:left` | `{ conversationId, member, systemMessage? }` | `conversation:{id}` room | Group membership changes. |
| `error` | `{ code, message, scope? }` | socket | Codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`. |

### Rooms

```text
conversation:{id}   — joined from DB memberships at connect; membership re-checked per send
user:{id}           — personal fan-out: unread badges, conversation:new, presence of others
```

### Connection lifecycle

```text
connect (handshake: session cookie, fallback ?token=)
   → auth middleware: next-auth/jwt decode() with NEXTAUTH_SECRET → attach { userId }
      ✗ → reject with UNAUTHENTICATED (client bounces to /signin)
   → on connect: SMEMBERS/JOIN — join user:{id} + all conversation:{id} rooms
   → presence: SADD sockets:{userId} socketId, SET presence:{userId} EX 70
      if first socket → broadcast presence:update online to mutuals + update User.lastSeenAt on the way
   → every 30 s server-side: refresh presence TTL
   → on disconnect: SREM socket; if set empty → broadcast offline + persist lastSeenAt
```

---

## REST API Surface (Next.js route handlers)

Sockets do the *live* work; REST does everything that is naturally request/response. Auth via NextAuth session cookie; all handlers throw typed `ApiError`s mapped by `handleApiError` (same guard pattern as Project 8).

```text
POST   /api/auth/register                  # email+password+name; 409 duplicate; rate-limited
POST   /api/auth/login                     # NextAuth Credentials (handled by NextAuth route)

GET    /api/me                             # profile + total unread
PATCH  /api/me                             # name, bio; avatar via /api/media then PATCH image key
GET    /api/users?q=                       # directory search (name/email ILIKE, min 2 chars, limit 20, excludes self)

GET    /api/conversations                  # inbox: members, last message preview, unread count, presence of others;
                                           #   sorted by lastMessageAt DESC
POST   /api/conversations                  # { type: DIRECT, userId } → advisory-lock dedupe
                                           #   { type: GROUP, name, memberIds[] } → SYSTEM "created the group"
GET    /api/conversations/[id]             # details + members (+ my membership guard)
PATCH  /api/conversations/[id]             # rename / avatar — OWNER only
DELETE /api/conversations/[id]             # leave group (self); owner leaving → transfer or block (409 if last owner)
POST   /api/conversations/[id]/members     # { userIds[] } — member can add? No: OWNER only for GROUP; 403 for DIRECT
DELETE /api/conversations/[id]/members/[uid]# remove other (OWNER) or leave (self)

GET    /api/conversations/[id]/messages    # history: ?cursor=<createdAtISO>~<id>&limit=30 (keyset, newest first)
POST   /api/conversations/[id]/read        # REST fallback for conversation:read (non-socket clients)
PATCH  /api/messages/[id]                  # edit body — sender only, TEXT only, ≤15 min old, sets editedAt
DELETE /api/messages/[id]                  # soft delete — sender or conversation OWNER; sets deletedAt

POST   /api/media                          # multipart upload → storage provider; allowlist + magic bytes + 10 MB
GET    /api/media/[...key]                 # local provider only: HMAC-signed streaming (S3/Cloudinary use their URLs)
GET    /api/ws-token                       # raw session JWT for the WS handshake fallback (same-origin cookie primary)
```

**Keyset pagination for history** (`web/src/lib/cursor.ts`):

```sql
WHERE "conversationId" = $1
  AND ("createdAt", id) < ($2, $3)      -- cursor = oldest loaded message
ORDER BY "createdAt" DESC, id DESC
LIMIT 30
```

Cursor is `base64url("{createdAtISO}~{id}")`. New messages arriving while scrolled up shift nothing — that's the point of keyset over offset on an append-heavy table. Reconnect gap recovery backfills with the same endpoint: `?after={lastSeenMessageCreatedAt}` (ascending variant) for messages missed while disconnected.

---

## Frontend Structure

```text
(auth)/signin · (auth)/signup           # public
(app)/layout.tsx                        # session guard (redirect /signin) + <SocketProvider>
(app)/conversations/page.tsx            # inbox (mobile) / left pane (desktop split view)
(app)/conversations/[id]/page.tsx       # chat view — header (presence/typing), list, composer
(app)/new/page.tsx                      # user directory (DM) + group builder (multi-select + name)
(app)/settings/page.tsx                 # profile editor + avatar upload
```

**State model — the important part:**

- **Server state → TanStack Query.** Every socket event is just a cache mutation: `message:new` → `setQueryData` on the conversation's messages (append, dedupe by `clientId`) + inbox preview update; `unread:update` → patch inbox item; `receipt:update` → patch the conversation's member watermark; `presence:update` → patch presence map. Components stay dumb; the socket layer is a Query client plugin (`useChatEvents` mounted once in `(app)/layout.tsx`).
- **Optimistic sends.** Composer generates `clientId` (UUID), appends a local pending bubble (`status: sending`) instantly; the `message:send` ack swaps it for the persisted message. A dropped connection leaves it pending; on reconnect the backfill query re-fetches and the unique `clientId` makes the server the dedupe authority.
- **Reconnection.** Socket.IO re-connects with backoff automatically; `useChatEvents` listens for `connect` → invalidate the active conversation's messages (gap backfill via `?after=`) + inbox (unread refresh). The `connect_error: UNAUTHENTICATED` path signs the user out.
- **Typing state** is local per client (`useState` map + 4 s eviction timer) — fed only by `typing:update`.

**Component inventory (`src/components/chat/`):** `ConversationList` (+ `ConversationItem` with unread badge + presence dot), `MessageList` (infinite scroll **upward** with `IntersectionObserver`, date separators, grouping consecutive messages by sender), `MessageBubble` (own vs other, pending/read ticks, edited marker, reply preview, image inline render, file card, deleted tombstone), `Composer` (autogrow textarea, Enter-to-send / Shift+Enter newline, attach button, reply banner, emoji — native picker only), `TypingDots`, `PresenceDot`, `GroupMembersSheet`, `Avatar`.

---

## Security

| Concern | Mechanism |
| --- | --- |
| WS authentication | Handshake middleware decodes the NextAuth JWE session token (`next-auth/jwt decode()` + `NEXTAUTH_SECRET`); unauthenticated sockets are rejected before any handler runs. Cookie via same-origin Next `rewrites` proxy (`/socket.io` → `ws:4001`); `?token=` fallback from `GET /api/ws-token`. |
| Authorization on sockets | Every handler re-checks membership in Postgres before touching data — room membership alone is never trusted (stale rooms after being kicked). |
| Rate limiting | Redis fixed window: 30 msgs/10 s per user (ack `429`); register + conversation-create endpoints rate-limited server-side. |
| Attachment validation | MIME allowlist (jpeg/png/webp/gif/pdf/txt), magic-byte sniff, 10 MB cap, storage keys are `{userId}/{cuid}` — never client-controlled paths. |
| Input validation | Zod on every REST body **and** every socket payload (shared schemas); message body length ≤ 4 000 chars. |
| XSS | Message bodies rendered through the same sanitize pipeline as Project 8; markdown-lite renderer is allowlist-based (bold/italic/code/links), never raw HTML. |
| Secrets | `.env` only; `NEXTAUTH_SECRET` shared by web + ws via compose env; no secrets in the shared package. |
| Presence privacy | Presence is only ever broadcast to users who share a conversation with the subject. |

---

## Testing Strategy

| Layer | Tool | What's covered |
| --- | --- | --- |
| Unit — shared | Vitest | Zod schemas accept/reject every payload shape; event-name constants used by both apps. |
| Unit — ws | Vitest + ioredis-mock | Rate limiter (fake timers: window expiry, boundary at 30); presence service (first-socket online, last-socket offline, TTL refresh); keyset cursor encode/decode. |
| Unit — web | Vitest + Testing Library | Optimistic reducer (pending → acked swap by clientId, dedupe on `message:new` echo); unread patch logic; composer Enter/Shift+Enter. |
| **Integration — ws** | Vitest + `socket.io-client` + **real** Redis/Postgres (compose) | The money suite — two clients on **two server instances** (ports 4001/4002, same Redis): A sends → B receives `message:new` + ack returns persisted row; both get `unread:update`; DM advisory-lock dedupe under parallel create; presence online/offline broadcast to mutuals only; `conversation:read` → `receipt:update`; rate limit 31st message → 429; kicked member's send → 403; reconnect dedupe (same clientId twice → one row). |
| E2E (stretch) | Playwright | Two browser contexts chatting live; typing dots + ticks visible. |

CI runs unit + integration with `services: postgres, redis` in GitHub Actions.

---

## Deployment

```text
docker-compose (dev)      postgres:16, redis:7 — only; web/ws run via npm dev with tsx/next dev
docker-compose (verify)   + builds web & ws images + SECOND ws instance → proves the adapter locally
Production shape          web (Next standalone) + ws (node dist/index.js) + managed Postgres (Supabase)
                          + managed Redis (Upstash/Redis Cloud); ws behind the same domain
                          (nginx/ingress proxies /socket.io with upgrade headers) → sticky sessions
                          unnecessary for correctness (adapter broadcasts everywhere) but good for locality
CI/CD                     GitHub Actions: install → typecheck (all 3 workspaces) → lint → unit → integration
                          → docker build both images → (optional) deploy hook
```

---

## Key Trade-offs (README ammunition)

1. **Watermark receipts vs per-message receipts** — O(1) storage, O(members) reads, no "delivered vs read" distinction; documented as the Slack model.
2. **Broadcast-only typing** — no Redis key, 4 s client eviction; a persist-nothing design for data nobody ever queries.
3. **Keyset vs offset pagination** — stable under live appends (Project 8's offset is contrasted head-on in the README).
4. **Unread: Redis for push, Postgres for truth** — self-healing on Redis flush; never trusts the cache for a computed value.
5. **Socket.IO vs raw `ws`** — rooms, acks, reconnection, adapter ecosystem bought for ~40 KB; raw `ws` listed as the "what would change" thought experiment.
6. **Monorepo shared contract** — zod schemas compiled once, consumed by both processes; the cheapest possible defense against client/server payload drift.

---

## Build Phases (summary — details in `phases/`)

```text
Phase 1  Monorepo setup & infrastructure        (workspaces, compose, env, health checks)
Phase 2  Database schema & seed                 (4 models + NextAuth, advisory-lock helper, realistic seed)
Phase 3  Authentication                         (NextAuth + WS token bridge, sign in/up, guards)
Phase 4  REST core                              (conversations, members, users, history, media)
Phase 5  Socket server core                     (bootstrap, auth middleware, rooms, Redis adapter, presence)
Phase 6  Real-time messaging                    (send pipeline, typing, unread push, optimistic UI)
Phase 7  Read receipts & presence UX            (watermarks, ticks, dots, badges, title count)
Phase 8  Chat UI polish                         (groups, edit/delete, replies, attachments render, markdown-lite)
Phase 9  Notifications & file sharing           (browser notifications, upload flow end-to-end, lightbox)
Phase 10 Testing, Docker & CI/CD               (two-instance integration suite, images, Actions, README)
```

Each phase ends green: `npm run typecheck && npm run test -w ws -w web` passes and the feature is verifiable with two browser windows.


