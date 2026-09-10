# Real-Time Chat App Build — Progress Tracker

> Mirror of [`docs/TASKS.md`](./docs/TASKS.md). Tick boxes as each item completes. The "BUILD PASSING" line at the bottom is updated once typecheck + tests + build run clean.

## Status
**IN PROGRESS** — Phases 1-8 complete (2026-09-10). Prerequisites: Docker (Postgres + Redis), optional Supabase/Upstash for prod, S3/Cloudinary keys for attachments (local provider works without).

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
- [x] `message:send` pipeline: zod → DB membership re-check → Redis rate limit (30/10 s) → insert + `clientId` dedupe + `lastMessageAt` bump → `HINCRBY` unread pipeline → `message:new` to room + `unread:update` to member rooms → ack
- [x] Typing: throttled broadcast, stop-on-disconnect, 4 s client eviction
- [x] Web: singleton socket client + `useChatEvents` (cache patches for message/unread/typing, reconnect backfill via `?after=`)
- [x] Optimistic composer (clientId, pending→acked swap, 429 inline error; failed-state bubble, retry lands with Phase 8)
- [x] Two-window manual test passes

> **Implementation notes (Phase 6):** `ChatMessage` wire type added to `@chat/shared` — one serialization shared by REST history, `message:new` and the ack (ws `serializeMessage` mirrors the REST `userCard` include). Rate limiter is an atomic Lua `INCR`+`EXPIRE` (crash-safe window) that fails open. Typing stays broadcast-only: the instance-local registry recomputes `userIds`, clients MERGE and evict at 4 s (cross-instance ghost typers self-heal ≤4 s); throttle 1/2 s per user+conv with a DB membership re-check per broadcast. Unread push = one pipeline (HINCRBY all other members + HGET post-increment) → exact counts. Web cache reducers are pure + unit-tested (`web/src/lib/chat-cache.ts`); typing state is a `useSyncExternalStore` store (`web/src/lib/typing-store.ts`). New integration suite `ws/test/messaging.integration.test.ts` (two instances, 4111/4112): cross-instance delivery, unread push, clientId reconnect dedupe, non-member 404, zod 422, typing broadcast + implicit disconnect stop, exactly-one 429 at the 31st send. Manual test verified live (Alice in browser UI + Bob via `ws/test/bob-live.mjs` driving a real NextAuth sign-in → cookie handshake through the Next rewrite): bob's message appeared in alice's open chat, alice's composer send hit bob with `message:new` + `unread:update` count 1. Env gotchas: a VPN service squats `127.0.0.1:3000` (breaks browser sessions intermittently — use `PORT=3005 npm run dev` for browser testing), and after a prod `next build` a stale `web/.next` makes `next dev` 404 the nested `[id]` child routes until cleared.

## Phase 7 — Read Receipts & Presence UX
- [x] `conversation:read` handler: zod → DB membership re-check (`NOT_FOUND` for non-members) → `lastReadAt` watermark update → Redis `HDEL` unread → `receipt:update` to `conversation:{id}` (adapter cross-instance) → `unread:update {count: 0}` to the reader's `user:{id}` room → ack `{ok, lastReadAt}`
- [x] Auto read-marking (`useAutoRead`): conversation open + window focus + new message while near-bottom & tab visible, debounced 500 ms, skipped when the watermark already covers the newest message
- [x] Ticks: pending ⏱ → sent ✓ → read ✓✓ (DIRECT, from member watermarks) / "Seen by N/M" + avatar stack under the newest own message (GROUP)
- [x] Presence dots + "online / last seen X / offline" header subtitle (DIRECT) / "N members · M online" (GROUP) from `presence:update` events (`presence-store.ts` + `relative-time.ts`)
- [x] Live inbox badges + `document.title = (n) Chat` (`useTitleBadge`, recomputed from the inbox cache, muted excluded); muted rows render a dot without count
- [x] Unit tests (`web/test/receipts.test.ts`, 18): watermark math table (equality boundary, self excluded), forward-only receipt patches, `markInboxRead`, `patchInboxPresence`, `totalUnread` + muted-dot badge reducer
- [x] Integration suite `ws/test/receipts.integration.test.ts` (two instances 4121/4122, same Redis, 6 tests): watermark advance + `HDEL` + ack, cross-instance `receipt:update`, `unread:update {count: 0}` to the reader's user room, non-member `NOT_FOUND`, zod `VALIDATION`, idempotent re-reads

