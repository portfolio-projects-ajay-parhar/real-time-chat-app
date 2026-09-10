import type { ChatMessage } from "@chat/shared";

/**
 * Pure cache reducers for the chat Query caches. Every socket event is just
 * a cache mutation (PLAN §frontend state model) — components stay dumb and
 * these functions stay unit-testable with no React or socket dependency.
 */

// ---------- Wire shapes mirrored from the REST surface ----------

export interface InboxMember {
  id: string;
  role: "OWNER" | "MEMBER";
  lastReadAt: string;
  isMuted: boolean;
  user: { id: string; name: string; image: string | null; bio: string | null };
  online: boolean;
}

export interface InboxConversation {
  id: string;
  type: "DIRECT" | "GROUP";
  name: string | null;
  avatarKey: string | null;
  createdById: string;
  lastMessageAt: string;
  myRole: "OWNER" | "MEMBER";
  myLastReadAt: string;
  isMuted: boolean;
  unread: number;
  members: InboxMember[];
  lastMessage: {
    id: string;
    type: string;
    body: string | null;
    senderId: string | null;
    createdAt: string;
    senderName: string | null;
  } | null;
}

export interface MessagesPage {
  messages: ChatMessage[];
  nextCursor: string | null;
}

// ---------- Message list reducers ----------

const byCreatedAt = (a: ChatMessage, b: ChatMessage) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function matches(m: ChatMessage, incoming: ChatMessage): boolean {
  // The optimistic bubble carries the same clientId the ack/echo returns.
  if (incoming.clientId && m.clientId === incoming.clientId) return true;
  return m.id === incoming.id;
}

/**
 * Append (or reconcile) a message into a history list. Handles all three
 * arrivals: the optimistic append itself, the `message:new` room echo and
 * the send ack — any of which may already be present by clientId or id.
 */
export function appendChatMessage(
  list: ChatMessage[] | undefined,
  incoming: ChatMessage
): ChatMessage[] {
  const base = list ?? [];
  const idx = base.findIndex((m) => matches(m, incoming));
  if (idx === -1) return [...base, incoming].sort(byCreatedAt);
  const next = [...base];
  next[idx] = { ...incoming };
  return next;
}

/** Ack errored (e.g. 429) — flip the optimistic bubble to a failed state. */
export function markMessageFailed(
  list: ChatMessage[] | undefined,
  clientId: string
): ChatMessage[] {
  const base = list ?? [];
  const idx = base.findIndex((m) => m.clientId === clientId);
  if (idx === -1) return base;
  const next = [...base];
  next[idx] = { ...next[idx], pending: false, failed: true };
  return next;
}

/**
 * Upload failed (413/415/no network) — the pending attachment bubble is
 * removed and the composer's error banner explains why (Phase 9 scope note:
 * the failed-bubble transport state stays reserved for socket-ack failures).
 */
export function removeChatMessage(
  list: ChatMessage[] | undefined,
  clientId: string
): ChatMessage[] {
  const base = list ?? [];
  const idx = base.findIndex((m) => m.clientId === clientId);
  if (idx === -1) return base;
  return [...base.slice(0, idx), ...base.slice(idx + 1)];
}

/**
 * The attachment finished uploading mid-send — patch the optimistic bubble
 * (by clientId) with the uploaded metadata so the inline image/card starts
 * rendering from the signed URL while awaiting the send ack.
 */
export function attachToOptimistic(
  list: ChatMessage[] | undefined,
  clientId: string,
  attachment: {
    key: string;
    name: string;
    size: number;
    mime: string;
    width?: number;
    height?: number;
  }
): ChatMessage[] {
  const base = list ?? [];
  const idx = base.findIndex((m) => m.clientId === clientId);
  if (idx === -1) return base;
  const next = [...base];
  next[idx] = {
    ...next[idx],
    attachmentKey: attachment.key,
    attachmentName: attachment.name,
    attachmentSize: attachment.size,
    attachmentMime: attachment.mime,
    attachmentWidth: attachment.width ?? null,
    attachmentHeight: attachment.height ?? null,
  };
  return next;
}

/** Merge a backfill batch (reconnect gap) into the last history page. */
export function mergeBackfill(
  pages: MessagesPage[],
  incoming: ChatMessage[]
): MessagesPage[] {
  if (incoming.length === 0 || pages.length === 0) return pages;
  const lastIdx = pages.length - 1;
  let merged = pages[lastIdx].messages;
  for (const m of incoming) merged = appendChatMessage(merged, m);
  const next = [...pages];
  next[lastIdx] = { ...pages[lastIdx], messages: merged };
  return next;
}

