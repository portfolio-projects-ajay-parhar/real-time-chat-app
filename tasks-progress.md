# Real-Time Chat App Build — Progress Tracker

> Mirror of [`docs/TASKS.md`](./docs/TASKS.md). Tick boxes as each item completes. The "BUILD PASSING" line at the bottom is updated once typecheck + tests + build run clean.

## Status
**IN PROGRESS** — Phases 1-9 complete (2026-09-10). Prerequisites: Docker (Postgres + Redis), optional Supabase/Upstash for prod, S3/Cloudinary keys for attachments (local provider works without).

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
- [x] Browser notifications (gesture-gated permission via 🔔 chip in both inbox headers, hidden-tab/inactive-conversation only, click-to-navigate, mute-aware, self-messages excluded — `lib/notifications.ts` + `useNotifications`)
- [x] Attachment flow: pick → preview chip → `POST /api/media` → IMAGE/FILE message → optimistic send (dims measured client-side via `createImageBitmap`; upload failure → bubble removed + 413/415 banner; retry = press Send again, file stays selected)
- [x] Rendering: inline image (no CLS from measured dims) + lightbox (portal/Esc/backdrop/download); file card (icon/name/humanized size) + signed download — all URLs fetch-time-signed via `GET /api/media/sign` + `lib/media-url.ts` cache (`useSignedMediaUrl`, also fixed `Avatar`'s previously unsigned `/api/media/{key}` src)
- [x] Validation e2e (server + client + ws): evil.png (ELF) → 415, 11 MB → 413, off-allowlist mime → 415, foreign/dead attachment key over the socket → ack `VALIDATION` (ws `validateAttachment` mime allowlist + `attachments/{senderId}/` key ownership)
- [x] Two-window verification (real browsers, live ws): A→B inline image + caption + ✓✓ ticks, B renders with no refresh, lightbox both sides, FILE download returns exact bytes, 413/415 banners, typing with pending attachment
- [x] Unit tests: `web/test/attachments.test.ts` (pre-check 413/415 table, humanizeSize, attachToOptimistic/removeChatMessage), `web/test/notifications.test.ts` (shouldNotify matrix, notificationBody), `web/test/media-url.test.ts` (sign cache TTL/failure), `ws/test/attachment.test.ts` (guard table) — 138 tests green
- [ ] (Stretch, deferred) Offline email digest via Resend

> **Implementation notes (Phase 9):** Signed URLs are never persisted — keys resolve at render time through `GET /api/media/sign?key=` (session-guarded, 1 h signature) with a 55-min module cache; `Avatar` migrated onto the same helper (it had been rendering unsigned URLs that 403 under the local provider). The mime allowlist moved to `AttachmentMimeValues` in `@chat/shared` (REST route + client pre-check + ws handler share one source of truth). Chromium derives upload MIME from the file *extension* (an ELF renamed evil.png reports `image/png`), so the client pre-check cannot catch binaries — the server magic-byte sniff remains the real 415 gate (proven live via UI + curl). Upload failures remove the pending bubble and surface the reason in the composer error banner (the "toast"); `failed` bubble state stays reserved for socket-ack failures. OS notification pop-ups can't be granted in headless Chromium, so the shouldNotify matrix is unit-tested instead. Pre-existing Phase 8 lint debt (4 React-Compiler eslint errors in GroupMembersSheet/MessageList, verified present at HEAD before this phase) deferred to the Phase 10 final sweep since the CI gate includes lint.
>
> **Fix (surfaced during Phase 9 live verification):** the chat route intermittently 500'd on hard navigation — `useSyncExternalStore` was called without the third `getServerSnapshot` argument in both module stores (`typing-store.ts` ×1, `presence-store.ts` ×2), which React requires whenever a client component is SSR'd. Both stores now return a stable empty snapshot on the server (no socket state exists pre-hydration, and it matches the client's initial state, so hydration stays consistent). Verified: 4× consecutive hard navigations to `/conversations/[id]` all return 200 with the full chat rendered; socket connects through the same-origin rewrite and the send→ack pipeline works.

## Phase 10 — Testing, Docker & CI/CD
- [x] Unit suites green — shared 27 (new `shared/test/schemas.test.ts`), ws 45 (new `presence.unit.test.ts` with ioredis-mock: eval overridden with the exact SADD→SCARD / SREM(-1)→SCARD semantics since ioredis-mock can't run Lua; state isolated via `flushall` per test — mock instances SHARE one store), web 105
- [x] **Two-instance integration suite** (`ws/test/integration/lifecycle.integration.test.ts`, 4131/4132, 4 tests): DM advisory-lock dedupe via `Promise.all(findOrCreateDirectConversation(...))` importing the REAL web helper (cross-workspace TS import resolved by vitest from repo root), unread:update to bob's second device on the OTHER instance, kicked-member → next send acks `NOT_FOUND` without reconnect + fresh reconnect gets no conversation room, typing throttle ≤1 broadcast/2 s
- [x] Dockerfiles (web: deps/migrator/build/runner stages, standalone bundle, runner gets traced node_modules incl. @chat/shared thanks to `outputFileTracingRoot`; ws: build shared → prisma generate → tsc, runner copies node_modules with the generated prisma client + engines) + `prod-verify` compose profile (migrate one-shot → web + ws-1 + ws-2 + nginx round-robin with Upgrade headers on :8080; media volume for the local storage provider)
- [x] GitHub Actions CI (`.github/workflows/ci.yml`): postgres:16 + redis:7 services → npm ci → migrate deploy + seed → typecheck ×3 → lint → `npm run test` (integration suites run because DATABASE_URL/REDIS_URL envs are exported) → `npm run build` → `docker build` both images
- [x] README (root) — problem/features/stack, ASCII architecture + send pipeline, data-model decisions, socket event contract, REST surface, JWE auth bridge, security matrix, testing table, getting started + `docker compose --profile prod-verify up`, trade-offs (PLAN §verbatim), scaling story, What I Learned
- [x] `docs/architecture.svg` + `docs/ER-diagram.svg`; capstone screenshot `docs/screenshots/prod-verify-cross-instance-chat.png`
- [x] Final sweep: typecheck ×3 green, lint GREEN (fixed the 4 Phase 8 React-Compiler errors: GroupMembersSheet + MessageList setState-in-effect → render-time prop-change adjustment; scrollToBottom useCallback dropped so the compiler memoizes), 177 tests green, `npm run build` green (shared tsup + web standalone + ws tsc)

> **Implementation notes (Phase 10):** web Dockerfile is multi-stage with a dedicated `migrator` target (full node_modules + prisma CLI) so the one-shot compose `migrate` service can run `prisma migrate deploy` without shipping the CLI in the standalone runner. `outputFileTracingRoot: path.resolve(process.cwd(), "..")` is REQUIRED in next.config.ts — without it the standalone bundle misses the workspace `@chat/shared` (symlinked outside `web/`). .dockerignore excludes host `node_modules`/`.next` (Windows binaries must never shadow the container's `npm ci`). ioredis-mock caveat: all instances share ONE in-memory store — the presence unit test flushes in `beforeEach`. Kicked-member semantics follow the codebase-wide 404-not-403 convention (`NOT_FOUND`), superseding the phase sketch's `FORBIDDEN`.
>
> **Capstone verified LIVE through the prod-verify topology (nginx :8080):** Alice in a real browser via nginx round-robin landed on **ws-1** (`socket connected: RPSqlvcb…`), scripted Bob (`ws/test/bob-nginx.mjs`, NextAuth credentials sign-in → cookie handshake → `/socket.io/ws` via nginx) landed on **ws-2** (`kovkJcl0…`). Bob's message appeared in Alice's browser live with a persisted ack; Alice's reply crossed ws-1 → adapter → ws-2 into Bob's log; bob even received Alice's cross-instance typing:update. `docker compose --profile prod-verify build` built all four images (web standalone compiled in-container in ~8 s; ws healthchecks green). Seeded dummy attachment 404s until `docker cp web/.data/uploads/. web-1:/app/.data/uploads/` (fresh media volume). NOTE: after this `next build` (standalone), `next dev` serves stale 404s until `web/.next` is cleared (same gotcha as Phase 6).

---

**BUILD PASSING:** ✅ typecheck green ×3 (shared/ws/web); lint green (the 4 pre-existing Phase 8 React-Compiler errors fixed in the Phase 10 sweep); 179 tests green (shared 27, ws 47 incl. three two-instance integration suites vs real Redis/Postgres, web 105); `npm run build` green (shared tsup + web standalone + ws tsc). **Phase 10 capstone verified LIVE through the prod-verify topology:** nginx :8080 round-robin put Alice's browser on ws-1 and scripted Bob on ws-2 — messages, acks and typing flowed BOTH directions across instances via the Redis adapter; all four Docker images built (2026-09-10, all phases complete)

> **Post-phase UI polish + presence bug fix (2026-09-10, same day):**
> - **Chat UI polish pass** — tail-aware bubble rounding (grouped runs square the inner corners), gradient own-bubbles + ring on others, hover action chips overlaying beside bubbles (zero layout shift), floating date pills, grouping-aware spacing, `msg-in` slide animation, dot-grid wallpaper, slim scrollbars, blur header, wave typing dots, gradient send button, sidebar accent bar + ring, **Geist font actually applied** (was falling back to Arial), logout added (`UserMenu` — sidebar footer + mobile compact ⏻, verified sign-out → session destroyed → guard redirect).
> - **BUG (found during demo capture): stale `sockets:{userId}` entries permanently suppressed presence transitions.** An unclean client disconnect (e.g. `process.exit()` racing the close frame) or ws hard-kill left dead socket ids in the Redis set; the presence TTL key self-healed but the set didn't — the next connect saw `SCARD > 1` and the online broadcast NEVER fired (user stuck "last seen X" forever). Fixed in `presence.ts`: the connect Lua now also checks `EXISTS presence:{userId}` and, when the TTL key has expired, wipes the stale set before SADD — one atomic script, no race. Two new unit tests (heal-on-expired-presence, no-heal-while-alive; 10 presence unit tests total), driver scripts now await the server-side disconnect before exiting. Found because the GIF capture's scripted reconnects kept "failing" to go online — a nice example of demo tooling catching a production bug.
> - **README media**: `docs/demo.gif` (scripted live session captured from real browser frames — presence → typing → messages → inline image → reply quote → ✓✓ flip; assembled with `scripts/make-gif.mjs` from `ws/test/demo-driver.mjs` + `demo-beat.mjs` beats) + screenshot gallery in `docs/screenshots/` (inbox, receipts, typing, lightbox, group, attachment, new-chat, mobile, signin, prod-verify capstone). Seed fixture repaired: re-added Alice to All Hands (owner) and backed `seed-mural.jpg` with a real image (the 16-byte stub rendered broken); inline `<img>` also got `h-auto` to stop the width/height-attribute overflow scrollbars.
