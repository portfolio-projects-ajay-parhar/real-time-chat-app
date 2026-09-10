import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@chat/shared";
import {
  canDeleteMessage,
  canEditMessage,
  patchMessageDeleted,
  patchMessageEdited,
  type MessagesPage,
} from "../src/lib/chat-cache";

const baseMessage = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "m1",
  conversationId: "c1",
  senderId: "alice",
  type: "TEXT",
  body: "hello",
  attachmentKey: null,
  attachmentName: null,
  attachmentSize: null,
  attachmentMime: null,
  attachmentWidth: null,
  attachmentHeight: null,
  clientId: null,
  replyToId: null,
  replyTo: null,
  createdAt: new Date().toISOString(),
  editedAt: null,
  deletedAt: null,
  sender: null,
  ...over,
});

const page = (messages: ChatMessage[]): MessagesPage[] => [{ messages, nextCursor: null }];

describe("canEditMessage (own TEXT, ≤15 min)", () => {
  const now = Date.now();
  const fresh = baseMessage({ senderId: "alice", type: "TEXT", createdAt: new Date(now - 60_000).toISOString() });

  it("own recent TEXT is editable", () => {
    expect(canEditMessage(fresh, "alice", now)).toBe(true);
  });

  it("someone else's message is not", () => {
    expect(canEditMessage(fresh, "bob", now)).toBe(false);
  });

  it("past the 15-minute window is not", () => {
    const old = baseMessage({ senderId: "alice", createdAt: new Date(now - 15 * 60_000 - 1).toISOString() });
    expect(canEditMessage(old, "alice", now)).toBe(false);
  });

  it("boundary: exactly 15 minutes is still editable", () => {
    const edge = baseMessage({ senderId: "alice", createdAt: new Date(now - 15 * 60_000).toISOString() });
    expect(canEditMessage(edge, "alice", now)).toBe(true);
  });

  it("IMAGE/FILE/SYSTEM and deleted/pending/failed are not", () => {
    expect(canEditMessage(baseMessage({ type: "IMAGE" }), "alice", now)).toBe(false);
    expect(canEditMessage(baseMessage({ deletedAt: new Date().toISOString() }), "alice", now)).toBe(false);
    expect(canEditMessage(baseMessage({ pending: true }), "alice", now)).toBe(false);
    expect(canEditMessage(baseMessage({ failed: true }), "alice", now)).toBe(false);
  });
});

describe("canDeleteMessage (sender or OWNER)", () => {
  const now = Date.now();
  const msg = baseMessage({ senderId: "alice", createdAt: new Date(now).toISOString() });

  it("sender can delete; a MEMBER who isn't the sender cannot", () => {
    expect(canDeleteMessage(msg, "alice", "MEMBER")).toBe(true);
    expect(canDeleteMessage(msg, "bob", "MEMBER")).toBe(false);
  });

  it("a GROUP owner can delete anyone's message", () => {
    expect(canDeleteMessage(msg, "carol", "OWNER")).toBe(true);
  });

  it("deleted or pending messages cannot be deleted again", () => {
    expect(canDeleteMessage(baseMessage({ deletedAt: new Date().toISOString() }), "alice", "MEMBER")).toBe(false);
    expect(canDeleteMessage(baseMessage({ pending: true }), "alice", "MEMBER")).toBe(false);
  });
});

describe("patchMessageEdited", () => {
  it("patches the target and refreshes reply quotes across pages", () => {
    const target = baseMessage({ id: "m1" });
    const quoter = baseMessage({
      id: "m2",
      replyToId: "m1",
      replyTo: { id: "m1", type: "TEXT", body: "old", senderId: "alice", sender: null },
    });
    const pages: MessagesPage[] = [
      { messages: [baseMessage({ id: "m0" })], nextCursor: "c" },
      { messages: [target, quoter], nextCursor: null },
    ];
    const edited = patchMessageEdited(pages, "m1", "new body", "2026-09-10T12:00:00Z");
    expect(edited[1].messages[0].body).toBe("new body");
    expect(edited[1].messages[0].editedAt).toBe("2026-09-10T12:00:00Z");
    expect(edited[0].messages[0].body).toBe("hello"); // other pages untouched
    expect(edited[1].messages[1].replyTo?.body).toBe("new body"); // quote refreshed
  });
});

describe("patchMessageDeleted", () => {
  it("flips exactly the target row to a tombstone", () => {
    const at = "2026-09-10T12:00:00Z";
    const pages = page([baseMessage({ id: "m1" }), baseMessage({ id: "m2" })]);
    const result = patchMessageDeleted(pages, "m1", at);
    expect(result[0].messages[0].deletedAt).toBe(at);
    expect(result[0].messages[1].deletedAt).toBeNull();
  });

  it("is a no-op for unknown ids", () => {
    const pages = page([baseMessage({ id: "m1" })]);
    expect(patchMessageDeleted(pages, "nope", "2026-09-10T12:00:00Z")[0].messages[0].deletedAt).toBeNull();
  });
});
