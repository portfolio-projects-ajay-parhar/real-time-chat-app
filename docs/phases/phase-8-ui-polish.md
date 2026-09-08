# Phase 8 — Chat UI Polish

## Goals
1. Start DM / create group flows
2. Group management with SYSTEM-message timeline
3. Message actions: edit, delete, reply
4. Rendering: date separators, sender grouping, markdown-lite, split-view layout

## Steps

### 8.1 `/new` — start a conversation
- [ ] Directory list (debounced `GET /api/users?q=`) → click → `POST /api/conversations { type: DIRECT, userId }` → router.push(`/conversations/{id}`) — server dedupe makes this idempotent
- [ ] Group tab: name input + multi-select members (min 1) → `POST { type: GROUP, name, memberIds }`

### 8.2 Group management
- [ ] Header → members sheet: avatars, role chips, `lastReadAt`-derived presence
- [ ] Owner actions: add members (`POST members`), remove (`DELETE members/[uid]`), rename
- [ ] Leave group (non-owner / owner with other owners); last owner → server 409 → UI hint "Assign another owner first"
- [ ] Every change lands in the timeline as a SYSTEM message via Phase 6 pipeline + `MEMBER_JOINED`/`MEMBER_LEFT` events → member sheet + header live-update

### 8.3 Message actions
- [ ] Hover/click menu on own TEXT messages (≤15 min): **Edit** — inline textarea, Enter saves (`PATCH /api/messages/[id]`), Esc cancels; `editedAt` marker renders
- [ ] **Delete** (own or owner) → soft delete → tombstone bubble "Message deleted" (italic, actions removed)
- [ ] **Reply** — sets composer reply banner; send includes `replyToId`; bubble renders quoted snippet (author + truncated body); DB self-relation preloaded in history DTO
- [ ] REST responses drive cache patches (no socket needed — other clients get updates via Phase 9's stretch or refresh; documented: edit/delete propagation over sockets is a listed future improvement, current scope re-fetches on focus)

> Scope note: edit/delete/reply are REST + cache-patch. Live propagation of *edits* to other connected clients is deliberately deferred to the "Future Improvements" list — the realtime surface (`message:new`, receipts, presence, typing, unread) is already proven end-to-end, and this keeps the event contract honest instead of bolting on half-states.

### 8.4 Rendering & layout
- [ ] `MessageList` — `IntersectionObserver` on a top sentinel → `fetchNextPage` (keyset cursor) → `scrollToBottom` behavior: auto-stick when already near bottom, "New messages ↓" pill when scrolled up and `MESSAGE_NEW` arrives
- [ ] Date separators (`date-fns` day labels); sender grouping: consecutive same-sender within 5 min → avatar+name only on first, hover timestamps on all
- [ ] Markdown-lite renderer — allowlist transform to React elements: `**bold**`, `*italic*`, `` `code` ``, autolinked URLs (`rel="noopener noreferrer"`); **no raw HTML** — unit-test the transform table incl. XSS payloads (`<script>`, `javascript:` links) render inert
- [ ] Layout: desktop grid `[320px | 1fr]`; mobile → list ↔ chat swap; empty states (no conversations → CTA to `/new`; no messages → "Say hi 👋")

## Verify (Definition of Done)
- [ ] Two windows: A edits → B sees new body + `edited` marker after refetch-on-focus; A deletes → B sees tombstone
- [ ] Reply chain renders quote on both sides; group create → members instantly see it in inbox (`conversation:new` from Phase 6) + SYSTEM message
- [ ] Long history (seed 200+ messages) — scroll up loads older pages, scroll position doesn't jump
- [ ] XSS payload messages render as text in both windows
- [ ] 375px viewport: list ↔ chat navigation works with back button (route-driven)
