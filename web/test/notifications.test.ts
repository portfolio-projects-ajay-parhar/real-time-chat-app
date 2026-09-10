import { describe, it, expect } from "vitest";
import { notificationBody, shouldNotify } from "@/lib/notifications";
import type { ChatMessage } from "@chat/shared";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    conversationId: "conv1",
    senderId: "bob",
    type: "TEXT",
    body: "hello there",
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
    ...overrides,
  };
}

const base = {
  message: message(),
  viewerId: "me",
  activeConversationId: null,
  hidden: false,
  permission: "granted" as const,
};

describe("shouldNotify", () => {
  it("notifies when the tab is hidden", () => {
    expect(shouldNotify({ ...base, hidden: true })).toBe(true);
  });

  it("notifies for a background conversation in a visible tab", () => {
    expect(shouldNotify({ ...base, activeConversationId: "other-conv" })).toBe(true);
  });

  it("stays silent when the conversation is the active route and the tab is visible", () => {
    expect(shouldNotify({ ...base, activeConversationId: "conv1" })).toBe(false);
  });

  it("never notifies for one's own messages", () => {
    expect(
      shouldNotify({ ...base, message: message({ senderId: "me" }), hidden: true })
    ).toBe(false);
  });

  it("never notifies a muted conversation (badge dot only)", () => {
    expect(shouldNotify({ ...base, isMuted: true, hidden: true })).toBe(false);
  });

  it("requires granted permission", () => {
    expect(shouldNotify({ ...base, permission: "default", hidden: true })).toBe(false);
    expect(shouldNotify({ ...base, permission: "denied", hidden: true })).toBe(false);
    expect(shouldNotify({ ...base, permission: "unsupported", hidden: true })).toBe(false);
  });

  it("visible tab + no active conversation (inbox) still notifies", () => {
    expect(shouldNotify({ ...base, hidden: false, activeConversationId: null })).toBe(true);
  });
});

describe("notificationBody", () => {
  it("uses the body for text", () => {
    expect(notificationBody(message())).toBe("hello there");
  });

  it("describes images with and without captions", () => {
    expect(notificationBody(message({ type: "IMAGE", body: "look!" }))).toBe("📷 look!");
    expect(notificationBody(message({ type: "IMAGE", body: null }))).toBe("📷 Photo");
  });

  it("uses the attachment name for files", () => {
    expect(
      notificationBody(message({ type: "FILE", body: null, attachmentName: "report.pdf" }))
    ).toBe("📎 report.pdf");
    expect(notificationBody(message({ type: "FILE", body: null, attachmentName: null }))).toBe(
      "📎 File"
    );
  });
});