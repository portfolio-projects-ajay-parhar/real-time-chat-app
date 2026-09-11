/**
 * Unit — @chat/shared socket contract (Phase 10.1).
 *
 * The shared package is the cheapest defense against client/server payload
 * drift: both the ws server and the web app import THIS file. These tests
 * pin every schema's accept/reject boundary so a drift shows up in CI
 * before either side can ship it.
 */
import { describe, expect, it } from "vitest";
import {
  C2S,
  S2C,
  CONN,
  messageSendPayloadSchema,
  typingPayloadSchema,
  conversationReadPayloadSchema,
  apiErrorSchema,
  typingUpdateEventSchema,
  receiptUpdateEventSchema,
  presenceUpdateEventSchema,
  unreadUpdateEventSchema,
  AttachmentMimeValues,
  MessageTypeValues,
  type MessageSendPayload,
} from "../src/index.js";

const uuid = () => "3f2504e0-4f89-41d3-9a0c-0305e82c0001"; // stable non-v4-shaped? keep uuid-compliant

const textSend = (overrides: Partial<MessageSendPayload> = {}): Record<string, unknown> => ({
  conversationId: "c123",
  clientId: uuid(),
  type: "TEXT",
  body: "hello",
  ...overrides,
});

describe("C2S message:send schema", () => {
  it("accepts a valid TEXT message", () => {
    const parsed = messageSendPayloadSchema.parse(textSend());
    expect(parsed.type).toBe("TEXT");
    expect(parsed.body).toBe("hello");
  });

  it("accepts IMAGE and FILE with a full attachment", () => {
    const attachment = {
      key: "attachments/u1/abc123",
      name: "cat.png",
      size: 1024,
      mime: "image/png",
      width: 640,
      height: 480,
    };
    expect(() => messageSendPayloadSchema.parse(textSend({ type: "IMAGE", attachment }))).not.toThrow();
    expect(() =>
      messageSendPayloadSchema.parse(
        textSend({ type: "FILE", body: undefined, attachment: { ...attachment, mime: "application/pdf", name: "doc.pdf" } })
      )
    ).not.toThrow();
  });

  it("accepts a replyToId and strips unknown keys (never reach the server)", () => {
    const parsed = messageSendPayloadSchema.parse(
      Object.assign(textSend({ replyToId: "m1" }), { evil: "<script>" })
    ) as unknown as Record<string, unknown>;
    expect(parsed.replyToId).toBe("m1");
    expect(parsed.evil).toBeUndefined();
  });

  it.each([
    ["TEXT without a body", { body: undefined }],
    ["TEXT with empty body", { body: "" }],
    ["TEXT carrying an attachment", { attachment: { key: "k", name: "n", size: 1, mime: "image/png" } }],
    ["IMAGE without an attachment", { type: "IMAGE", body: undefined }],
    ["FILE without an attachment", { type: "FILE", body: undefined }],
    ["SYSTEM type (server-only)", { type: "SYSTEM", body: "x" }],
    ["missing clientId", { clientId: undefined }],
    ["non-uuid clientId", { clientId: "not-a-uuid" }],
    ["body over 4000 chars", { body: "x".repeat(4001) }],
    ["empty conversationId", { conversationId: "" }],
    [
      "oversize attachment (>10 MB)",
      { type: "IMAGE", body: undefined, attachment: { key: "k", name: "n", size: 10 * 1024 * 1024 + 1, mime: "image/png" } },
    ],
    [
      "negative attachment size",
      { type: "FILE", body: undefined, attachment: { key: "k", name: "n", size: -1, mime: "application/pdf" } },
    ],
    [
      "attachment mime off the allowlist",
      { type: "FILE", body: undefined, attachment: { key: "k", name: "n", size: 1, mime: "application/x-msdownload" } },
    ],
  ])("rejects %s", (_label, override) => {
    expect(messageSendPayloadSchema.safeParse(textSend(override)).success).toBe(false);
  });

  it("keeps the attachment mime allowlist in sync with the shared constant", () => {
    for (const mime of AttachmentMimeValues) {
      expect(
        messageSendPayloadSchema.safeParse(
          textSend({ type: "FILE", body: undefined, attachment: { key: "k", name: "n", size: 1, mime } })
        ).success
      ).toBe(true);
    }
    expect(AttachmentMimeValues).not.toContain("text/html");
  });
});

