"use client";

import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import {
  CONN,
  S2C,
  type ChatMessage,
  type PresenceUpdateEvent,
  type ReceiptUpdateEvent,
  type TypingUpdateEvent,
  type UnreadUpdateEvent,
} from "@chat/shared";
import {
  appendChatMessage,
  mergeBackfill,
  patchConversationReceipt,
  patchInboxAfterMessage,
  patchInboxPresence,
  patchInboxReceipt,
  patchInboxUnread,
  type ConversationDetail,
  type InboxConversation,
  type MessagesPage,
} from "@/lib/chat-cache";
import { applyPresenceUpdate } from "@/lib/presence-store";
import { applyTypingUpdate } from "@/lib/typing-store";

/**
 * Reconnect gap recovery (PLAN §keyset): fetch `?after={lastCached.createdAt}`
 * for every conversation that has a messages cache and merge the missed tail
 * in. The keyset endpoint guarantees nothing shifts under us while offline.
 */
async function backfillMessageGaps(queryClient: QueryClient) {
  const entries = queryClient.getQueriesData<InfiniteData<MessagesPage>>({
    queryKey: ["messages"],
  });
  await Promise.all(
    entries.map(async ([key, data]) => {
      if (!data || key.length < 2) return;
      const conversationId = key[1] as string;
      const flat = data.pages.flatMap((p) => p.messages);
      const last = flat[flat.length - 1];
      if (!last) return;

      try {
        const res = await fetch(
          `/api/conversations/${conversationId}/messages?after=${encodeURIComponent(last.createdAt)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const json = (await res.json()) as { messages: ChatMessage[] };
        queryClient.setQueryData<InfiniteData<MessagesPage>>(key, (prev) =>
          prev ? { ...prev, pages: mergeBackfill(prev.pages, json.messages) } : prev
        );
      } catch {
        // offline again — next connect retries
      }
    })
  );
}

/**
 * The socket → TanStack Query bridge, mounted ONCE (in SocketProvider).
 * Every server event is translated into a cache mutation; components just
 * read their queries and re-render.
 */
export function useChatEvents(socket: Socket | null, viewerId: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!socket) return;

    const onMessageNew = (payload: { message: ChatMessage }) => {
      const message = payload.message;
      // History cache: append/dedupe (replaces this client's optimistic
      // bubble on the echo, since both carry the same clientId).
      const key = ["messages", message.conversationId];
      queryClient.setQueryData<InfiniteData<MessagesPage>>(key, (prev) =>
        prev
          ? {
              ...prev,
              pages: prev.pages.map((page, i) =>
                i === prev.pages.length - 1
                  ? { ...page, messages: appendChatMessage(page.messages, message) }
                  : page
              ),
            }
          : prev
      );
      // Inbox: preview + recency + (optimistic) unread bump.
      queryClient.setQueryData<InboxConversation[]>(["conversations"], (prev) =>
        patchInboxAfterMessage(prev, message, viewerId)
      );
    };

    const onUnreadUpdate = (payload: UnreadUpdateEvent) => {
      queryClient.setQueryData<InboxConversation[]>(["conversations"], (prev) =>
        patchInboxUnread(prev, payload.conversationId, payload.count)
      );
    };

    const onTypingUpdate = (payload: TypingUpdateEvent) => {
      applyTypingUpdate(payload.conversationId, payload.userIds);
    };

    // Read receipts — advance the watermarks (detail cache drives the ticks,
    // inbox cache keeps "seen by" data). Forward-only patches.
    const onReceiptUpdate = (payload: ReceiptUpdateEvent) => {
      queryClient.setQueryData<ConversationDetail>(
        ["conversation", payload.conversationId],
        (prev) => patchConversationReceipt(prev, payload.userId, payload.lastReadAt)
      );
      queryClient.setQueryData<InboxConversation[]>(["conversations"], (prev) =>
        patchInboxReceipt(
          prev,
          payload.conversationId,
          payload.userId,
          payload.lastReadAt,
          viewerId
        )
      );
    };

    // Presence — the live store wins over the REST snapshot; the inbox rows'
    // online flags get the same update so dots stay in sync everywhere.
    const onPresenceUpdate = (payload: PresenceUpdateEvent) => {
      applyPresenceUpdate(payload.userId, payload.status, payload.lastSeenAt);
      queryClient.setQueryData<InboxConversation[]>(["conversations"], (prev) =>
        patchInboxPresence(prev, payload.userId, payload.status === "online")
      );
    };

    // Back online: recover anything missed while disconnected + refresh the
    // inbox (unread counts, presence, previews).
    const onConnect = () => {
      void backfillMessageGaps(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    };

    socket.on(S2C.MESSAGE_NEW, onMessageNew);
    socket.on(S2C.UNREAD_UPDATE, onUnreadUpdate);
    socket.on(S2C.TYPING_UPDATE, onTypingUpdate);
    socket.on(S2C.RECEIPT_UPDATE, onReceiptUpdate);
    socket.on(S2C.PRESENCE_UPDATE, onPresenceUpdate);
    socket.on(CONN.CONNECT, onConnect);

    return () => {
      socket.off(S2C.MESSAGE_NEW, onMessageNew);
      socket.off(S2C.UNREAD_UPDATE, onUnreadUpdate);
      socket.off(S2C.TYPING_UPDATE, onTypingUpdate);
      socket.off(S2C.RECEIPT_UPDATE, onReceiptUpdate);
      socket.off(S2C.PRESENCE_UPDATE, onPresenceUpdate);
      socket.off(CONN.CONNECT, onConnect);
    };
  }, [socket, queryClient, viewerId]);
}