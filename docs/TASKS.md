# Real-Time Chat App — Agent Task List

> **STATUS: IN PROGRESS (2026-09-09)** — Phases 1-6 complete.

> Derived from [`PLAN.md`](./PLAN.md) and the individual files in the [`phases/`](./phases/) directory. Work through phases **in order** — each phase depends on the previous one. Mark `[/]` when in progress, `[x]` when done. Mirror progress to [`../tasks-progress.md`](../tasks-progress.md).

---

## Prerequisites & Environment

- [ ] Node.js ≥ 20 and npm ≥ 10 in PATH
- [ ] Docker + docker compose working (`docker compose ps` runs)
- [ ] Supabase project (optional — prod Postgres; local dev uses compose Postgres)
- [ ] Upstash/Redis Cloud account (optional — prod Redis; local dev uses compose Redis)
- [ ] S3 **or** Cloudinary credentials for attachments (local provider works without them)
- [ ] `gh` CLI authenticated (repo creation + Actions)

---

## Phase 1 — Monorepo Setup & Infrastructure

### 1.1 Workspaces
- [x] Root `package.json` with `workspaces: ["web", "ws", "shared"]` + root scripts (`dev`, `typecheck`, `lint`, `test`, `db:*`)
- [x] `shared/` package (`@chat/shared`): `events.ts`, `schemas.ts` (zod), `types.ts`; built with `tsup`
- [x] `ws/` package (`@chat/ws`): tsx dev, `src/index.ts` boots http + Socket.IO on `WS_PORT` (4001)
- [x] `web/` app: create-next-app (TypeScript, Tailwind v4, App Router, src dir)

