"use client";

import { useEffect, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ChatMessage } from "@chat/shared";
import { MessageBubble } from "./MessageBubble";
import type { MessagesPage } from "@/lib/chat-cache";

async function fetchMessagesPage(
  conversationId: string,
  cursor?: string
): Promise<MessagesPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const res = await fetch(`/api/conversations/${conversationId}/messages${qs}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to load messages");
  return res.json();
}

/**
 * Message history — keyset-paginated upward (the "Load older" control pages
 * back with the cursor of the oldest loaded message, immune to live appends).
 * Auto-scrolls to the newest message when already near the bottom.
 */
export function MessageList({
  conversationId,
  viewerId,
}: {
  conversationId: string;
  viewerId: string;
}) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["messages", conversationId],
      queryFn: ({ pageParam }) => fetchMessagesPage(conversationId, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  // Pages are fetched newest-first; chronological order = reversed pages.
  const messages: ChatMessage[] = [...(data?.pages ?? [])]
    .reverse()
    .flatMap((p) => p.messages);
  const lastId = messages[messages.length - 1]?.id;

  useEffect(() => {
    if (nearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastId, conversationId]);

  if (isLoading) {
    return <div className="flex flex-1 items-center justify-center text-zinc-500">Loading…</div>;
  }
  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center text-red-400">
        Could not load history.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
    >
      {hasNextPage && (
        <div className="flex justify-center pb-2">
          <button
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
          >
            {isFetchingNextPage ? "Loading…" : "Load older messages"}
          </button>
        </div>
      )}
      {messages.length === 0 && (
        <div className="flex h-full items-center justify-center text-sm text-zinc-500">
          No messages yet — say hi 👋
        </div>
      )}
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const showSender =
          !prev ||
          prev.senderId !== m.senderId ||
          prev.type === "SYSTEM" ||
          new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
        return (
          <MessageBubble key={m.id} message={m} viewerId={viewerId} showSender={showSender} />
        );
      })}
    </div>
  );
}