> **Implementation notes (Phase 7):** Read pipeline order: DB watermark → Redis `HDEL` → `receipt:update` (conversation room) → `unread:update {count: 0}` (reader's user room) — the zero-count push is what clears badges on the reader's OTHER devices; the reading device also patches optimistically on the ack. Watermark cache patches are forward-only so out-of-order adapter delivery can't regress them. Auto-read guard chain: visible tab → nearBottom → not-already-read → emit (idle open chats write nothing). Presence is a `useSyncExternalStore` module store fed only by `presence:update`; REST snapshots are the initial state. "Seen by N/M" anchors on the newest own persisted non-deleted message; individual ✓✓ ticks stay DIRECT-only per PLAN §7.2.

## Phase 8 — Chat UI Polish
- [x] `/new`: directory DM flow (debounced `GET /api/users?q=` → `POST {type: DIRECT}` → push to chat; advisory-lock dedupe makes repeats idempotent) + group builder (name + multi-select chips → `POST {type: GROUP}`)
- [x] Group management sheet (phase 8.2): members with role chips + presence dots, OWNER add/remove/rename, leave; last-owner 409 rendered as an inline hint; actions invalidate conversation/inbox/history caches so the persisted SYSTEM messages land in the timeline
- [x] Edit (own TEXT, ≤15 min, inline editor — Enter saves / Esc cancels, `editedAt` marker) / delete (sender or OWNER → tombstone "Message deleted") / reply (composer quote banner, `replyToId` through the realtime `message:send` pipeline, quoted preview click → scroll + flash highlight) — edit/delete are REST + pure cache patches per the phase scope note
- [x] Rendering: date separators (Today/Yesterday/localized), sender grouping (5-min window, SYSTEM resets, avatar+name on first only), IntersectionObserver upward pagination with scroll anchoring (no jump on prepend), "New messages ↓" pill when live messages land while scrolled up
- [x] Markdown-lite (bold/italic/inline code/http(s) autolink → React nodes, `rel="noopener noreferrer"`, NO raw HTML/`dangerouslySetInnerHTML`) + XSS payload test table
- [x] Desktop split view (`320px sidebar list | chat`) via shared `SidebarList` in `(app)/layout.tsx`; mobile full-screen list ↔ chat swap with back button (route-driven); empty states (no chats → CTA to `/new`; no messages → "Say hi 👋"; desktop inbox pane → "Select a conversation")
- [x] Unit tests (`web/test/markdown.test.ts` 16, `web/test/message-grouping.test.ts` 9, `web/test/message-actions.test.ts` 7): transform table + XSS payloads (`<script>`, `javascript:`, `data:` render inert), day-separator/5-min-grouping tables, `canEditMessage` boundary (exactly 15 min editable), `canDeleteMessage` owner rules, `patchMessageEdited` (incl. reply-quote refresh) / `patchMessageDeleted`

> **Implementation notes (Phase 8):** Edit/delete propagation to OTHER clients is refetch-driven per the phase-8 scope note: global `refetchOnWindowFocus` is off, so `ChatView` explicitly invalidates history + detail on window focus/visibility (B sees A's edit/tombstone after refocusing; socket propagation of edits is a listed future improvement, and the `MESSAGE_EDITED`/`MESSAGE_DELETED` event constants already exist in `@chat/shared`). The markdown parser is a pure `parseMarkdownLite` in `markdown.ts` (unit-tested); the React mapping lives in `markdown-lite.tsx` — opening `*`/`**` must not be followed by whitespace and closing runs prefer the last asterisk (`**a *b***` nests correctly); adjacent `**` can never form an empty node. Reply is fully realtime (`message:send` already accepted `replyToId` since Phase 6); optimistic reply bubbles carry the quote. Mobile inbox + desktop sidebar share one `["conversations"]` cache (`lib/queries.ts`), so socket patches hit both. SYSTEM messages from REST group mutations are NOT socket-pushed (same scope note) — they appear on invalidation/refetch.

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

**BUILD PASSING:** ✅ typecheck green ×3 (shared/ws/web); web build green (`next build`, incl. `/new`); unit suites green (web 70 unit tests incl. 32 new Phase 8 tests: markdown + XSS table, grouping, edit/delete reducers; ws unit); Phase 8 UI shipped (split view, /new, group sheet, edit/delete/reply, markdown-lite, date separators, scroll-up pagination). Integration suites (presence/messaging/receipts/keyset) verified in earlier phases — require Docker Postgres+Redis, which was offline during the Phase 8 session; re-run `npm run test -w ws -w web` once Docker is up (2026-09-10, Phase 8 complete)
