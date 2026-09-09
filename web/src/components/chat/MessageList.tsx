"use client";

import { useEffect, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ChatMessage } from "@chat/shared";
import { Avatar } from "./Avatar";
import { MessageBubble } from "./MessageBubble";
import { isReadByWatermark, readersOf, type MessagesPage } from "@/lib/chat-cache";

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

/** Other members' read watermarks — drives ticks and the GROUP "Seen by" line. */
export interface MemberWatermark {
  userId: string;
  name: string;
  image: string | null;
  lastReadAt: string;
}

/**
 * Message history — keyset-paginated upward (the "Load older" control pages
 * back with the cursor of the oldest loaded message, immune to live appends).
 * Auto-scrolls to the newest message when already near the bottom, reports
 * scroll position + newest message upward (auto read-marking inputs), and
 * renders read receipts: ✓✓ per own bubble (DIRECT) and "Seen by N/M" under
 * the newest own message (GROUP).
 */
export function MessageList({
  conversationId,
  viewerId,
  type = "DIRECT",
  otherWatermarks = [],
  onNearBottomChange,
  onNewestChange,
}: {
  conversationId: string;
  viewerId: string;
  type?: "DIRECT" | "GROUP";
  otherWatermarks?: MemberWatermark[];
  onNearBottomChange?: (near: boolean) => void;
  onNewestChange?: (createdAt: string | null) => void;
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
  const newestMessageAt = messages.length > 0 ? messages[messages.length - 1].createdAt : null;

  // Report the newest message upward — the auto-read hook watches it.
  useEffect(() => {
    onNewestChange?.(newestMessageAt);
  }, [newestMessageAt, onNewestChange]);

  // Reset the scroll anchor when switching conversations.
  useEffect(() => {
    nearBottomRef.current = true;
    onNearBottomChange?.(true);
  }, [conversationId, onNearBottomChange]);

  useEffect(() => {
    if (nearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastId, conversationId]);

  // Newest own, persisted, visible message — the GROUP "Seen by N" anchor.
  let lastOwnIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.senderId === viewerId && m.type !== "SYSTEM" && !m.deletedAt && !m.pending) {
      lastOwnIdx = i;
      break;
    }
  }
  const lastOwnReaders =
    lastOwnIdx >= 0 && type === "GROUP"
      ? readersOf(messages[lastOwnIdx].createdAt, otherWatermarks, viewerId)
      : [];

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
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        if (near !== nearBottomRef.current) {
          nearBottomRef.current = near;
          onNearBottomChange?.(near);
        }
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
        const own = m.senderId === viewerId;
        // DIRECT: individual ✓✓ ticks from the other member's watermark.
        // GROUP: plain ✓ per bubble; the aggregate "Seen by N" line below.
        const read =
          own && type === "DIRECT" && !m.pending && !m.failed
            ? otherWatermarks.some((w) => isReadByWatermark(m.createdAt, w.lastReadAt))
            : undefined;
        return (
          <div key={m.id}>
            <MessageBubble
              message={m}
              viewerId={viewerId}
              showSender={showSender}
              read={read}
            />
            {i === lastOwnIdx && lastOwnReaders.length > 0 && (
              <div className="mt-0.5 flex items-center justify-end gap-1 pr-10">
                <span className="text-[10px] text-zinc-500">
                  Seen by {lastOwnReaders.length}/{otherWatermarks.length}
                </span>
                <span className="flex">
                  {lastOwnReaders.slice(0, 5).map((w) => (
                    <span key={w.userId} className="-ml-1 first:ml-0">
                      <Avatar name={w.name} imageKey={w.image} size={14} />
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}