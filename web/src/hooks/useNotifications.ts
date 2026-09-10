"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import { S2C, type ChatMessage } from "@chat/shared";
import { getSignedMediaUrl } from "@/lib/media-url";
import { notificationBody, shouldNotify, type NotificationPermission } from "@/lib/notifications";
import type { InboxConversation } from "@/lib/chat-cache";

function notificationPermission(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/**
 * OS notifications on MESSAGE_NEW (Phase 9.1) — permission is NEVER requested
 * here (browser gesture policy: the chip in the inbox header is the only
 * requester). A message notifies only when the tab is hidden or the message's
 * conversation isn't the active route; muted conversations never notify.
 * Click → focus the window on the conversation's route.
 */
export function useNotifications(socket: Socket | null, viewerId: string) {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!socket) return;

    const onMessageNew = async (payload: { message: ChatMessage }) => {
      const message = payload.message;
      const inbox = queryClient.getQueryData<InboxConversation[]>(["conversations"]);
      const conv = inbox?.find((c) => c.id === message.conversationId);
      const activeConversationId =
        pathname.match(/^\/conversations\/([^/]+)/)?.[1] ?? null;

      if (
        !shouldNotify({
          message,
          viewerId,
          isMuted: conv?.isMuted,
          activeConversationId,
          hidden: document.hidden,
          permission: notificationPermission(),
        })
      ) {
        return;
      }

      const title =
        conv?.type === "GROUP"
          ? `${conv.name ?? "Group"} · ${message.sender?.name ?? "New message"}`
          : (message.sender?.name ?? "New message");

      let icon: string | undefined;
      if (message.sender?.image) {
        try {
          icon = await getSignedMediaUrl(message.sender.image);
        } catch {
          // cosmetic only — notify without the icon
        }
      }

      const notification = new Notification(title, {
        body: notificationBody(message),
        tag: message.conversationId, // collapse per conversation
        icon,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
        router.push(`/conversations/${message.conversationId}`);
      };
    };

    socket.on(S2C.MESSAGE_NEW, onMessageNew);
    return () => {
      socket.off(S2C.MESSAGE_NEW, onMessageNew);
    };
  }, [socket, viewerId, pathname, queryClient, router]);
}