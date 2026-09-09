"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { TypingDots } from "./TypingDots";
import { useTypingUsers } from "@/lib/typing-store";

interface ConversationDetail {
  id: string;
  type: "DIRECT" | "GROUP";
  name: string | null;
  avatarKey: string | null;
  members: {
    id: string;
    role: "OWNER" | "MEMBER";
    user: { id: string; name: string; image: string | null; bio: string | null; lastSeenAt: string };
  }[];
}

/**
 * The chat view — header (title + live typing indicator), message history,
 * composer. Read receipts / presence UX arrive in Phase 7; group management,
 * replies, edit/delete in Phase 8.
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

  const typingUserIds = useTypingUsers(conversationId).filter((id) => id !== viewerId);
  const typingNames = (data?.members ?? [])
    .filter((m) => typingUserIds.includes(m.id))
    .map((m) => m.user.name);

  const title =
    data?.type === "GROUP"
      ? data.name ?? "Group"
      : data?.members.find((m) => m.id !== viewerId)?.user.name ?? "Conversation";

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
              ? data.members.find((m) => m.id !== viewerId)?.user.image
              : data?.avatarKey
          }
          size={36}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-100">{title}</div>
          {typingNames.length > 0 ? (
            <TypingDots
              label={
                typingNames.length === 1
                  ? `${typingNames[0]} is typing…`
                  : `${typingNames.length} people are typing…`
              }
            />
          ) : (
            <div className="text-xs text-zinc-500">
              {data?.type === "GROUP" ? `${data.members.length} members` : "Direct message"}
            </div>
          )}
        </div>
      </header>

      <MessageList conversationId={conversationId} viewerId={viewerId} />
      <Composer conversationId={conversationId} viewerId={viewerId} />
    </div>
  );
}