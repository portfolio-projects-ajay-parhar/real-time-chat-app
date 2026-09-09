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