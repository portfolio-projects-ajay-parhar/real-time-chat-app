"use client";

import Link from "next/link";
import type { InboxConversation } from "@/lib/chat-cache";
import { Avatar } from "./Avatar";

function conversationTitle(conv: InboxConversation, viewerId: string): string {
  if (conv.type === "GROUP") return conv.name ?? "Group";
  const other = conv.members.find((m) => m.id !== viewerId);
  return other?.user.name ?? "Direct message";
}

function previewText(conv: InboxConversation, viewerId: string): string {
  const lm = conv.lastMessage;
  if (!lm) return "No messages yet";
  const prefix =
    lm.senderId === viewerId
      ? "You: "
      : conv.type === "GROUP" && lm.senderId
        ? `${lm.senderName ?? "Unknown"}: `
        : "";
  const body = lm.body ?? `[${lm.type.toLowerCase()}]`;
  return `${prefix}${body}`;
}

/**
 * One inbox row: avatar, title (other member for DMs / group name), message
 * preview, recency and the live unread badge.
 */
export function ConversationItem({
  conversation,
  viewerId,
}: {
  conversation: InboxConversation;
  viewerId: string;
}) {
  const title = conversationTitle(conversation, viewerId);
  const other =
    conversation.type === "DIRECT"
      ? conversation.members.find((m) => m.id !== viewerId)
      : undefined;

  return (
    <Link
      href={`/conversations/${conversation.id}`}
      className="flex items-center gap-3 rounded-lg px-3 py-3 hover:bg-zinc-800/60"
    >
      <Avatar
        name={title}
        imageKey={other?.user.image ?? conversation.avatarKey}
        online={other?.online}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">{title}</span>
          <span className="shrink-0 text-[10px] text-zinc-500">
            {new Date(conversation.lastMessageAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-zinc-400">
            {previewText(conversation, viewerId)}
          </span>
          {conversation.unread > 0 && (
            <span className="shrink-0 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white">
              {conversation.unread > 99 ? "99+" : conversation.unread}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}