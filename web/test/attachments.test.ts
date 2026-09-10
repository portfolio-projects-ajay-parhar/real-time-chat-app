import { describe, it, expect } from "vitest";
import { checkAttachment, humanizeSize } from "@/lib/attachment";
import { attachToOptimistic, removeChatMessage, type MessagesPage } from "@/lib/chat-cache";
import type { ChatMessage } from "@chat/shared";

function textMessage(clientId: string): ChatMessage {
  return {
    id: `pending:${clientId}`,
    conversationId: "c1",
    senderId: "me",
    type: "IMAGE",
    body: null,
    attachmentKey: null,
    attachmentName: null,
    attachmentSize: null,
    attachmentMime: null,
    attachmentWidth: null,
    attachmentHeight: null,
    clientId,
    replyToId: null,
    replyTo: null,
    createdAt: new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
    sender: null,
    pending: true,
  };
}

describe("checkAttachment — client-side pre-upload gate", () => {
  const file = (mime: string, name = "f") => new File(["x"], name, { type: mime });

  it("routes images and non-images to their message types", () => {
    expect(checkAttachment(file("image/png"))).toEqual({ ok: true, kind: "IMAGE" });
    expect(checkAttachment(file("image/webp"))).toEqual({ ok: true, kind: "IMAGE" });
    expect(checkAttachment(file("application/pdf"))).toEqual({ ok: true, kind: "FILE" });
    expect(checkAttachment(file("text/plain"))).toEqual({ ok: true, kind: "FILE" });
  });

  it("rejects oversize with 413 before any upload", () => {
    const big = file("image/png");
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    expect(checkAttachment(big)).toMatchObject({
      ok: false,
      status: 413,
      message: "Files may be at most 10 MB",
    });
  });

  it("rejects empty files and unknown mimes with 415", () => {
    const empty = file("image/png");
    Object.defineProperty(empty, "size", { value: 0 });
    expect(checkAttachment(empty)).toMatchObject({ ok: false, status: 415 });

    expect(checkAttachment(file("application/zip"))).toEqual({
      ok: false,
      status: 415,
      message: "File type application/zip is not allowed",
    });
    expect(checkAttachment(file("image/svg+xml"))).toMatchObject({ ok: false, status: 415 });
  });
});

describe("humanizeSize", () => {
  it("formats B/KB/MB", () => {
    expect(humanizeSize(3)).toBe("3 B");
    expect(humanizeSize(1024)).toBe("1.0 KB");
    expect(humanizeSize(1536)).toBe("1.5 KB");
    expect(humanizeSize(20 * 1024)).toBe("20 KB");
    expect(humanizeSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});

describe("attachment cache reducers", () => {
  it("attachToOptimistic patches the pending bubble by clientId", () => {
    const pages: MessagesPage[] = [
      { messages: [], nextCursor: "old" },
      { messages: [textMessage("abc")], nextCursor: null },
    ];
    const updated = attachToOptimistic(pages[1].messages, "abc", {
      key: "attachments/me/k1-photo.png",
      name: "photo.png",
      size: 123,
      mime: "image/png",
      width: 800,
      height: 600,
    });
    expect(updated[0]).toMatchObject({
      attachmentKey: "attachments/me/k1-photo.png",
      attachmentName: "photo.png",
      attachmentWidth: 800,
      attachmentHeight: 600,
      pending: true,
    });
  });

  it("attachToOptimistic ignores unknown clientIds (no-op)", () => {
    const list = [textMessage("abc")];
    expect(attachToOptimistic(list, "nope", { key: "k", name: "n", size: 1, mime: "image/png" })).toBe(list);
  });

  it("removeChatMessage drops the failed-upload bubble and keeps the rest", () => {
    const list = [textMessage("a"), textMessage("b"), textMessage("c")];
    const next = removeChatMessage(list, "b");
    expect(next.map((m) => m.clientId)).toEqual(["a", "c"]);
    expect(list).toHaveLength(3); // original untouched (pure)
  });

  it("removeChatMessage is a no-op on unknown clientId", () => {
    const list = [textMessage("a")];
    expect(removeChatMessage(list, "zzz")).toBe(list);
  });
});