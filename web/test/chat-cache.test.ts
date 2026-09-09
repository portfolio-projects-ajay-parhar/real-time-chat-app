/**
 * Unit — chat cache reducers (web/src/lib/chat-cache.ts) and the typing
 * store (web/src/lib/typing-store.ts). Pure logic, no React rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@chat/shared";
import {
  appendChatMessage,
  markMessageFailed,
  mergeBackfill,
  patchInboxAfterMessage,
  patchInboxUnread,
  type InboxConversation,
  type MessagesPage,
} from "../src/lib/chat-cache";
import {
  applyTypingUpdate,
  resetTypingStore,
  subscribe,
} from "../src/lib/typing-store";

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: over.id ?? crypto.randomUUID(),
  conversationId: over.conversationId ?? "c1",
  senderId: over.senderId ?? "u2",
  type: over.type ?? "TEXT",
  body: over.body ?? "hello",
  attachmentKey: null,
  attachmentName: null,
  attachmentSize: null,
  attachmentMime: null,
  attachmentWidth: null,
  attachmentHeight: null,
  clientId: over.clientId ?? null,
  replyToId: null,
  replyTo: null,
  createdAt: over.createdAt ?? new Date("2026-01-01T00:00:00Z").toISOString(),
  editedAt: null,
  deletedAt: null,
  sender: over.sender ?? null,
  pending: over.pending,
  failed: over.failed,
});

const VIEWER = "me";

const conv = (over: Partial<InboxConversation> = {}): InboxConversation => ({
  id: over.id ?? "c1",
  type: "DIRECT",
  name: null,
  avatarKey: null,
  createdById: "someone",
  lastMessageAt: over.lastMessageAt ?? new Date("2026-01-01T00:00:00Z").toISOString(),
  myRole: "MEMBER",
  myLastReadAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  isMuted: false,
  unread: over.unread ?? 0,
  members: [],
  lastMessage: over.lastMessage ?? null,
});

describe("appendChatMessage", () => {
  it("appends in chronological order", () => {
    const a = msg({ createdAt: "2026-01-01T00:00:00Z" });
    const b = msg({ createdAt: "2026-01-01T00:01:00Z" });
    const result = appendChatMessage([b], a);
    expect(result.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("swaps a pending optimistic bubble by clientId on ack", () => {
    const clientId = crypto.randomUUID();
    const pending = msg({ id: `pending:${clientId}`, clientId, pending: true, body: "hi" });
    const persisted = msg({ clientId, body: "hi" }); // real row, different id

    const result = appendChatMessage([pending], persisted);
    expect(result).toHaveLength(1);
    expect(result[0].id).not.toBe(`pending:${clientId}`);
    expect(result[0].pending).toBeUndefined();
  });

  it("dedupes the message:new echo (same id already present)", () => {
    const existing = msg({ body: "hi" });
    const echo = { ...existing }; // same id, fresh object
    const result = appendChatMessage([existing], echo);
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("hi");
  });

  it("handles an empty/undefined list", () => {
    const m = msg();
    expect(appendChatMessage(undefined, m)).toEqual([m]);
  });
});

describe("markMessageFailed", () => {
  it("flips the optimistic bubble to failed and clears pending", () => {
    const clientId = crypto.randomUUID();
    const pending = msg({ id: `pending:${clientId}`, clientId, pending: true });
    const result = markMessageFailed([pending], clientId);
    expect(result[0].pending).toBe(false);
    expect(result[0].failed).toBe(true);
  });

  it("is a no-op for unknown clientIds", () => {
    const other = msg();
    expect(markMessageFailed([other], "nope")).toEqual([other]);
  });
});

describe("mergeBackfill", () => {
  it("merges the reconnect gap into the last page, deduped and sorted", () => {
    const alreadyCached = msg({ createdAt: "2026-01-01T00:02:00Z" });
    const older = msg({ createdAt: "2026-01-01T00:00:00Z" });
    const cached: MessagesPage[] = [
      { messages: [msg({ createdAt: "2026-01-01T00:05:00Z" })], nextCursor: null },
      { messages: [alreadyCached], nextCursor: null },
    ];
    // the gap batch re-includes the boundary message (after= is strictly
    // greater, but a dedupe-safe merge must not care)
    const result = mergeBackfill(cached, [older, alreadyCached]);
    expect(result).toHaveLength(2);
    expect(result[1].messages.map((m) => m.createdAt)).toEqual([
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:02:00Z",
    ]);
  });

  it("returns pages untouched for an empty gap", () => {
    const pages: MessagesPage[] = [{ messages: [], nextCursor: null }];
    expect(mergeBackfill(pages, [])).toBe(pages);
  });
});

describe("patchInboxAfterMessage", () => {
  it("updates preview, bumps unread for others, and moves the row to the top", () => {
    const c1 = conv({ id: "c1", unread: 2 });
    const c2 = conv({ id: "c2" });
    const incoming = msg({
      conversationId: "c2",
      senderId: "u2",
      createdAt: "2026-01-02T00:00:00Z",
    });

    const result = patchInboxAfterMessage([c1, c2], incoming, VIEWER);
    expect(result[0].id).toBe("c2"); // recency ordering
    expect(result[0].unread).toBe(1);
    expect(result[0].lastMessage?.body).toBe("hello");
    expect(result[1].id).toBe("c1");
  });

  it("does not bump unread for the viewer's own message", () => {
    const c1 = conv({ id: "c1", unread: 3 });
    const own = msg({ senderId: VIEWER, createdAt: "2026-01-02T00:00:00Z" });
    const result = patchInboxAfterMessage([c1], own, VIEWER);
    expect(result[0].unread).toBe(3);
  });

  it("ignores conversations missing from the cache", () => {
    const c1 = conv({ id: "c1" });
    const result = patchInboxAfterMessage([c1], msg({ conversationId: "unknown" }), VIEWER);
    expect(result).toEqual([c1]);
  });
});

describe("patchInboxUnread", () => {
  it("overwrites the count from the authoritative push", () => {
    const c1 = conv({ id: "c1", unread: 2 });
    expect(patchInboxUnread([c1], "c1", 7)[0].unread).toBe(7);
    expect(patchInboxUnread([c1], "other", 5)[0].unread).toBe(2);
  });

  it("can clear a badge to zero", () => {
    const c1 = conv({ id: "c1", unread: 4 });
    expect(patchInboxUnread([c1], "c1", 0)[0].unread).toBe(0);
  });
});

describe("typing store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTypingStore();
  });
  afterEach(() => vi.useRealTimers());

  it("adds users on typing:update and evicts them after 4 s of silence", () => {
    const snapshots: Record<string, string[]>[] = [];
    const unsub = subscribe((s) => snapshots.push(structuredClone(s)));

    applyTypingUpdate("c1", ["u1"]);
    expect(snapshots[snapshots.length - 1]["c1"]).toEqual(["u1"]);

    // refresh before the TTL — continuous typing stays visible
    vi.advanceTimersByTime(2000);
    applyTypingUpdate("c1", ["u1"]);
    vi.advanceTimersByTime(3000);
    expect(snapshots[snapshots.length - 1]["c1"]).toEqual(["u1"]);

    // silence past the TTL → evicted (the snapshot drops fully-expired
    // conversations entirely; the hook maps a missing key to [])
    vi.advanceTimersByTime(1500);
    expect(snapshots[snapshots.length - 1]["c1"] ?? []).toEqual([]);

    unsub();
  });

  it("tracks conversations independently", () => {
    applyTypingUpdate("c1", ["u1"]);
    applyTypingUpdate("c2", ["u2"]);

    const snap: Record<string, string[]> = {};
    const unsub = subscribe((s) => Object.assign(snap, s));

    applyTypingUpdate("c1", ["u9"]);
    expect(snap["c1"]).toEqual(["u1", "u9"]);
    expect(snap["c2"]).toEqual(["u2"]);
    unsub();
  });

  it("ignores empty updates", () => {
    let calls = 0;
    const unsub = subscribe(() => calls++);
    applyTypingUpdate("c1", []);
    expect(calls).toBe(0);
    unsub();
  });
});