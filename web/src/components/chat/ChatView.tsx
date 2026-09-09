"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { TypingDots } from "./TypingDots";
import { useTypingUsers } from "@/lib/typing-store";
import { usePresenceMap } from "@/lib/presence-store";
import { isRecentLastSeen, relativeLastSeen } from "@/lib/relative-time";
import type { ConversationDetail } from "@/lib/chat-cache";
import { useAutoRead } from "@/hooks/useAutoRead";

/**
 * The chat view — header (title + live presence/typing indicator), message
 * history with read receipts, composer with auto read-marking. Group
 * management, replies, edit/delete arrive in Phase 8.
 */
export function ChatView({
  conversationId,
  viewerId,
}: {
  conversationId: string;
  viewerId: string;
}) {
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
  const onNearBottomChange = useCallback((near: boolean) => setNearBottom(near), []);
  const onNewestChange = useCallback((createdAt: string | null) => setNewestMessageAt(createdAt), []);
  useAutoRead(conversationId, viewerId, { nearBottom, newestMessageAt });

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
    <div className="mx-auto flex h-dvh max-w-2xl flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <Link
          href="/conversations"
          className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
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
      </header>

      <MessageList
        conversationId={conversationId}
        viewerId={viewerId}
        type={data?.type ?? "DIRECT"}
        otherWatermarks={otherWatermarks}
        onNearBottomChange={onNearBottomChange}
        onNewestChange={onNewestChange}
      />
      <Composer conversationId={conversationId} viewerId={viewerId} />
    </div>
  );
}