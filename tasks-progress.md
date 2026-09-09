# Real-Time Chat App Build — Progress Tracker

> Mirror of [`docs/TASKS.md`](./docs/TASKS.md). Tick boxes as each item completes. The "BUILD PASSING" line at the bottom is updated once typecheck + tests + build run clean.

## Status
**IN PROGRESS** — Phases 1-5 complete (2026-09-09). Prerequisites: Docker (Postgres + Redis), optional Supabase/Upstash for prod, S3/Cloudinary keys for attachments (local provider works without).

## Prerequisites
- [x] Node.js ≥ 20 (v24), npm ≥ 10 (v11), Docker + compose (Postgres + Redis healthy via `sg docker`)
- [ ] Supabase project (optional prod Postgres) / Upstash (optional prod Redis)
- [ ] S3 **or** Cloudinary credentials (`STORAGE_PROVIDER` picks; `local` for dev)
- [ ] `gh` CLI authenticated

## Phase 1 — Monorepo Setup & Infrastructure
- [x] npm workspaces (`shared`, `ws`, `web`) + root scripts (`dev`, `typecheck`, `test`, `db:*`)
- [x] `@chat/shared` — event constants + zod payload schemas + inferred types (built with tsup)
- [x] `ws/` — Socket.IO + ioredis + tsx dev skeleton, health endpoint (`GET :4001/health`)
- [x] `web/` — Next.js 16 scaffold (TS, Tailwind v4, src dir) + `/socket.io` rewrite
- [x] docker-compose (postgres:16 + redis:7, healthchecks) + `.env.example`/`.env` — both containers healthy
- [x] `npm run dev` boots both processes; `npm run typecheck` green ×3

> **Implementation notes (Phase 1):** Socket.IO is mounted at custom path `/socket.io/ws`
> (ws server + client) because Next.js rewrites cannot match the bare engine.io default
> path, and Next normalizes trailing slashes so `/socket.io/ws/` needs an explicit rewrite
> pair (`/socket.io/ws/` and `/socket.io/ws`). `skipTrailingSlashRedirect: true` is required.
> WS port env var is `WS_PORT` (4001) — `PORT` would collide with Next's own port variable.

## Phase 2 — Database Schema & Seed
- [x] Prisma schema — NextAuth models + `User`, `Conversation`, `ConversationMember`, `Message` (enums, self-relation, `clientId` unique, keyset composite index, `lastMessageAt` index)
- [x] `init` migration + singleton Prisma clients (web + ws)
- [x] `findOrCreateDirectConversation` — `pg_advisory_xact_lock` on sorted user pair + find-or-create (parallel-call test passes)
- [x] Seed — 6 users (`Password123!`), 2 DMs, 2 groups, 22 messages (reply/edited/soft-deleted/SYSTEM/image), staggered `lastReadAt`, `db:seed` script

## Phase 3 — Authentication
- [x] NextAuth v4 Credentials + JWT + Prisma adapter; register API (zod, 409, rate-limited)
- [x] `GET /api/ws-token` (raw JWE for handshake fallback) — verified: token decodes with `next-auth/jwt decode()` on the ws side
- [x] Sign-in/sign-up pages (React Hook Form + zod, error display) + `(app)` server guard + `GET/PATCH /api/me`
- [x] Full curl E2E verified: register 201 → duplicate 409 → /api/me 401 → credentials sign-in → /api/me 200 → ws-token round-trip decode OK
- [x] `src/lib/auth.ts` — `getAuthSession()`; `requireUser()` guard; typed `ApiError` + `handleApiError` mapper; Redis fixed-window `checkRateLimit`

