/**
 * Unit — Phase 7 receipt/presence/badge logic: watermark read/unread math,
 * forward-only receipt patches, optimistic read ack, presence patch, title
 * badge + muted dot reducers. Pure functions, no React or sockets.
 */
import { describe, expect, it } from "vitest";
import {
  isAtOrAfter,
  isReadByWatermark,
  markInboxRead,
  patchConversationReceipt,
  patchInboxPresence,
  patchInboxReceipt,
  readersOf,
  totalUnread,
  unreadBadge,
  type ConversationDetail,
  type InboxConversation,
} from "../src/lib/chat-cache";

const T = (iso: string) => new Date(iso).toISOString();

const detail = (over: Partial<ConversationDetail> = {}): ConversationDetail => ({
  id: "c1",
  type: "DIRECT",
  name: null,
  avatarKey: null,
  createdById: "me",
  lastMessageAt: T("2026-01-01T00:00:00Z"),
  members: [
    {
      id: "me",
      role: "MEMBER",
      lastReadAt: T("2026-01-01T00:00:00Z"),
      isMuted: false,
      user: { id: "me", name: "Me", image: null, bio: null, lastSeenAt: T("2026-01-01T00:00:00Z") },
    },
    {
      id: "u2",
      role: "MEMBER",
      lastReadAt: T("2026-01-01T00:00:00Z"),
      isMuted: false,
      user: { id: "u2", name: "Bob", image: null, bio: null, lastSeenAt: T("2026-01-01T00:00:00Z") },
    },
  ],
  ...over,
});

const conv = (over: Partial<InboxConversation> = {}): InboxConversation => ({
  id: over.id ?? "c1",
  type: "DIRECT",
  name: null,
  avatarKey: null,
  createdById: "someone",
  lastMessageAt: T("2026-01-01T00:00:00Z"),
  myRole: "MEMBER",
  myLastReadAt: T("2026-01-01T00:00:00Z"),
  isMuted: over.isMuted ?? false,
  unread: over.unread ?? 0,
  members: [
    {
      id: "me",
      role: "MEMBER",
      lastReadAt: T("2026-01-01T00:00:00Z"),
      isMuted: false,
      user: { id: "me", name: "Me", image: null, bio: null },
      online: false,
    },
    {
      id: "u2",
      role: "MEMBER",
      lastReadAt: T("2026-01-01T00:00:00Z"),
      isMuted: false,
      user: { id: "u2", name: "Bob", image: null, bio: null },
      online: false,
    },
  ],
  lastMessage: null,
});

