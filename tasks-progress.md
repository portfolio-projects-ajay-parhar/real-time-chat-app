# Real-Time Chat App Build — Progress Tracker

> Mirror of [`docs/TASKS.md`](./docs/TASKS.md). Tick boxes as each item completes. The "BUILD PASSING" line at the bottom is updated once typecheck + tests + build run clean.

## Status
**NOT STARTED** — planning complete (docs/PLAN.md + docs/TASKS.md + 10 phase files, 2026-09-08). Prerequisites: Docker (Postgres + Redis), optional Supabase/Upstash for prod, S3/Cloudinary keys for attachments (local provider works without).

## Prerequisites
- [ ] Node.js ≥ 20, npm ≥ 10, Docker + compose
- [ ] Supabase project (optional prod Postgres) / Upstash (optional prod Redis)
- [ ] S3 **or** Cloudinary credentials (`STORAGE_PROVIDER` picks; `local` for dev)
- [ ] `gh` CLI authenticated

## Phase 1 — Monorepo Setup & Infrastructure
- [ ] npm workspaces (`shared`, `ws`, `web`) + root scripts (`dev`, `typecheck`, `test`, `db:*`)
- [ ] `@chat/shared` — event constants + zod payload schemas + inferred types
- [ ] `ws/` — Socket.IO + ioredis + tsx dev skeleton, health endpoint
- [ ] `web/` — Next.js 16 scaffold (TS, Tailwind v4, src dir) + `/socket.io` rewrite
- [ ] docker-compose (postgres:16 + redis:7, healthchecks) + `.env.example`/`.env`
- [ ] `npm run dev` boots both processes; `npm run typecheck` green ×3

## Phase 2 — Database Schema & Seed
- [ ] Prisma schema — NextAuth models + `User`, `Conversation`, `ConversationMember`, `Message` (enums, self-relation, `clientId` unique, keyset composite index, `lastMessageAt` index)
- [ ] `init` migration + singleton Prisma clients (web + ws)
- [ ] `findOrCreateDirectConversation` — `pg_advisory_xact_lock` on sorted user pair + find-or-create (parallel-call test passes)
- [ ] Seed — 6 users (`Password123!`), 2 DMs, 2 groups, ~60 messages (reply/edited/soft-deleted/SYSTEM/image), staggered `lastReadAt`, `db:seed` script

## Phase 3 — Authentication
- [ ] NextAuth v4 Credentials + JWT + Prisma adapter; register API (zod, 409, rate-limited)
- [ ] `GET /api/ws-token` (raw JWE for handshake fallback) + ws-side `next-auth/jwt decode()` middleware (tested round-trip)
- [ ] Sign-in/sign-up pages + `(app)` server guard + `GET/PATCH /api/me`

## Phase 4 — REST Core
- [ ] `GET /api/users?q=` directory search
- [ ] Conversations: create (DIRECT lock / GROUP + OWNER rows + SYSTEM msg), inbox projection (members + lastMessage + unread + presence MGET), detail, rename, leave (last-owner 409), add/remove members
- [ ] `GET …/messages` keyset pagination (`createdAt,id` cursor + `?after=` backfill) + `POST …/read` fallback
- [ ] `PATCH/DELETE /api/messages/[id]` (edit ≤15 min / soft delete)
- [ ] Storage layer (`s3|cloudinary|local`) + `POST /api/media` (allowlist + magic bytes + 10 MB) + signed local streaming
- [ ] Unit tests: cursor helpers, keyset paging, media validation

## Phase 5 — Socket Server Core
- [ ] Bootstrap + `@socket.io/redis-adapter` (pub + sub clients); 2nd-instance port flag
- [ ] Handshake auth (cookie primary / `auth.token` fallback) → `socket.data.userId`
- [ ] Room join from DB memberships (`user:{id}` + all `conversation:{id}`)
- [ ] Presence service: `sockets:{userId}` set, `presence:{userId}` TTL 70 s, 30 s heartbeat interval, last-socket offline + `lastSeenAt` persist, **mutual-members-only** broadcast
- [ ] Integration smoke: connect/disconnect presence events

## Phase 6 — Real-Time Messaging
- [ ] `message:send` pipeline: zod → DB membership re-check → Redis rate limit (30/10 s) → insert + `clientId` dedupe + `lastMessageAt` bump → `HINCRBY` unread pipeline → `message:new` to room + `unread:update` to member rooms → ack
- [ ] Typing: throttled broadcast, stop-on-disconnect, 4 s client eviction
- [ ] Web: singleton socket client + `useChatEvents` (cache patches for message/unread/typing, reconnect backfill via `?after=`)
- [ ] Optimistic composer (clientId, pending→acked swap, 429 toast, retry)
- [ ] Two-window manual test passes

## Phase 7 — Read Receipts & Presence UX
- [ ] `conversation:read` handler: watermark update + `HDEL` unread + `receipt:update` broadcast
- [ ] Ticks: pending → sent → read (DIRECT) / "Seen by N" (GROUP, newest own message)
- [ ] Presence dots + "online / last seen" header subtitle from presence map
- [ ] Live inbox badges + `document.title` `(n)` count; muted = dot only
- [ ] Unit tests: watermark math table, title-badge reducer

## Phase 8 — Chat UI Polish
- [ ] `/new`: directory DM flow + group builder (name + multi-select)
- [ ] Group management sheet (add/remove/rename/leave, SYSTEM messages in timeline)
- [ ] Edit (inline, ≤15 min) / delete (tombstone) / reply (quote banner + quoted bubble) — REST + cache patch
- [ ] Rendering: date separators, sender grouping, scroll-up pagination, "new messages ↓" pill
- [ ] Markdown-lite (bold/italic/code/autolink) + XSS payload tests
- [ ] Desktop split view + mobile swap + empty states

## Phase 9 — Notifications & File Sharing
- [ ] Browser notifications (gesture-gated permission, hidden-tab/inactive-conversation only, click-to-navigate, mute-aware)
- [ ] Attachment flow: pick → preview → `POST /api/media` → IMAGE/FILE message → optimistic send
- [ ] Rendering: inline image (no CLS) + lightbox; file card + signed download
- [ ] Validation e2e: 415 magic-byte mismatch, 413 oversize, dead key → ack `VALIDATION`

## Phase 10 — Testing, Docker & CI/CD
- [ ] Unit suites green (shared / ws / web)
- [ ] **Two-instance integration suite** — cross-instance delivery, unread fan-out to 2nd device, receipts, presence mutuals-only, DM lock dedupe, rate-limit 429, kicked-member 403 without reconnect, reconnect clientId dedupe, typing throttle
- [ ] Dockerfiles (web standalone, ws dist) + `prod-verify` compose profile (web + ws-1 + ws-2 + nginx `/socket.io` upgrade headers)
- [ ] GitHub Actions CI: migrate+seed → typecheck ×3 → lint → unit → integration (postgres+redis services) → both image builds
- [ ] README (architecture + ER diagrams, event contract, trade-offs, scaling story, screenshots/GIF) + `docs/*.svg`

---

**BUILD PASSING:** ❌ not yet run (scaffold not created)