## Phase 4 — REST Core
- [x] `GET /api/users?q=` directory search (ILIKE, ≥2 chars, limit 20, excludes self)
- [x] Conversations: create (DIRECT lock / GROUP + OWNER rows + SYSTEM msg), inbox projection (members + lastMessage + unread raw-SQL COUNT after `lastReadAt` + presence MGET), detail, rename (OWNER), leave (last-owner 409), add/remove members
- [x] `GET …/messages` keyset pagination (`createdAt,id` cursor + `?after=` backfill, `limit+1` lookahead) + `POST …/read` fallback
- [x] `PATCH/DELETE /api/messages/[id]` (edit ≤15 min / soft delete)
- [x] Storage layer (`s3|cloudinary|local`; local = disk + HMAC-signed `/api/media/[...key]`) + `POST /api/media` (allowlist + magic bytes + 10 MB) — s3/cloudinary providers throw "not configured" until their SDK/creds are added
- [x] Unit tests: cursor helpers, keyset paging (real compose Postgres), media magic-byte table — 14 tests green
- [x] curl E2E (31 checks): parallel DM create → 1 row, keyset paging no-dupes, tombstones filtered, edit 403/422 rules, last-owner leave 409, signed media 200/403/413/415

> **Implementation notes (Phase 4):** Unread counts in the inbox are one raw SQL
> join (`Message` × `ConversationMember.lastReadAt`) rather than N per-row COUNTs.
> Membership guard returns **404** (not 403) so non-members can't probe
> conversation existence. `vitest.config.ts` added to web with the `@` alias; the
> keyset integration suite auto-skips when `DATABASE_URL` is absent. The local
> storage root is `web/.data/uploads` (gitignored).

## Phase 5 — Socket Server Core
- [x] Bootstrap + `@socket.io/redis-adapter` (pub + sub clients); 2nd-instance port flag (`createChatServer(env)` factory in `ws/src/app.ts` — same factory boots the integration suite's second instance)
- [x] Handshake auth (cookie primary / `auth.token` fallback) → `socket.data.userId` — `next-auth/jwt decode()` + DB existence check; rejects with `UNAUTHENTICATED` (client reads `connect_error.message`)
- [x] Room join from DB memberships (`user:{id}` + all `conversation:{id}`) + `getMutualUserIds()` for presence targeting
- [x] Presence service: `sockets:{userId}` set, `presence:{userId}` TTL 70 s, single 30 s heartbeat interval, last-socket offline + `lastSeenAt` persist, **mutual-members-only** broadcast
- [x] Integration smoke (`ws/test/presence.integration.test.ts`): two instances (4101/4102, same Redis) — cross-instance presence events, mutuals-only, multi-tab tracking, unauth rejection, cookie handshake, health `sockets` count — 4/4 green ×5 runs

> **Implementation notes (Phase 5):**
> - **`SADD` returns "newly added", not "first socket".** The phase doc's
>   `const added = await redis.sadd(...); if (added === 1)` fires for *every*
>   new tab (each socket id is new), re-broadcasting `online` per tab. Fixed
>   with atomic Lua scripts: `SADD`+`SCARD` on connect (cardinality 1 ⇒ first
>   socket) and `SREM`+`SCARD` on disconnect (-1 = not tracked, 0 = last
>   socket) — race-free across instances.
> - **PrismaClient snapshots `process.env` at construction**, and the ws
>   server constructs its client at import time — so vitest loads the
>   repo-root `.env` via `setupFiles` (`ws/test/setup.ts`), not in the test
>   body. Web's keyset suite is unaffected (it constructs its client after
>   its own loader runs in the same module).
> - `schema.prisma` now has `binaryTargets = ["native", "debian-openssl-3.0.x"]`
>   — the client was previously generated from WSL only, which broke Prisma
>   on Windows ("generated for debian-openssl-3.0.x"). Regenerate covers both.
> - Integration tests are deterministic by *settling on server-side Redis
>   state*: `connect()` resolves only after the server's `SADD` landed,
>   `disconnectAndSettle()` waits for the `SREM` — client-side events alone
>   race the async connect/disconnect handlers (phantom sockets).

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

**BUILD PASSING:** ✅ typecheck green ×3 (shared/ws/web); web build green; ws health 200 (now reports `sockets` count); web 200; `/socket.io/ws` proxy verified in dev + prod; ws presence integration suite 4/4 ×5 runs (2026-09-09)