### 1.2 Infrastructure
- [x] `docker-compose.yml`: `postgres:16` (vol, healthcheck) + `redis:7` (healthcheck); `web`, `ws-1`, `ws-2` prod profile for the adapter proof
- [x] `.env.example` + `.env` — `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `WS_PORT`, `WS_INTERNAL_URL`, `REDIS_URL`, `STORAGE_PROVIDER`, storage keys
- [x] Next `rewrites`: `/socket.io/:path*` → `WS_INTERNAL_URL/socket.io/:path*` (custom engine.io path `/socket.io/ws`, see tasks-progress.md notes)
- [x] Root scripts verified: web + ws boot, health checks green, typecheck green ×3

## Phase 2 — Database Schema & Seed

### 2.1 Prisma
- [ ] `prisma/schema.prisma` — NextAuth models + `User`, `Conversation`, `ConversationMember`, `Message` (enums `ConversationType`, `MemberRole`, `MessageType`; all indexes from PLAN §Database)
- [ ] `npx prisma migrate dev --name init` + generate
- [ ] Singleton `src/lib/prisma.ts` (web + ws each)

### 2.2 Helpers & Seed
- [ ] `createDirectConversation(aId, bId)` — transaction + `pg_advisory_xact_lock(hashtext(sorted pair))` + find-or-create
- [ ] `prisma/seed.ts` — 6 users (`Password123!`), 2 DMs, 2 groups (one all-hands), ~60 messages (edited + soft-deleted + reply + SYSTEM), staggered `lastReadAt` for unread states, dummy image attachment via local provider
- [ ] `npm run db:seed` + verify counts in Prisma Studio

## Phase 3 — Authentication

- [x] NextAuth v4: Credentials provider, Prisma adapter, JWT strategy; `bcryptjs` hashes
- [x] `POST /api/auth/register` (zod, 409 duplicate, rate-limited)
- [x] `src/lib/auth.ts` — `getAuthSession()`; `requireUser()` guard throwing typed `ApiError`
- [x] `GET /api/ws-token` — returns raw session JWT via `getToken()` (handshake fallback)
- [x] Sign-in / sign-up pages (React Hook Form + zod, error display)
- [x] `(app)` layout guard → redirect `/signin?callbackUrl=…` (verified)
- [x] `GET/PATCH /api/me` (profile + avatar key)

## Phase 4 — REST Core

- [x] `GET /api/users?q=` — directory search (ILIKE, ≥2 chars, limit 20, excludes self)
- [x] `POST /api/conversations` — DIRECT (advisory-lock helper) | GROUP (`{name, memberIds[]}`, OWNER rows, SYSTEM message)
- [x] `GET /api/conversations` — inbox: members + lastMessage preview + unread (COUNT after `lastReadAt`) + presence of others; sort `lastMessageAt DESC`
- [x] `GET/PATCH/DELETE /api/conversations/[id]` — details; rename (OWNER); leave group (last-owner → 409)
- [x] `POST/DELETE /api/conversations/[id]/members` — add (OWNER, GROUP only), remove/leave
- [x] `GET /api/conversations/[id]/messages` — keyset cursor (`?cursor=base64url(createdAt~id)&limit=30`) + `?after=` backfill; membership guard; tombstones filtered server-side
- [x] `POST /api/conversations/[id]/read` — REST read fallback
- [x] `PATCH/DELETE /api/messages/[id]` — edit (sender, TEXT, ≤15 min) / soft delete (sender or OWNER)
- [x] Storage layer `src/lib/storage.ts` (s3 | cloudinary | local — Project 8 pattern) + `POST /api/media` + `GET /api/media/[...key]` (local: HMAC-signed)
- [x] Unit tests: cursor helpers, keyset SQL round-trip, media validation (mime/magic/size)

## Phase 5 — Socket Server Core

- [x] `ws/src/config.ts` — zod env (`WS_PORT`, `DATABASE_URL`, `REDIS_URL`, `NEXTAUTH_SECRET`, `ORIGIN`) — done in Phase 1, verified here
- [x] Bootstrap `index.ts` → `app.ts` factory (`createChatServer`) — http + Socket.IO + `@socket.io/redis-adapter` (pub/sub) + CORS; health now reports `sockets: io.engine.clientsCount`; second instance = same factory on another port
- [x] `auth.ts` — handshake middleware: cookie (primary, parsed from `next-auth.session-token`) **or** `auth.token` → `next-auth/jwt decode()` + DB existence check → `socket.data.userId`; rejects `UNAUTHENTICATED`
- [x] `rooms.ts` — on connect: join `user:{id}` + all `conversation:{id}` from DB memberships; `getMutualUserIds()` (distinct co-members, minus self) for presence targeting
- [x] `presence.ts` — `sockets:{userId}` SET, `presence:{userId}` TTL 70 s, single 30 s heartbeat interval (pipeline `SET … EX 70` per connected user), last-socket disconnect → `lastSeenAt` persist + `presence:update` broadcast to **mutuals only**. First/last-socket detection is an **atomic Lua `SADD`+`SCARD` / `SREM`+`SCARD`** (SADD returns "newly added", not "first socket" — see tasks-progress note)
- [x] `GET /api/conversations` presence map — already shipped in Phase 4 (`getPresenceMap` MGET in `getInbox`)
- [x] Integration smoke (`ws/test/presence.integration.test.ts`): **two instances** (4101/4102, same Redis) — unauthenticated rejection, mutuals-only online broadcast (observer w/o shared conversation receives nothing), exactly-one online event (no adapter dupes), cookie handshake, multi-tab cross-instance tracking (2 tabs → still 1 online event; close one → online; close last → offline + `lastSeenAt` persisted + Redis keys cleaned), health `sockets` count. Auto-skips without `.env`; deterministic via connect/disconnect *settle* on server-side Redis state (vitest `setupFiles` loads root `.env` before PrismaClient snapshots env)

## Phase 6 — Real-Time Messaging

- [x] `handlers/message.ts` — `message:send`: zod → membership (DB re-check) → Redis rate limit (30/10 s) → Prisma insert (clientId unique dedupe) → `lastMessageAt` bump → `HINCRBY unread:{member}` pipeline → emit `message:new` to room + `unread:update` to each member's `user:{id}` room → ack
- [x] `handlers/typing.ts` — start/stop broadcast (server throttle 1/2 s per user+conversation), disconnect → stop
- [x] Error mapping: `{ ok:false, code }` acks; typed socket errors (`ackError` in `errors.ts`; non-member send → `NOT_FOUND`, 404-not-403 same as REST)
- [x] Web `socket-client.ts` — singleton, `transports: ['websocket']`, path `/socket.io/ws`, connect on session, `auth.token` fallback
- [x] `useChatEvents` — `message:new` → Query cache append + inbox preview; `unread:update` → badge; `typing:update` → local state; reconnect → backfill `?after=` + inbox invalidate
- [x] Composer optimistic send (clientId UUID, pending bubble, ack swap, 429 inline error)
- [x] **Two-window manual test**: send ↔ receive live; typing dots; badge increments — verified live via UI (Alice) + scripted second client (Bob, `ws/test/bob-live.mjs`) through the same-origin rewrite: bob's send appeared in alice's chat live, alice's composer send reached bob (`message:new` + `unread:update` count 1), typing:update flowed both ways, ack swapped the optimistic bubble

### Phase 6 implementation notes
- Wire shape: `ChatMessage` in `@chat/shared` — one serialization for REST history, `message:new` and the send ack (`serializeMessage` in ws mirrors the REST `userCard` include).
- Rate limiter (`ws/src/rateLimit.ts`): atomic Lua `INCR`+`EXPIRE` (crash-safe window creation), fail-open on Redis outage (same trade-off as the REST limiter).
- Typing is instance-local by design (broadcast-only, PLAN §Redis): the recomputed `userIds` set reflects the emitting instance; clients MERGE (add/refresh each user) and evict at 4 s — removal is timeout-driven, so cross-instance ghost typers self-heal in ≤4 s. Throttle: 1 broadcast / 2 s / (user, conversation), membership re-checked per broadcast (bounded by the throttle).
- Unread push: one Redis pipeline (HINCRBY every other member + HGET post-increment values) → exact `unread:update` per member to `user:{id}` rooms.
- Web cache reducers are pure (`web/src/lib/chat-cache.ts`): optimistic append, ack swap by clientId, `markMessageFailed`, `mergeBackfill` (reconnect gap), inbox preview/unread patches — all unit-tested; typing state is a `useSyncExternalStore` store (`web/src/lib/typing-store.ts`).
- Reconnect recovery: on `connect`, every conversation with cached history fetches `?after={lastCached.createdAt}` and merges via `mergeBackfill`; inbox invalidated.
- Integration suite (`ws/test/messaging.integration.test.ts`): two instances (4111/4112, same Redis) — cross-instance delivery + persisted ack, unread push to `user:{id}` room, clientId reconnect dedupe (1 row, both acks ok), non-member 404, zod `VALIDATION`, typing broadcast + implicit disconnect stop, exactly-one 429 at the 31st send.
- Env gotcha during the manual test: a third-party VPN service squatted `127.0.0.1:3000` (Next bound `::`/`0.0.0.0`), splitting browser traffic and breaking sessions intermittently — retested on `PORT=3005`. Also: after a production `next build`, `next dev` served stale 404s for the nested `[id]` child routes until `web/.next` was cleared.

## Phase 7 — Read Receipts & Presence UX

- [ ] `handlers/read.ts` — `conversation:read` → update `lastReadAt` → `HDEL unread` → `receipt:update` to room → ack
- [ ] Unread → read transition: opening conversation (viewport + debounce) fires `conversation:read`
- [ ] `MessageBubble` ticks: pending (clock) → sent (✓) → read (✓✓, from member watermarks)
- [ ] `PresenceDot` + header "online / last seen X" from presence map + `presence:update` events
- [ ] Inbox unread badges live via `unread:update`; `document.title = (n) Chat` badge; clear on read
- [ ] Group chat "Seen by N" line under latest own message
- [ ] Unit tests: watermark read/unread math; title-badge reducer

## Phase 8 — Chat UI Polish

- [ ] `/new` — user directory with search → DM; group builder (name + multi-select members)
- [ ] Group management sheet — members list, add (owner), remove (owner), leave; SYSTEM messages in timeline
- [ ] Message actions — edit (own TEXT, ≤15 min, inline editor) / delete (tombstone) with socket-less REST + cache patch
- [ ] Reply — quote banner in composer, `replyTo` preview in bubble, click scrolls to original (simple: no scroll, highlight if loaded)
- [ ] Date separators; consecutive-message sender grouping (avatar/name on first only)
- [ ] Markdown-lite renderer (bold/italic/inline code/links) + sanitized; link `rel="noopener"`
- [ ] Desktop split view (list 320px | chat flex-1) + mobile full-screen swap; empty states

## Phase 9 — Notifications & File Sharing

- [ ] Browser Notification permission prompt (on first open, not before gesture policy) — notify on `message:new` when `document.hidden` or conversation not active
- [ ] Image upload flow — attach → preview (dimensions client-measured) → `POST /api/media` → `message:send` IMAGE with caption; inline `<img>` render (signed URL) + lightbox
- [ ] File upload flow — FILE type card (icon, name, size) + download via signed URL
- [ ] Attachment validation e2e: oversize → 413 toast, bad mime/magic → 415
- [ ] Typing + unread behavior with attachments verified two-window
- [ ] (Stretch) Offline email digest via Resend — background script scanning `lastSeenAt > 24 h` members with unread

## Phase 10 — Testing, Docker & CI/CD

- [ ] Unit suites green: shared schemas; ws rate-limiter (fake timers) + presence (ioredis-mock); web optimistic reducer + cursor lib
- [ ] **Two-instance integration suite** (`ws/test/integration/`): two `socket.io-client`s against ws:4001 + ws:4002 (same Redis) — cross-instance delivery, unread, receipts, presence, DM dedupe under parallel create, rate-limit 429, kicked-member 403, clientId dedupe on reconnect
- [ ] `Dockerfile` × 2 (web standalone output; ws `node dist/index.js`) + prod-profile compose (web, ws-1, ws-2, postgres, redis, nginx with `/socket.io` upgrade headers)
- [ ] GitHub Actions — install → typecheck ×3 → lint → unit → integration (services postgres+redis) → build images
- [ ] README — problem, features, **architecture diagram**, ER diagram, event-contract table, trade-offs (§PLAN), scaling story (adapter → more instances), screenshots, demo GIF
- [ ] `architecture.svg` + `ER-diagram.svg` in `docs/`
- [ ] Final sweep: `npm run typecheck && npm run test && npm run build` all green

---

## Definition of Done

- [ ] Two browser windows (different users) chat in real time across **two WS instances**
- [ ] Presence, typing, read receipts, unread badges all live and correct after refresh
- [ ] Message history survives restart (Postgres) and reconnect (gap backfill)
- [ ] Image + file attachments upload, render, download
- [ ] Integration suite proves cross-instance fan-out with real Redis
- [ ] CI green on GitHub Actions; README tells the architecture story
