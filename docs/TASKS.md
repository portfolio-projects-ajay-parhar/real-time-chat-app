# Real-Time Chat App — Agent Task List

> **STATUS: COMPLETE (2026-09-10)** — Phases 1-10 complete. All phases done; CI run green pending first push to GitHub (Actions can only run post-push).

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

- [x] `handlers/read.ts` — `conversation:read` → zod → membership (DB re-check, `NOT_FOUND` for non-members) → update `lastReadAt` → `HDEL unread` → `receipt:update` to room (adapter cross-instance) → `unread:update {count: 0}` to the reader's `user:{id}` room (badge clear on EVERY device) → ack `{ok, lastReadAt}`
- [x] Unread → read transition: opening conversation (mount), window focus, and new `MESSAGE_NEW` while active + scrolled to bottom — debounced 500 ms (`useAutoRead`), skipped when the watermark already covers the newest message
- [x] `MessageBubble` ticks: pending (⏱) → sent (✓) → read (✓✓, from member watermarks — DIRECT only)
- [x] `PresenceDot` + header "online / last seen X / offline" from presence map + `presence:update` events (`presence-store.ts`, `relative-time.ts`); GROUP header shows "N members · M online"
- [x] Inbox unread badges live via `unread:update`; `document.title = (n) Chat` badge (`useTitleBadge`, recomputed from inbox cache, muted excluded); muted rows render a dot without count
- [x] Group chat "Seen by N/M" line + avatar stack under the newest own message
- [x] Unit tests: watermark read/unread math table (equality boundary, self excluded), forward-only receipt patches, `markInboxRead`, presence patch, `totalUnread` + muted-dot badge reducer (`web/test/receipts.test.ts`, 18 tests)
- [x] Integration suite `ws/test/receipts.integration.test.ts` (two instances 4121/4122, same Redis): watermark advance + `HDEL` + ack, cross-instance `receipt:update`, `unread:update {count: 0}` to the reader's user room, non-member `NOT_FOUND`, zod `VALIDATION`, idempotent re-reads

### Phase 7 implementation notes
- Read pipeline ordering (server): DB watermark update → Redis `HDEL` → `receipt:update` to `conversation:{id}` → `unread:update {count: 0}` to `user:{readerId}`. The zero-count push is what clears badges on the reader's *other* devices (DoD: "both B devices' badges clear"); the sending client also patches its inbox optimistically on the ack.
- Non-member reads return `NOT_FOUND` (404-not-403), matching `message:send` and REST — the phase doc's `FORBIDDEN` sketch was superseded by the Phase 6 convention.
- Watermark patches are **forward-only** (`patchConversationReceipt` / `patchInboxReceipt` ignore stale events), so out-of-order adapter delivery can never regress a newer watermark.
- Auto-read guard chain: `document.visible` → `nearBottom` → watermark already covers newest message → emit. An idle open conversation writes nothing; window-focus re-checks are debounced into the same 500 ms timer.
- Presence is a `useSyncExternalStore` module store (`presence-store.ts`, same pattern as typing-store): REST snapshots (inbox `member.online`, `user.lastSeenAt`) are the initial state; `presence:update` events win from then on and are also patched into the inbox cache.
- "Seen by N/M" anchors on the newest own *persisted, non-deleted* message; individual ✓✓ ticks stay DIRECT-only (documented in PLAN §phase 7.2).

## Phase 8 — Chat UI Polish

- [x] `/new` — user directory with search → DM; group builder (name + multi-select members)
- [x] Group management sheet — members list, add (owner), remove (owner), leave; SYSTEM messages in timeline
- [x] Message actions — edit (own TEXT, ≤15 min, inline editor) / delete (tombstone) with socket-less REST + cache patch
- [x] Reply — quote banner in composer, `replyTo` preview in bubble, click scrolls to original (simple: no scroll, highlight if loaded)
- [x] Date separators; consecutive-message sender grouping (avatar/name on first only)
- [x] Markdown-lite renderer (bold/italic/inline code/links) + sanitized; link `rel="noopener"`
- [x] Desktop split view (list 320px | chat flex-1) + mobile full-screen swap; empty states

