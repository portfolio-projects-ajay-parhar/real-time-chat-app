import type { ChatMessage } from "@chat/shared";

/**
 * Notification decision logic (Phase 9.1) — pure and unit-testable; the hook
 * only wires socket events, the DOM Notification API and navigation around it.
 */

export type NotificationPermission = "default" | "granted" | "denied" | "unsupported";

export interface NotifyDecisionInput {
  message: Pick<ChatMessage, "senderId" | "conversationId" | "type" | "body" | "attachmentName">;
  viewerId: string;
  /** Inbox row for the conversation — `isMuted` silences notifications. */
  isMuted?: boolean;
  /** Conversation currently open in the UI (null when on the inbox or elsewhere). */
  activeConversationId: string | null;
  hidden: boolean;
  permission: NotificationPermission;
}

/**
 * Notify only when the message could be missed: a hidden tab, or a message
 * landing in a conversation that isn't the active route. Never for one's own
 * messages, never for muted conversations, never without granted permission.
 */
export function shouldNotify(input: NotifyDecisionInput): boolean {
  const { message, viewerId, isMuted, activeConversationId, hidden, permission } = input;
  if (permission !== "granted") return false;
  if (message.senderId === viewerId) return false;
  if (isMuted) return false;
  return hidden || message.conversationId !== activeConversationId;
}

/** Notification body — mirrors the bubble preview conventions. */
export function notificationBody(message: NotifyDecisionInput["message"]): string {
  if (message.type === "IMAGE") return message.body ? `📷 ${message.body}` : "📷 Photo";
  if (message.type === "FILE") return `📎 ${message.attachmentName ?? "File"}`;
  return message.body ?? "";
}