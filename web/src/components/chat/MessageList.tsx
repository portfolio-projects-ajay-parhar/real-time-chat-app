"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ChatMessage } from "@chat/shared";
import { Avatar } from "./Avatar";
import { MessageBubble } from "./MessageBubble";
import {
  canDeleteMessage,
  canEditMessage,
  isReadByWatermark,
  readersOf,
  type MessagesPage,
} from "@/lib/chat-cache";
import { dayLabel, shouldShowDateSeparator, shouldShowSender } from "@/lib/message-grouping";

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
 * Message history — keyset-paginated UPWARD via an IntersectionObserver on a
 * top sentinel (auto "load older"), with the scroll anchored to the
 * previously-first message so prepending a page never jumps the viewport.
 * Renders date separators + consecutive-sender grouping, auto-sticks to the
 * bottom when already there, shows a "New messages ↓" pill when a live
 * message lands while scrolled up, and reports scroll position + newest
 * message upward for auto read-marking.
 */
export function MessageList({
  conversationId,
  viewerId,
  type = "DIRECT",
  otherWatermarks = [],
  myRole = "MEMBER",
  onNearBottomChange,
  onNewestChange,
  onReply,
  onEdit,
  onDelete,
}: {
  conversationId: string;
  viewerId: string;
  type?: "DIRECT" | "GROUP";
  otherWatermarks?: MemberWatermark[];
  /** Viewer's role in this conversation — GROUP owners can delete any message. */
  myRole?: "OWNER" | "MEMBER";
  onNearBottomChange?: (near: boolean) => void;
  onNewestChange?: (createdAt: string | null) => void;
  onReply: (message: ChatMessage) => void;
  onEdit: (messageId: string, body: string) => void;
  onDelete: (messageId: string) => void;
}) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["messages", conversationId],
      queryFn: ({ pageParam }) => fetchMessagesPage(conversationId, pageParam),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  /** Where the viewport was anchored before an older page prepended. */
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const lastSeenIdRef = useRef<string | null>(null);
  const [newPill, setNewPill] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);

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

  // Reset the scroll state when switching conversations. The new-pill reset
  // happens via the render-time "adjust state on prop change" pattern (the
  // React-recommended alternative to setState-in-effect); refs and the
  // parent callback stay in the effect.
  const [prevConvId, setPrevConvId] = useState(conversationId);
  if (prevConvId !== conversationId) {
    setPrevConvId(conversationId);
    setNewPill(false);
  }
  useEffect(() => {
    nearBottomRef.current = true;
    lastSeenIdRef.current = null;
    onNearBottomChange?.(true);
  }, [conversationId, onNearBottomChange]);

  // Auto-stick to the newest message when already near the bottom.
  useEffect(() => {
    if (nearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastId, conversationId]);

  // Live message landed while scrolled up → "New messages ↓" pill.
  useEffect(() => {
    if (!lastId) return;
    if (nearBottomRef.current) {
      lastSeenIdRef.current = lastId;
    } else if (lastId !== lastSeenIdRef.current) {
      setNewPill(true);
    }
  }, [lastId]);

  /** Start an upward page fetch, anchoring the viewport to the first message. */
  const fetchOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    const first = el.querySelector<HTMLElement>("[data-message-id]");
    anchorRef.current = first?.dataset.messageId
      ? { id: first.dataset.messageId, top: first.getBoundingClientRect().top }
      : null;
    void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  // After the prepend, restore the anchor message's viewport position.
  useEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor || isFetchingNextPage) return;
    const target = el.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`);
    if (target) el.scrollTop += target.getBoundingClientRect().top - anchor.top;
    anchorRef.current = null;
  }, [data, isFetchingNextPage]);

  // IntersectionObserver on the top sentinel — upward infinite scroll.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) fetchOlder();
      },
      { root, rootMargin: "240px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, fetchOlder]);

  /** Click on a reply quote → scroll to the original + flash highlight. */
  const jumpToMessage = useCallback((messageId: string) => {
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!el || !target) return; // not in the loaded pages — no-op (phase 8 scope)
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightId(messageId);
  }, []);

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 1600);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottomRef.current = true;
    lastSeenIdRef.current = lastId ?? null;
    setNewPill(false);
    onNearBottomChange?.(true);
  };

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (near) lastSeenIdRef.current = lastId ?? null;
          if (near && newPill) setNewPill(false);
          if (near !== nearBottomRef.current) {
            nearBottomRef.current = near;
            onNearBottomChange?.(near);
          }
        }}
                className="chat-bg chat-scroll flex-1 overflow-y-auto px-4 py-4"
      >
        <div ref={sentinelRef} className="flex h-8 items-center justify-center">
          {isFetchingNextPage && <span className="text-xs text-zinc-500">Loading older…</span>}
        </div>
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
            <span className="text-3xl" aria-hidden>
              👋
            </span>
            <span>No messages yet — say hi</span>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showDate = shouldShowDateSeparator(prev?.createdAt, m.createdAt);
          const showSender = shouldShowSender(prev, m);
          const own = m.senderId === viewerId;
          // DIRECT: individual ✓✓ ticks from the other member's watermark.
          // GROUP: plain ✓ per bubble; the aggregate "Seen by N" line below.
          const read =
            own && type === "DIRECT" && !m.pending && !m.failed
              ? otherWatermarks.some((w) => isReadByWatermark(m.createdAt, w.lastReadAt))
              : undefined;
          // Consecutive same-sender messages tuck together; a new sender (or
          // a date separator) gets breathing room.
          const rowSpacing = i === 0 ? "" : showDate ? "mt-4" : showSender ? "mt-3" : "mt-0.5";
          return (
            <div
              key={m.id}
              data-message-id={m.id}
              className={`msg-in rounded-xl ${
                rowSpacing
              } ${
                highlightId === m.id
                  ? "bg-indigo-500/10 ring-1 ring-indigo-500/40 transition-colors"
                  : undefined
              }`}
            >
              {showDate && (
                <div className="mb-3 flex justify-center" aria-hidden>
                  <span className="rounded-full bg-zinc-800/70 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400 ring-1 ring-white/5">
                    {dayLabel(m.createdAt)}
                  </span>
                </div>
              )}
              <MessageBubble
                message={m}
                viewerId={viewerId}
                showSender={showSender}
                grouped={!showDate && !showSender}
                read={read}
                canEdit={canEditMessage(m, viewerId)}
                canDelete={canDeleteMessage(m, viewerId, myRole)}
                onReply={onReply}
                onEdit={onEdit}
                onDelete={onDelete}
                onJumpToMessage={jumpToMessage}
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
      {newPill && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-xl shadow-black/40 ring-1 ring-white/10 transition-colors hover:bg-indigo-500"
        >
          New messages ↓
        </button>
      )}
    </div>
  );
}