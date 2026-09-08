import { z } from "zod";
import { MessageTypeValues } from "./types.js";

// ---------- Shared primitives ----------
export const conversationIdSchema = z.string().min(1).max(64);
export const clientIdSchema = z.string().uuid();
export const messageBodySchema = z.string().min(1).max(4000);

export const attachmentSchema = z.object({
  key: z.string().min(1).max(512),
  name: z.string().min(1).max(255),
  size: z.number().int().positive().max(10 * 1024 * 1024),
  mime: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain"]),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

// ---------- Client → Server payloads ----------
export const messageSendPayloadSchema = z
  .object({
    conversationId: conversationIdSchema,
    clientId: clientIdSchema,
    type: z.enum(MessageTypeValues).exclude(["SYSTEM"]),
    body: messageBodySchema.optional(),
    attachment: attachmentSchema.optional(),
    replyToId: z.string().min(1).max(64).optional(),
  })
  .refine(
    (v) =>
      v.type === "TEXT" ? !!v.body && !v.attachment : true,
    { message: "TEXT messages require a body" }
  )
  .refine(
    (v) =>
      v.type === "IMAGE" || v.type === "FILE" ? !!v.attachment : true,
    { message: "IMAGE/FILE messages require an attachment" }
  );

export const typingPayloadSchema = z.object({
  conversationId: conversationIdSchema,
});

export const conversationReadPayloadSchema = z.object({
  conversationId: conversationIdSchema,
});

// ---------- Server → Client payloads ----------
export const apiErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum([
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "VALIDATION",
    "RATE_LIMITED",
    "PAYLOAD_TOO_LARGE",
    "CONFLICT",
    "INTERNAL",
  ]),
  message: z.string(),
});

export const messageNewEventSchema = z.object({
  message: z.any(), // serialized Message w/ sender + replyTo — shaped by the server
});

export const typingUpdateEventSchema = z.object({
  conversationId: conversationIdSchema,
  userIds: z.array(z.string()),
});

export const receiptUpdateEventSchema = z.object({
  conversationId: conversationIdSchema,
  userId: z.string(),
  lastReadAt: z.string().datetime(),
});

export const presenceUpdateEventSchema = z.object({
  userId: z.string(),
  status: z.enum(["online", "offline"]),
  lastSeenAt: z.string().datetime().optional(),
});

export const unreadUpdateEventSchema = z.object({
  conversationId: conversationIdSchema,
  count: z.number().int().nonnegative(),
});

export const conversationNewEventSchema = z.object({
  conversation: z.any(), // serialized Conversation w/ members
});
