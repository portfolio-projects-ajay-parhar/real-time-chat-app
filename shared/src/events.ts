/**
 * Socket event-name constants — the single source of truth for both the
 * web client and the ws server. Never hardcode an event name string.
 */

// ---------- Client → Server ----------
export const C2S = {
  MESSAGE_SEND: "message:send",
  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
  CONVERSATION_READ: "conversation:read",
} as const;

// ---------- Server → Client ----------
export const S2C = {
  MESSAGE_NEW: "message:new",
  MESSAGE_EDITED: "message:edited",
  MESSAGE_DELETED: "message:deleted",
  TYPING_UPDATE: "typing:update",
  RECEIPT_UPDATE: "receipt:update",
  PRESENCE_UPDATE: "presence:update",
  UNREAD_UPDATE: "unread:update",
  CONVERSATION_NEW: "conversation:new",
  CONVERSATION_UPDATED: "conversation:updated",
  MEMBER_JOINED: "member:joined",
  MEMBER_LEFT: "member:left",
  ERROR: "error",
} as const;

// ---------- Connection-level ----------
export const CONN = {
  CONNECT: "connect",
  DISCONNECT: "disconnect",
  CONNECT_ERROR: "connect_error",
} as const;
