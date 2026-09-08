# Phase 9 — Notifications & File Sharing

## Goals
1. Browser notifications (permission-gated, hidden-tab only) + per-conversation mute
2. End-to-end attachments: upload → optimistic send → render (images inline + lightbox, files as cards) → download via signed URLs

## Steps

### 9.1 Browser notifications
- [ ] `useNotifications()` mounted in `(app)/layout.tsx`:
  - Permission requested on first user gesture inside the app (click on "Enable notifications" chip in header — never on page load)
  - Subscribes to `MESSAGE_NEW` via the same event hub; fires `new Notification(sender, { body, icon, tag: conversationId })` **only when** `document.hidden` OR the message's conversation ≠ active route
  - Click → `window.focus()` + navigate to `/conversations/{id}`
  - `isMuted` conversations skip notifications (badge dot only — Phase 7 behavior)
- [ ] Unread count already drives `(n) Chat` title (Phase 7) — keep in sync after notification click (read handler clears)

### 9.2 Attachment upload flow
```text
Composer: 📎 → file picker
  → client-side pre-check (allowlist mime, ≤ 10 MB) → attachment preview chip in composer (name/size or thumbnail)
  → on send: 1) POST /api/media (FormData) → { key, url }
             2) measure image width/height via <img> decode (client-side, cheap)
             3) socket MESSAGE_SEND { type: IMAGE|FILE, attachment: { key, name, size, mime, width?, height? }, body? (caption) }
             4) pending bubble shows progress state → ack swaps to final
```
- Upload failure → bubble marked `failed`, retry re-uploads (new `key`) with the same `clientId`.

### 9.3 Rendering
- [ ] IMAGE: inline `<img src={signedUrl} width height>` (no layout shift — client-measured dims), max-h 320, click → lightbox (portal: full-screen, Esc/backdrop close, download link)
- [ ] FILE: card (mime icon, `attachmentName`, humanized size) → click → signed URL download (`Content-Disposition` from provider; local provider sets it)
- [ ] Signed URL lifecycle: local provider HMAC links expire (1 h) — fetch-time signing via `GET /api/media/[...key]` route wrapper (S3/Cloudinary return their own presigned URLs); re-sign on `MESSAGE_NEW` echo + history load
- [ ] Image send/receive two-window: B sees the image without refresh; lightbox works on both

### 9.4 Validation hardening (server)
- [ ] `POST /api/media` rejects: mismatched extension vs magic bytes (415), oversized (413), disallowed type (415) — the ws `message:send` handler re-checks `attachment.mime` ∈ allowlist before persisting (defense in depth)
- [ ] Integration tests: upload `evil.png` that is actually an ELF binary → 415; 11 MB image → 413; then message referencing a non-existent key → ack `VALIDATION` (server `HEAD`-checks via storage interface)

## Verify (Definition of Done)
- [ ] Two windows: send image A→B → B renders inline, opens lightbox, downloads original
- [ ] Send PDF → card renders, downloads, opens
- [ ] Background tab: message arrives → OS notification; click focuses the right conversation
- [ ] Muted conversation: badge dot, no OS notification
- [ ] `evil.png` (binary) rejected with 415 toast; 11 MB rejected with 413