// ---------- Inbox reducers ----------

/**
 * Live inbox update on message:new: refresh the preview, move the row to the
 * top (lastMessageAt ordering) and bump unread for messages from others.
 * The authoritative count arrives separately via unread:update.
 */
export function patchInboxAfterMessage(
  inbox: InboxConversation[] | undefined,
  message: ChatMessage,
  viewerId: string
): InboxConversation[] {
  if (!inbox) return inbox ?? [];
  const idx = inbox.findIndex((c) => c.id === message.conversationId);
  if (idx === -1) return inbox; // conversation created after this inbox fetch → invalidate covers it

  const conv = inbox[idx];
  const updated: InboxConversation = {
    ...conv,
    lastMessageAt: message.createdAt,
    unread:
      message.senderId && message.senderId !== viewerId
        ? conv.unread + 1
        : conv.unread,
    lastMessage: {
      id: message.id,
      type: message.type,
      body: message.body,
      senderId: message.senderId,
      createdAt: message.createdAt,
      senderName: message.sender?.name ?? null,
    },
  };
  return [updated, ...inbox.filter((_, i) => i !== idx)];
}

/** unread:update — the server's hot counter wins (it is the push truth). */
export function patchInboxUnread(
  inbox: InboxConversation[] | undefined,
  conversationId: string,
  count: number
): InboxConversation[] {
  if (!inbox) return inbox ?? [];
  return inbox.map((c) => (c.id === conversationId ? { ...c, unread: count } : c));
}

// ---------- Read receipts (Phase 7) ----------

/**
 * Conversation-detail shape served by GET /api/conversations/[id] (extra
 * fields like joinedAt may be present — this is the subset the UI reads).
 */
export interface ConversationMemberDetail {
  id: string; // userId
  role: "OWNER" | "MEMBER";
  lastReadAt: string;
  isMuted: boolean;
  user: { id: string; name: string; image: string | null; bio: string | null; lastSeenAt: string };
}

export interface ConversationDetail {
  id: string;
  type: "DIRECT" | "GROUP";
  name: string | null;
  avatarKey: string | null;
  createdById: string;
  lastMessageAt: string;
  members: ConversationMemberDetail[];
}

/** True when the message timestamp is covered by the watermark: createdAt ≤ lastReadAt. */
export function isReadByWatermark(messageCreatedAt: string, lastReadAt: string): boolean {
  return new Date(messageCreatedAt).getTime() <= new Date(lastReadAt).getTime();
}

/** `a ≥ b` for ISO timestamps (fresh watermark vs newest message). */
export function isAtOrAfter(a: string, b: string): boolean {
  return new Date(a).getTime() >= new Date(b).getTime();
}

/**
 * Members (excluding the viewer) whose watermark covers the message — the
 * "read by" set for ticks and the GROUP "Seen by N" line.
 */
export function readersOf<W extends { userId: string; lastReadAt: string }>(
  messageCreatedAt: string,
  watermarks: W[],
  viewerId: string
): W[] {
  return watermarks.filter(
    (w) => w.userId !== viewerId && isReadByWatermark(messageCreatedAt, w.lastReadAt)
  );
}

/**
 * receipt:update → patch the conversation-detail cache (drives the chat-view
 * ticks). Watermarks only move FORWARD: an out-of-order/stale event never
 * regresses an existing newer watermark.
 */
export function patchConversationReceipt(
  detail: ConversationDetail | undefined,
  userId: string,
  lastReadAt: string
): ConversationDetail | undefined {
  if (!detail) return detail;
  return {
    ...detail,
    members: detail.members.map((m) =>
      m.id === userId && !isAtOrAfter(m.lastReadAt, lastReadAt)
        ? { ...m, lastReadAt }
        : m
    ),
  };
}

/**
 * receipt:update → patch the inbox. The viewer's own receipt (echoed through
 * the conversation room) advances `myLastReadAt`; anyone else's advances
 * their member watermark ("seen by" data for the chat header/ticks).
 */
export function patchInboxReceipt(
  inbox: InboxConversation[] | undefined,
  conversationId: string,
  userId: string,
  lastReadAt: string,
  viewerId: string
): InboxConversation[] {
  if (!inbox) return inbox ?? [];
  return inbox.map((c) => {
    if (c.id !== conversationId) return c;
    return {
      ...c,
      myLastReadAt:
        userId === viewerId && !isAtOrAfter(c.myLastReadAt, lastReadAt)
          ? lastReadAt
          : c.myLastReadAt,
      members: c.members.map((m) =>
        m.id === userId && !isAtOrAfter(m.lastReadAt, lastReadAt)
          ? { ...m, lastReadAt }
          : m
      ),
    };
  });
}