### Phase 8 implementation notes
- Reply is **fully realtime** — the Phase 6 `message:send` contract already carried `replyToId`; the composer quote banner + optimistic bubble with quote + quote-click scroll/highlight (no-op when the original isn't in the loaded pages) complete it.
- Edit/delete are REST + pure cache patches per the phase scope note (`patchMessageEdited` also refreshes reply quotes); cross-client propagation is refetch-on-focus — `ChatView` explicitly invalidates history + detail on focus/visibility since global `refetchOnWindowFocus` is off. Socket propagation of edits deferred (event constants `MESSAGE_EDITED`/`MESSAGE_DELETED` already exist in `@chat/shared`).
- Markdown-lite = pure `parseMarkdownLite` (`web/src/lib/markdown.ts`, unit-tested incl. XSS table) + React mapping (`markdown-lite.tsx`); allowlist only, no `dangerouslySetInnerHTML`; autolinks restricted to `http(s)` with `rel="noopener noreferrer"`.
- Scroll-up pagination uses an IntersectionObserver on a top sentinel with viewport anchoring to the previously-first message (keyset cursor immune to live appends); "New messages ↓" pill appears when a `message:new` lands while scrolled up.
- Split view: `(app)/layout.tsx` renders the desktop sidebar via `SidebarList`; mobile inbox and sidebar share the `["conversations"]` cache (`lib/queries.ts`).
- Group mutations (add/remove/rename/leave) are REST; the persisted SYSTEM messages surface via invalidated caches, not sockets (same documented scope note as edit/delete). Last-owner leave → server 409 shown inline.
- Verified: `npm run typecheck` green ×3, `next build` green (incl. `/new` route), 70 web unit tests green. Integration suites need Docker (offline this session) — re-run with compose up.

## Phase 9 — Notifications & File Sharing

- [x] Browser Notification permission prompt (gesture-gated: 🔔 chip in both inbox headers, never on page load) — notify on `message:new` when `document.hidden` or conversation not active; `isMuted` conversations skip; click → focus + navigate (`useNotifications` in SocketProvider, decision logic in `lib/notifications.ts` unit-tested)
- [x] Image upload flow — attach → preview chip (thumbnail object-URL) → dims client-measured (`createImageBitmap`) → `POST /api/media` → `message:send` IMAGE with caption; inline `<img>` from a fetch-time signed URL (no CLS) + lightbox (portal, Esc/backdrop, download)
- [x] File upload flow — FILE type card (icon, name, humanized size) + download via signed URL
- [x] Attachment validation e2e: oversize → 413 (client pre-check banner + server), bad mime/magic → 415 (server sniffs what Chromium's extension-based MIME mislabels), ws send re-checks mime allowlist + key ownership (`attachments/{senderId}/`) → ack `VALIDATION` (defense in depth)
- [x] Typing + unread behavior with attachments verified two-window (live browser-to-browser: image renders inline on B without refresh, lightbox both sides, file downloads correct bytes, 415/413 banners, typing with pending attachment)
- [ ] (Stretch, deferred) Offline email digest via Resend — background script scanning `lastSeenAt > 24 h` members with unread

### Phase 9 implementation notes
- Signed URL lifecycle: new `GET /api/media/sign?key=` (session-guarded, 1 h TTL) + `lib/media-url.ts` module cache (55 min) + `useSignedMediaUrl` hook; components resolve keys at render time — nothing URL-shaped is persisted. `Avatar` now uses the same helper (it previously rendered unsigned `/api/media/{key}`, which 403s under the local provider).
- Upload failure handling: the pending attachment bubble is removed and the composer's error banner shows the 413/415 reason (acts as the toast); the failed-bubble transport state stays reserved for socket-ack failures (Phase 6). Client-side pre-check (`lib/attachment.ts`) gives instant 413/415 without a round trip.
- Chromium reports MIME from the file extension (evil.png → `image/png`), so the client pre-check alone can't catch a binary — the server magic-byte sniff (Phase 4) is the real gate, verified live (415) both via curl and via the browser UI.
- ws `message:send` now rejects (ack `VALIDATION`) any attachment whose mime is off the shared allowlist (`AttachmentMimeValues` in `@chat/shared` — single source of truth for REST route, client pre-check and ws handler) or whose key is not `attachments/{senderId}/…` (a socket payload is not evidence of upload; keys are minted server-side).
- Verified live (browser ×2 contexts on ws :4001 + Next :3005): A→B inline image + caption, ✓✓ read ticks, B renders without refresh (`navigationEntries===1`), lightbox open/Esc/download, FILE card + signed download returning exact bytes, 415/413 banners, cross-window typing indicator while an attachment is pending. Real OS notification pop-ups can't be granted in headless Chromium (permission request stays pending) — decision matrix (self/muted/inactive/hidden) covered by `web/test/notifications.test.ts`.

## Phase 10 — Testing, Docker & CI/CD

- [x] Unit suites green: shared schemas (`shared/test/schemas.test.ts`, 27 tests — every zod payload accept/reject table + event-name constants); ws rate-limiter (fake timers) + presence service with `ioredis-mock` (`ws/test/presence.unit.test.ts`, 8 tests — first/last-socket transitions, TTL writes, untracked-socket no-op, heartbeat dedupe); web optimistic reducer + cursor lib (cumulative, 105 tests)
- [x] **Two-instance integration suite** (`ws/test/integration/lifecycle.integration.test.ts`, ports 4131/4132, 4 tests): DM advisory-lock dedupe under parallel create (imports the REAL `findOrCreateDirectConversation`), unread fan-out to bob's SECOND device (third client, other instance), kicked-member send acks `NOT_FOUND` without reconnect (DB re-check; 404-not-403 per the Phase 6 convention — the phase sketch's `FORBIDDEN` was superseded), typing throttle ≤1 broadcast/2 s. Cross-instance delivery, receipts, presence mutuals-only, rate-limit 429 and reconnect clientId dedupe are covered by the pre-existing presence/messaging/receipts integration suites
- [x] `Dockerfile` × 2 (web multi-stage standalone `output: "standalone"` + `outputFileTracingRoot` so @chat/shared traces; ws tsc → `node dist/index.js` with `/health` healthcheck) + `prod-verify` compose profile (migrate one-shot `prisma migrate deploy` → web + ws-1 + ws-2 + nginx `nginx/nginx.conf` with `/socket.io/` upgrade headers, round-robin upstream, `:8080`)
- [x] GitHub Actions `.github/workflows/ci.yml` — install → migrate+seed → typecheck ×3 → lint → unit + two-instance integration (services postgres:16 + redis:7) → `npm run build` → both `docker build`s
- [x] README — problem, features, stack table, ASCII architecture + send-pipeline, data-model decisions, event-contract tables, REST surface, JWE auth bridge, security matrix, testing table, getting started + adapter-proof topology, trade-offs (§PLAN verbatim), scaling story, What I Learned
- [x] `docs/architecture.svg` + `docs/ER-diagram.svg` in `docs/` + capstone screenshot `docs/screenshots/prod-verify-cross-instance-chat.png`
- [x] Final sweep: `npm run typecheck && npm run test && npm run build` all green; the 4 pre-existing Phase 8 React-Compiler lint errors FIXED (GroupMembersSheet/MessageList: render-time "adjust state on prop change" instead of setState-in-effect; scrollToBottom useCallback removed so the compiler memoizes)

---

## Definition of Done

- [x] Two browser windows (different users) chat in real time across **two WS instances** — capstone proven live through the prod-verify nginx topology (alice@ws-1 ↔ bob@ws-2, both directions + typing)
- [x] Presence, typing, read receipts, unread badges all live and correct after refresh
- [x] Message history survives restart (Postgres) and reconnect (gap backfill)
- [x] Image + file attachments upload, render, download
- [x] Integration suite proves cross-instance fan-out with real Redis
- [ ] CI green on GitHub Actions (pipeline committed; runs on first push — local equivalents all green); README tells the architecture story
