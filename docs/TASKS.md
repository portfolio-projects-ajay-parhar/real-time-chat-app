# Real-Time Chat App — Agent Task List

> **STATUS: NOT STARTED (2026-09-08)** — plan complete (`PLAN.md` + 10 phase files), implementation pending.

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
- [ ] Root `package.json` with `workspaces: ["web", "ws", "shared"]` + root scripts (`dev`, `typecheck`, `lint`, `test`, `db:*`)
- [ ] `shared/` package (`@chat/shared`): `events.ts`, `schemas.ts` (zod), `types.ts`; built with `tsup` or consumed via TS paths
- [ ] `ws/` package (`@chat/ws`): tsx dev, `src/index.ts` boots http + Socket.IO on `WS_PORT` (4001)
- [ ] `web/` app: `npx create-next-app@latest web --typescript --tailwind --eslint --app --src-dir`

### 1.2 Infrastructure
- [ ] `docker-compose.yml`: `postgres:16` (vol, healthcheck) + `redis:7` (healthcheck); optional `web`, `ws-1`, `ws-2` profile for the adapter proof
- [ ] `.env.example` + `.env` — `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `WS_PORT`, `WS_INTERNAL_URL`, `REDIS_URL`, `STORAGE_PROVIDER`, storage keys
- [ ] Next `rewrites`: `/socket.io/:path*` → `WS_INTERNAL_URL/socket.io/:path*`
- [ ] Root scripts verified: `npm run dev` starts web + ws concurrently; both health-check green

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

- [ ] NextAuth v4: Credentials provider, Prisma adapter, JWT strategy; `bcryptjs` hashes
- [ ] `POST /api/auth/register` (zod, 409 duplicate, rate-limited)
- [ ] `src/lib/auth.ts` — `getAuthSession()`; `requireUser()` guard throwing typed `ApiError`
- [ ] `GET /api/ws-token` — returns raw session JWT via `getToken()` (handshake fallback)
- [ ] Sign-in / sign-up pages (React Hook Form + zod, error display)
- [ ] `(app)` layout guard → redirect `/signin?callbackUrl=…` (verified)
- [ ] `GET/PATCH /api/me` (profile + avatar key)

## Phase 4 — REST Core

- [ ] `GET /api/users?q=` — directory search (ILIKE, ≥2 chars, limit 20, excludes self)
- [ ] `POST /api/conversations` — DIRECT (advisory-lock helper) | GROUP (`{name, memberIds[]}`, OWNER rows, SYSTEM message)
- [ ] `GET /api/conversations` — inbox: members + lastMessage preview + unread (COUNT after `lastReadAt`) + presence of others; sort `lastMessageAt DESC`
- [ ] `GET/PATCH/DELETE /api/conversations/[id]` — details; rename (OWNER); leave group (last-owner → 409)
- [ ] `POST/DELETE /api/conversations/[id]/members` — add (OWNER, GROUP only), remove/leave
- [ ] `GET /api/conversations/[id]/messages` — keyset cursor (`?cursor=base64url(createdAt~id)&limit=30`) + `?after=` backfill; membership guard; tombstones filtered client-side
- [ ] `POST /api/conversations/[id]/read` — REST read fallback
- [ ] `PATCH/DELETE /api/messages/[id]` — edit (sender, TEXT, ≤15 min) / soft delete (sender or OWNER)
- [ ] Storage layer `src/lib/storage.ts` (s3 | cloudinary | local — Project 8 pattern) + `POST /api/media` + `GET /api/media/[...key]` (local: HMAC-signed)
- [ ] Unit tests: cursor helpers, keyset SQL round-trip, media validation (mime/magic/size)

## Phase 5 — Socket Server Core

- [ ] `ws/src/config.ts` — zod env (`PORT`, `DATABASE_URL`, `REDIS_URL`, `NEXTAUTH_SECRET`, `ORIGIN`)
- [ ] Bootstrap `index.ts` — http server + Socket.IO + `@socket.io/redis-adapter` (pub/sub clients) + CORS for web origin
- [ ] `auth.ts` — handshake middleware: cookie **or** `auth.token` → `next-auth/jwt decode()`; reject `UNAUTHENTICATED`
- [ ] `rooms.ts` — on connect: join `user:{id}` + all `conversation:{id}` from DB memberships; on new `conversation:new` joiner side handled by REST → socket rejoin on next connect (documented)
- [ ] `presence.ts` — `SADD sockets:{userId}`, `SET presence:{userId} EX 70`, 30 s heartbeat refresh, last-socket disconnect → persist `lastSeenAt` + broadcast `presence:update` to **mutual members only** (mutuals computed + cached per user)
- [ ] `GET /api/conversations` includes presence map (MGET `presence:{id}` for visible members)
- [ ] Integration smoke: socket.io-client connects with cookie, joins rooms, disconnect flips presence

## Phase 6 — Real-Time Messaging

- [ ] `handlers/message.ts` — `message:send`: zod → membership (DB re-check) → Redis rate limit (30/10 s) → Prisma insert (clientId unique dedupe) → `lastMessageAt` bump → `HINCRBY unread:{member}` pipeline → emit `message:new` to room + `unread:update` to each member's `user:{id}` room → ack
- [ ] `handlers/typing.ts` — start/stop broadcast (server throttle 1/2 s per user+conversation), disconnect → stop
- [ ] Error mapping: `{ ok:false, code }` acks; typed socket errors
- [ ] Web `socket-client.ts` — singleton, `transports: ['websocket']`, path `/socket.io`, connect on session, `auth.token` fallback
- [ ] `useChatEvents` — `message:new` → Query cache append + inbox preview; `unread:update` → badge; `typing:update` → local state; reconnect → backfill `?after=` + inbox invalidate
- [ ] Composer optimistic send (clientId UUID, pending bubble, ack swap, 429 toast)
- [ ] **Two-window manual test**: send ↔ receive live; typing dots; badge increments

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