/**
 * The viewer's own read ack — optimistic badge clear + watermark advance.
 * The server's unread:update {count: 0} to user:{id} confirms on every device.
 */
export function markInboxRead(
  inbox: InboxConversation[] | undefined,
  conversationId: string,
  viewerId: string,
  lastReadAt: string
): InboxConversation[] {
  if (!inbox) return inbox ?? [];
  return inbox.map((c) => {
    if (c.id !== conversationId) return c;
    return {
      ...c,
      unread: 0,
      myLastReadAt: isAtOrAfter(c.myLastReadAt, lastReadAt) ? c.myLastReadAt : lastReadAt,
      members: c.members.map((m) =>
        m.id === viewerId && !isAtOrAfter(m.lastReadAt, lastReadAt)
          ? { ...m, lastReadAt }
          : m
      ),
    };
  });
}

// ---------- Presence (Phase 7) ----------

/** presence:update → patch the inbox rows' live online flags. */
export function patchInboxPresence(
  inbox: InboxConversation[] | undefined,
  userId: string,
  online: boolean
): InboxConversation[] {
  if (!inbox) return inbox ?? [];
  return inbox.map((c) => ({
    ...c,
    members: c.members.map((m) => (m.id === userId ? { ...m, online } : m)),
  }));
}

// ---------- Badges & title (Phase 7) ----------

/**
 * Total unread for the document-title badge, recomputed from the inbox cache.
 * Muted conversations are excluded — muting means "don't surface this chat",
 * the row itself still shows its dot.
 */
export function totalUnread(inbox: InboxConversation[] | undefined): number {
  if (!inbox) return 0;
  return inbox.reduce((sum, c) => (c.isMuted ? sum : sum + c.unread), 0);
}

export type UnreadBadge = { kind: "none" } | { kind: "dot" } | { kind: "count"; count: number };

/**
 * Badge display per inbox row: a numeric pill normally, a bare dot for muted
 * conversations (count hidden but "something new" still visible), nothing at 0.
 */
export function unreadBadge(conv: Pick<InboxConversation, "unread" | "isMuted">): UnreadBadge {
  if (conv.unread <= 0) return { kind: "none" };
  return conv.isMuted ? { kind: "dot" } : { kind: "count", count: conv.unread };
}

// ---------- Message edit/delete (Phase 8 — REST + cache patch) ----------

/** Mirrors the server's EDIT_WINDOW_MS in PATCH /api/messages/[id]. */
export const EDIT_WINDOW_MS = 15 * 60_000;

/**
 * Edit permission (own TEXT, ≤15 min, not deleted/failed/in flight) — kept in
 * sync with the server-side checks; the server remains the authority.
 */
export function canEditMessage(
  m: Pick<ChatMessage, "senderId" | "type" | "deletedAt" | "createdAt" | "pending" | "failed">,
  viewerId: string,
  now = Date.now()
): boolean {
  if (m.senderId !== viewerId || m.type !== "TEXT") return false;
  if (m.deletedAt || m.pending || m.failed) return false;
  return now - new Date(m.createdAt).getTime() <= EDIT_WINDOW_MS;
}

/** Delete: sender or a GROUP owner (server enforces; UI mirrors for the menu). */
export function canDeleteMessage(
  m: Pick<ChatMessage, "senderId" | "deletedAt" | "pending">,
  viewerId: string,
  myRole: "OWNER" | "MEMBER"
): boolean {
  if (m.pending || m.deletedAt) return false;
  return m.senderId === viewerId || myRole === "OWNER";
}

/**
 * PATCH /api/messages/[id] success → patch the history cache. Also refreshes
 * the quoted snippet in any bubble replying to the edited message.
 */
export function patchMessageEdited(
  pages: MessagesPage[],
  messageId: string,
  body: string,
  editedAt: string
): MessagesPage[] {
  return pages.map((page) => ({
    ...page,
    messages: page.messages.map((m) => {
      if (m.id === messageId) return { ...m, body, editedAt };
      if (m.replyTo?.id === messageId) {
        return { ...m, replyTo: { ...m.replyTo, body } };
      }
      return m;
    }),
  }));
}

/** DELETE /api/messages/[id] success — flip the row to a tombstone in place. */
export function patchMessageDeleted(
  pages: MessagesPage[],
  messageId: string,
  deletedAt: string
): MessagesPage[] {
  return pages.map((page) => ({
    ...page,
    messages: page.messages.map((m) => (m.id === messageId ? { ...m, deletedAt } : m)),
  }));
}
