"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { totalUnread, type InboxConversation } from "@/lib/chat-cache";

const BASE_TITLE = "Chat";

/**
 * document.title badge — `(n) Chat` while unread messages exist, recomputed
 * from the inbox Query cache on every cache write (never from DOM counts).
 * Muted conversations are excluded (they don't nag the tab title either).
 */
export function useTitleBadge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const update = () => {
      const inbox = queryClient.getQueryData<InboxConversation[]>(["conversations"]);
      const n = totalUnread(inbox);
      document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
    };

    update();
    // Any cache write (socket patches, fetches) retriggers the title recompute.
    const unsubscribe = queryClient.getQueryCache().subscribe(update);
    return () => {
      unsubscribe();
      document.title = BASE_TITLE;
    };
  }, [queryClient]);
}