describe("watermark math", () => {
  const marks = [
    // [message createdAt, member lastReadAt, expected read]
    ["2026-01-01T00:00:05Z", "2026-01-01T00:00:10Z", true], // read after
    ["2026-01-01T00:00:10Z", "2026-01-01T00:00:10Z", true], // equality boundary → read
    ["2026-01-01T00:00:11Z", "2026-01-01T00:00:10Z", false], // newer than watermark
    ["2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", true],
    ["2026-01-02T00:00:00Z", "2026-01-01T00:05:00Z", false],
  ] as const;

  it.each(marks)("createdAt %s ≤ lastReadAt %s → %s", (createdAt, lastReadAt, expected) => {
    expect(isReadByWatermark(createdAt, lastReadAt)).toBe(expected);
  });

  it("excludes the viewer from the readers set", () => {
    const watermarks = [
      { userId: "me", lastReadAt: T("2026-01-01T01:00:00Z") }, // self — ignored
      { userId: "u2", lastReadAt: T("2026-01-01T00:30:00Z") },
    ];
    const readers = readersOf(T("2026-01-01T00:00:00Z"), watermarks, "me");
    expect(readers.map((r) => r.userId)).toEqual(["u2"]);
  });

  it("isAtOrAfter orders watermarks vs newest message", () => {
    expect(isAtOrAfter(T("2026-01-01T00:00:00Z"), T("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isAtOrAfter(T("2026-01-01T00:00:01Z"), T("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isAtOrAfter(T("2026-01-01T00:00:00Z"), T("2026-01-01T00:00:01Z"))).toBe(false);
  });
});

describe("patchConversationReceipt", () => {
  it("advances the member's watermark", () => {
    const next = patchConversationReceipt(detail(), "u2", T("2026-01-01T01:00:00Z"));
    expect(next?.members.find((m) => m.id === "u2")?.lastReadAt).toBe(T("2026-01-01T01:00:00Z"));
    expect(next?.members.find((m) => m.id === "me")?.lastReadAt).toBe(T("2026-01-01T00:00:00Z"));
  });

  it("never regresses a newer watermark (out-of-order event)", () => {
    const d = detail();
    const advanced = patchConversationReceipt(d, "u2", T("2026-01-02T00:00:00Z"));
    const stale = patchConversationReceipt(advanced, "u2", T("2026-01-01T05:00:00Z"));
    expect(stale?.members.find((m) => m.id === "u2")?.lastReadAt).toBe(T("2026-01-02T00:00:00Z"));
  });

  it("is a no-op for unknown members and missing cache", () => {
    const d = detail();
    expect(patchConversationReceipt(d, "stranger", T("2026-01-02T00:00:00Z"))).toEqual(d);
    expect(patchConversationReceipt(undefined, "u2", T("2026-01-02T00:00:00Z"))).toBeUndefined();
  });
});
describe("patchInboxReceipt", () => {
  it("advances another member's watermark only", () => {
    const next = patchInboxReceipt([conv()], "c1", "u2", T("2026-01-01T02:00:00Z"), "me");
    expect(next[0].members.find((m) => m.id === "u2")?.lastReadAt).toBe(T("2026-01-01T02:00:00Z"));
    expect(next[0].myLastReadAt).toBe(T("2026-01-01T00:00:00Z"));
  });

  it("advances myLastReadAt (and my member row) on my own receipt echo", () => {
    const next = patchInboxReceipt([conv()], "c1", "me", T("2026-01-01T02:00:00Z"), "me");
    expect(next[0].myLastReadAt).toBe(T("2026-01-01T02:00:00Z"));
    expect(next[0].members.find((m) => m.id === "me")?.lastReadAt).toBe(T("2026-01-01T02:00:00Z"));
  });

  it("ignores other conversations and undefined caches", () => {
    expect(patchInboxReceipt([conv()], "other", "u2", T("2026-01-01T02:00:00Z"), "me")[0]).toEqual(conv());
    expect(patchInboxReceipt(undefined, "c1", "u2", T("2026-01-01T02:00:00Z"), "me")).toEqual([]);
  });
});

describe("markInboxRead (optimistic read ack)", () => {
  it("clears the badge and advances my watermark + member row", () => {
    const c = conv({ unread: 5 });
    const next = markInboxRead([c], "c1", "me", T("2026-01-01T03:00:00Z"));
    expect(next[0].unread).toBe(0);
    expect(next[0].myLastReadAt).toBe(T("2026-01-01T03:00:00Z"));
    expect(next[0].members.find((m) => m.id === "me")?.lastReadAt).toBe(T("2026-01-01T03:00:00Z"));
  });

  it("keeps a newer existing watermark", () => {
    const c = { ...conv({ unread: 5 }), myLastReadAt: T("2026-01-01T09:00:00Z") };
    const next = markInboxRead([c], "c1", "me", T("2026-01-01T03:00:00Z"));
    expect(next[0].myLastReadAt).toBe(T("2026-01-01T09:00:00Z"));
    expect(next[0].unread).toBe(0);
  });
});

describe("patchInboxPresence", () => {
  it("flips the member's online flag across all their rows", () => {
    const c1 = conv({ id: "c1" });
    const c2 = conv({ id: "c2" });
    const next = patchInboxPresence([c1, c2], "u2", true);
    expect(next.map((c) => c.members.find((m) => m.id === "u2")?.online)).toEqual([true, true]);
    expect(next[0].members.find((m) => m.id === "me")?.online).toBe(false);
  });
});

describe("badge + title reducers", () => {
  it("totalUnread sums non-muted conversations (the title badge)", () => {
    const inbox = [
      conv({ id: "a", unread: 3 }),
      conv({ id: "b", unread: 2, isMuted: true }),
      conv({ id: "c", unread: 0 }),
    ];
    expect(totalUnread(inbox)).toBe(3);
    expect(totalUnread(undefined)).toBe(0);
  });

  it("unreadBadge: count normally, dot when muted, none at zero", () => {
    expect(unreadBadge({ unread: 4, isMuted: false })).toEqual({ kind: "count", count: 4 });
    expect(unreadBadge({ unread: 120, isMuted: false })).toEqual({ kind: "count", count: 120 });
    expect(unreadBadge({ unread: 4, isMuted: true })).toEqual({ kind: "dot" });
    expect(unreadBadge({ unread: 0, isMuted: false })).toEqual({ kind: "none" });
    expect(unreadBadge({ unread: 0, isMuted: true })).toEqual({ kind: "none" });
  });
});