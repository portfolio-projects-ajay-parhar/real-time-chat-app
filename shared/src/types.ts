// ---------- Enums mirrored in prisma/schema.prisma ----------
export const ConversationTypeValues = ["DIRECT", "GROUP"] as const;
export const MemberRoleValues = ["OWNER", "MEMBER"] as const;
export const MessageTypeValues = ["TEXT", "IMAGE", "FILE", "SYSTEM"] as const;

/**
 * Attachment MIME allowlist — the ONE source of truth used by the REST
 * upload route, the client-side pre-check and the ws send handler
 * (defense in depth, PLAN §security).
 */
export const AttachmentMimeValues = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
] as const;
export type AttachmentMime = (typeof AttachmentMimeValues)[number];

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

// ---------- Serialized chat entities (REST + socket payloads share these) ----------
/**
 * The "user card" as it crosses the wire — Prisma Dates become ISO strings
 * under JSON serialization (REST) and socket.io packet encoding (ws), so both
 * sides see identical shapes.
 */
export interface ChatUser {
  id: string;
  name: string;
  image: string | null;
  bio: string | null;
  lastSeenAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string | null; // null → SYSTEM
  type: MessageType;
  body: string | null;
  attachmentKey: string | null;
  attachmentName: string | null;
  attachmentSize: number | null;
  attachmentMime: string | null;
  attachmentWidth: number | null;
  attachmentHeight: number | null;
  clientId: string | null;
  replyToId: string | null;
  replyTo: {
    id: string;
    type: MessageType;
    body: string | null;
    senderId: string | null;
    sender: ChatUser | null;
  } | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  sender: ChatUser | null;
  // Client-side-only transport states (never set by the server):
  pending?: boolean; // optimistic bubble awaiting ack
  failed?: boolean; // ack returned an error / send dropped
}

// ---------- Ack shapes ----------
export type AckError = ApiErrorPayload;
export type MessageSendAck = { ok: true; message: ChatMessage } | AckError;
export type ConversationReadAck = { ok: true; lastReadAt: string } | AckError;
