"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { C2S, type ConversationReadAck } from "@chat/shared";
import { useSocket } from "./useSocket";
import {
  isAtOrAfter,
  markInboxRead,
  type ConversationDetail,
  type InboxConversation,
} from "@/lib/chat-cache";

/** Coalesce open/focus/new-message bursts into one watermark write. */
export const READ_DEBOUNCE_MS = 500;

/**
 * Auto read-marking (PLAN §read receipts): the open conversation fires
 * `conversation:read` when the viewer can actually see the newest message —
 * on mount, on window focus, and whenever a new message lands while the
 * list is scrolled to the bottom and the tab is visible. Everything is
 * debounced and skipped when the watermark already covers the newest
 * message, so an idle open chat writes nothing.
 */
export function useAutoRead(
  conversationId: string,
  viewerId: string,
  {
    nearBottom,
    newestMessageAt,
  }: { nearBottom: boolean; newestMessageAt: string | null }
) {
  const socket = useSocket();
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!socket) return;

    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      if (!nearBottom || !newestMessageAt) return;

      // Already read? The detail cache's own watermark is the freshest local
      // truth (kept current by receipt:update echoes + the read ack).
      const detail = queryClient.getQueryData<ConversationDetail>([
        "conversation",
        conversationId,
      ]);
      const mine = detail?.members.find((m) => m.id === viewerId)?.lastReadAt;
      if (mine && isAtOrAfter(mine, newestMessageAt)) return;

      socket.emit(
        C2S.CONVERSATION_READ,
        { conversationId },
        (ack: ConversationReadAck) => {
          if (!ack.ok) return;
          // Optimistic badge clear for this device; the server's
          // unread:update {count: 0} to user:{id} confirms every device.
          queryClient.setQueryData<InboxConversation[]>(["conversations"], (prev) =>
            markInboxRead(prev, conversationId, viewerId, ack.lastReadAt)
          );
        }
      );
    };

    const scheduleRead = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(markRead, READ_DEBOUNCE_MS);
    };

    scheduleRead();
    window.addEventListener("focus", scheduleRead);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("focus", scheduleRead);
    };
  }, [socket, queryClient, conversationId, viewerId, nearBottom, newestMessageAt]);
}