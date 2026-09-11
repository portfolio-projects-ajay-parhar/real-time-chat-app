"use client";

import Link from "next/link";
import type { InboxConversation } from "@/lib/chat-cache";
import { unreadBadge } from "@/lib/chat-cache";
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
  active = false,
}: {
  conversation: InboxConversation;
  viewerId: string;
  /** Currently-open chat (desktop split view highlight). */
  active?: boolean;
}) {
  const title = conversationTitle(conversation, viewerId);
  const other =
    conversation.type === "DIRECT"
      ? conversation.members.find((m) => m.id !== viewerId)
      : undefined;

  return (
    <Link
      href={`/conversations/${conversation.id}`}
      className={`group relative flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-zinc-800/60 ${
        active ? "bg-zinc-800/90 ring-1 ring-indigo-500/30" : ""
      }`}
    >
      {/* Active accent bar */}
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-indigo-500 transition-opacity ${
          active ? "opacity-100" : "opacity-0"
        }`}
      />
      <Avatar
        name={title}
        imageKey={other?.user.image ?? conversation.avatarKey}
        online={other?.online}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">{title}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
            {new Date(conversation.lastMessageAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-xs text-zinc-400">
            {previewText(conversation, viewerId)}
          </span>
          {(() => {
            const badge = unreadBadge(conversation);
            // Muted: "something new" is visible but the count stays private
            // to the chat (and out of the title badge).
            if (badge.kind === "count") {
              return (
                <span className="shrink-0 rounded-full bg-indigo-500 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm shadow-indigo-950/50 ring-1 ring-white/10">
                  {badge.count > 99 ? "99+" : badge.count}
                </span>
              );
            }
            if (badge.kind === "dot") {
              return (
                <span
                  aria-label="unread (muted)"
                  className="h-2 w-2 shrink-0 rounded-full bg-indigo-500 ring-2 ring-indigo-500/20"
                />
              );
            }
            return null;
          })()}
        </div>
      </div>
    </Link>
  );
}