describe("C2S typing / read schemas", () => {
  it("accepts and rejects typing:start / typing:stop payloads", () => {
    expect(typingPayloadSchema.safeParse({ conversationId: "c1" }).success).toBe(true);
    expect(typingPayloadSchema.safeParse({}).success).toBe(false);
    expect(typingPayloadSchema.safeParse({ conversationId: "" }).success).toBe(false);
  });

  it("accepts and rejects conversation:read", () => {
    expect(conversationReadPayloadSchema.safeParse({ conversationId: "c1" }).success).toBe(true);
    expect(conversationReadPayloadSchema.safeParse({ conversationId: 42 }).success).toBe(false);
  });
});

describe("S2C event schemas", () => {
  it("typing:update requires conversationId + userIds array", () => {
    expect(typingUpdateEventSchema.safeParse({ conversationId: "c1", userIds: ["u1"] }).success).toBe(true);
    expect(typingUpdateEventSchema.safeParse({ conversationId: "c1" }).success).toBe(false);
    expect(typingUpdateEventSchema.safeParse({ conversationId: "c1", userIds: "u1" }).success).toBe(false);
  });

  it("receipt:update requires an ISO datetime lastReadAt", () => {
    const ok = { conversationId: "c1", userId: "u1", lastReadAt: new Date().toISOString() };
    const bad = { ...ok, lastReadAt: "yesterday" };
    expect(receiptUpdateEventSchema.safeParse(ok).success).toBe(true);
    expect(receiptUpdateEventSchema.safeParse(bad).success).toBe(false);
  });

  it("presence:update takes online|offline + optional lastSeenAt", () => {
    expect(presenceUpdateEventSchema.safeParse({ userId: "u1", status: "online" }).success).toBe(true);
    expect(
      presenceUpdateEventSchema.safeParse({ userId: "u1", status: "offline", lastSeenAt: new Date().toISOString() }).success
    ).toBe(true);
    expect(presenceUpdateEventSchema.safeParse({ userId: "u1", status: "away" }).success).toBe(false);
  });

  it("unread:update rejects negative and fractional counts", () => {
    expect(unreadUpdateEventSchema.safeParse({ conversationId: "c1", count: 0 }).success).toBe(true);
    expect(unreadUpdateEventSchema.safeParse({ conversationId: "c1", count: 7 }).success).toBe(true);
    expect(unreadUpdateEventSchema.safeParse({ conversationId: "c1", count: -1 }).success).toBe(false);
    expect(unreadUpdateEventSchema.safeParse({ conversationId: "c1", count: 1.5 }).success).toBe(false);
  });

  it("apiError covers every ApiErrorCode the server can ack with", () => {
    for (const code of [
      "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "VALIDATION",
      "RATE_LIMITED", "PAYLOAD_TOO_LARGE", "CONFLICT", "INTERNAL",
    ] as const) {
      expect(apiErrorSchema.safeParse({ ok: false, code, message: "m" }).success).toBe(true);
    }
    expect(apiErrorSchema.safeParse({ ok: true, code: "NOT_FOUND", message: "m" }).success).toBe(false);
    expect(apiErrorSchema.safeParse({ ok: false, code: "TEAPOT", message: "m" }).success).toBe(false);
  });
});

describe("event-name constants", () => {
  it("never collide between directions (a client emit must never look like a server push)", () => {
    const c2s = Object.values(C2S);
    const s2c = Object.values(S2C);
    expect(new Set([...c2s, ...s2c]).size).toBe(c2s.length + s2c.length);
  });

  it("uses the documented `domain:action` namespace for every event (connection-level `error` excepted)", () => {
    for (const name of [...Object.values(C2S), ...Object.values(S2C)]) {
      // S2C.ERROR is a connection-level channel, not a domain:action event
      expect(name === "error" || /^[a-z]+:[a-z-]+$/.test(name)).toBe(true);
    }
  });

  it("exposes the message lifecycle events the UI listens for", () => {
    expect(C2S.MESSAGE_SEND).toBe("message:send");
    expect(S2C.MESSAGE_NEW).toBe("message:new");
    expect(S2C.UNREAD_UPDATE).toBe("unread:update");
    expect(S2C.PRESENCE_UPDATE).toBe("presence:update");
    expect(S2C.RECEIPT_UPDATE).toBe("receipt:update");
    expect(MessageTypeValues).toEqual(["TEXT", "IMAGE", "FILE", "SYSTEM"]);
    expect(CONN.CONNECT).toBe("connect");
  });
});