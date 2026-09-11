"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { ChatMessage } from "@chat/shared";
import Link from "next/link";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { TypingDots } from "./TypingDots";
import { GroupMembersSheet } from "./GroupMembersSheet";
import { useTypingUsers } from "@/lib/typing-store";
import { usePresenceMap } from "@/lib/presence-store";
import { isRecentLastSeen, relativeLastSeen } from "@/lib/relative-time";
import {
  patchMessageDeleted,
  patchMessageEdited,
  type ConversationDetail,
  type MessagesPage,
} from "@/lib/chat-cache";
import { useAutoRead } from "@/hooks/useAutoRead";

/**
 * The chat view — header (title + live presence/typing indicator + group
 * members sheet), message history with receipts, date separators, reply/
 * edit/delete actions and the composer with reply banner + auto read-marking.
 */
export function ChatView({
  conversationId,
  viewerId,
}: {
  conversationId: string;
  viewerId: string;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: async (): Promise<ConversationDetail> => {
      const res = await fetch(`/api/conversations/${conversationId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load conversation");
      const json = (await res.json()) as { conversation: ConversationDetail };
      return json.conversation;
    },
  });

  // Auto read-marking inputs, reported by MessageList.
  const [nearBottom, setNearBottom] = useState(true);
  const [newestMessageAt, setNewestMessageAt] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const onNearBottomChange = useCallback((near: boolean) => setNearBottom(near), []);
  const onNewestChange = useCallback((createdAt: string | null) => setNewestMessageAt(createdAt), []);
  useAutoRead(conversationId, viewerId, { nearBottom, newestMessageAt });

  const myRole = data?.members.find((m) => m.id === viewerId)?.role ?? "MEMBER";

  // Edit — REST PATCH + pure cache patch (sender, TEXT, ≤15 min enforced
  // server-side; the server response is the patch source of truth).
  const handleEdit = useCallback(
    async (messageId: string, body: string) => {
      setActionError(null);
      try {
        const res = await fetch(`/api/messages/${messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body }),
        });
        const payload: unknown = await res.json().catch(() => null);
        const raw = (payload as { message?: unknown } | null)?.message;
        const edited =
          raw && typeof raw === "object"
            ? (raw as { id?: string; body?: string; editedAt?: string | null })
            : null;
        if (!res.ok || !edited?.id || typeof edited.body !== "string" || !edited.editedAt) {
          throw new Error(
            typeof raw === "string" && raw ? raw : "Could not edit the message"
          );
        }
        queryClient.setQueryData<InfiniteData<MessagesPage>>(
          ["messages", conversationId],
          (prev) =>
            prev && edited.editedAt
              ? {
                  ...prev,
                  pages: patchMessageEdited(prev.pages, edited.id!, edited.body!, edited.editedAt!),
                }
              : prev
        );
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not edit the message");
      }
    },
    [conversationId, queryClient]
  );

  // Delete — soft delete + tombstone patch (server allows sender or OWNER).
  const handleDelete = useCallback(
    async (messageId: string) => {
      if (!window.confirm("Delete this message?")) return;
      setActionError(null);
      try {
        const res = await fetch(`/api/messages/${messageId}`, { method: "DELETE" });
        const payload: unknown = await res.json().catch(() => null);
        const raw = (payload as { message?: unknown } | null)?.message;
        const deleted =
          raw && typeof raw === "object"
            ? (raw as { id?: string; deletedAt?: string | null })
            : null;
        if (!res.ok || !deleted?.id || !deleted.deletedAt) {
          throw new Error(
            typeof raw === "string" && raw ? raw : "Could not delete the message"
          );
        }
        queryClient.setQueryData<InfiniteData<MessagesPage>>(
          ["messages", conversationId],
          (prev) =>
            prev && deleted.deletedAt
              ? { ...prev, pages: patchMessageDeleted(prev.pages, deleted.id!, deleted.deletedAt!) }
              : prev
        );
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not delete the message");
      }
    },
    [conversationId, queryClient]
  );

  // Edit/delete/rename/SYSTEM-message propagation to THIS client happens on
  // refetch: global refetchOnWindowFocus is off, so the phase-8 scope's
  // "re-fetches on focus" is an explicit invalidate on focus/visibility.
  useEffect(() => {
    const refetch = () => {
      if (document.visibilityState === "hidden") return;
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [conversationId, queryClient]);

  const typingUserIds = useTypingUsers(conversationId).filter((id) => id !== viewerId);
  const typingNames = (data?.members ?? [])
    .filter((m) => typingUserIds.includes(m.id))
    .map((m) => m.user.name);
  const isTyping = typingNames.length > 0;

  const title =
    data?.type === "GROUP"
      ? data.name ?? "Group"
      : data?.members.find((m) => m.id !== viewerId)?.user.name ?? "Conversation";

  const otherMember = data?.members.find((m) => m.id !== viewerId);
  const presenceMap = usePresenceMap();

  // Subtitle: typing indicator wins; otherwise presence (DIRECT) or a live
  // member/online count (GROUP — the store starts empty, so the count only
  // appears once presence events have landed).
  const subtitle = (() => {
    if (!data) return "…";
    if (data.type === "GROUP") {
      const online = data.members.filter((m) => m.id !== viewerId && presenceMap[m.id]?.online).length;
      return online > 0
        ? `${data.members.length} members · ${online} online`
        : `${data.members.length} members`;
    }
    if (!otherMember) return "Direct message";
    const entry = presenceMap[otherMember.id];
    if (entry?.online) return "online";
    const lastSeenAt = entry?.lastSeenAt ?? otherMember.user.lastSeenAt;
    return isRecentLastSeen(lastSeenAt) ? `last seen ${relativeLastSeen(lastSeenAt)}` : "offline";
  })();

  // Watermarks of everyone whose reading is tracked on MY messages.
  const otherWatermarks = (data?.members ?? [])
    .filter((m) => m.id !== viewerId)
    .map((m) => ({ userId: m.id, name: m.user.name, image: m.user.image, lastReadAt: m.lastReadAt }));

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/70 px-4 py-3 backdrop-blur-md">
        <Link
          href="/conversations"
          className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 md:hidden"
          aria-label="Back to chats"
        >
          ←
        </Link>
        <Avatar
          name={title}
          imageKey={
            data?.type === "DIRECT"
              ? otherMember?.user.image
              : data?.avatarKey
          }
          size={36}
          online={data?.type === "DIRECT" ? presenceMap[otherMember?.id ?? ""]?.online : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-100">{title}</div>
          {isTyping ? (
            <TypingDots
              label={
                typingNames.length === 1
                  ? `${typingNames[0]} is typing…`
                  : `${typingNames.length} people are typing…`
              }
            />
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              {data?.type === "DIRECT" && presenceMap[otherMember?.id ?? ""]?.online && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              )}
              <span className={subtitle === "online" ? "text-emerald-400" : ""}>{subtitle}</span>
            </div>
          )}
        </div>
        {data?.type === "GROUP" && (
          <button
            type="button"
            onClick={() => setMembersOpen(true)}
            aria-label="Group members"
            className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            👥 {data.members.length}
          </button>
        )}
      </header>

      {actionError && (
        <div className="px-4 pt-2" role="alert">
          <div className="rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-400">
            {actionError}
          </div>
        </div>
      )}

      <MessageList
        conversationId={conversationId}
        viewerId={viewerId}
        type={data?.type ?? "DIRECT"}
        otherWatermarks={otherWatermarks}
        myRole={myRole}
        onNearBottomChange={onNearBottomChange}
        onNewestChange={onNewestChange}
        onReply={setReplyTo}
        onEdit={(id, body) => void handleEdit(id, body)}
        onDelete={(id) => void handleDelete(id)}
      />
      <Composer
        conversationId={conversationId}
        viewerId={viewerId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />

      {data?.type === "GROUP" && (
        <GroupMembersSheet
          conversation={data}
          viewerId={viewerId}
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </div>
  );
}