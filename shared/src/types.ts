// ---------- Enums mirrored in prisma/schema.prisma ----------
export const ConversationTypeValues = ["DIRECT", "GROUP"] as const;
export const MemberRoleValues = ["OWNER", "MEMBER"] as const;
export const MessageTypeValues = ["TEXT", "IMAGE", "FILE", "SYSTEM"] as const;

export type ConversationType = (typeof ConversationTypeValues)[number];
export type MemberRole = (typeof MemberRoleValues)[number];
export type MessageType = (typeof MessageTypeValues)[number];

// ---------- API error ----------
export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "CONFLICT"
  | "INTERNAL";

export interface ApiErrorPayload {
  ok: false;
  code: ApiErrorCode;
  message: string;
}

// ---------- Socket payload types (inferred from zod schemas) ----------
import type { z } from "zod";
import type {
  messageSendPayloadSchema,
  typingPayloadSchema,
  conversationReadPayloadSchema,
  attachmentSchema,
  typingUpdateEventSchema,
  receiptUpdateEventSchema,
  presenceUpdateEventSchema,
  unreadUpdateEventSchema,
} from "./schemas.js";

export type MessageSendPayload = z.infer<typeof messageSendPayloadSchema>;
export type TypingPayload = z.infer<typeof typingPayloadSchema>;
export type ConversationReadPayload = z.infer<typeof conversationReadPayloadSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;

export type TypingUpdateEvent = z.infer<typeof typingUpdateEventSchema>;
export type ReceiptUpdateEvent = z.infer<typeof receiptUpdateEventSchema>;
export type PresenceUpdateEvent = z.infer<typeof presenceUpdateEventSchema>;
export type UnreadUpdateEvent = z.infer<typeof unreadUpdateEventSchema>;

// Ack shapes
export type AckError = ApiErrorPayload;
export type MessageSendAck =
  | { ok: true; message: unknown }
  | AckError;
export type ConversationReadAck =
  | { ok: true; lastReadAt: string }
  | AckError;
