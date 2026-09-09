"use client";

import type { ChatMessage } from "@chat/shared";
import { Avatar } from "./Avatar";

/**
 * One message row. Phase 6 scope: own-vs-other layout, pending (clock) and
 * failed (⚠) transport states, reply preview, sender grouping (name/avatar
 * only on the first bubble of a run). Read ticks + receipts land in Phase 7;
 * markdown-lite + attachments rendering in Phase 8/9.
 */
export function MessageBubble({
  message,
  viewerId,
  showSender,
}: {
  message: ChatMessage;
  viewerId: string;
  showSender: boolean;
}) {
  if (message.type === "SYSTEM") {
    return (
      <div className="my-2 text-center text-xs text-zinc-500">{message.body}</div>
    );
  }

  const own = message.senderId === viewerId;

  return (
    <div className={`flex gap-2 ${own ? "flex-row-reverse" : ""}`}>
      <div className="w-8 shrink-0">
        {showSender && !own && message.sender && (
          <Avatar name={message.sender.name} imageKey={message.sender.image} size={32} />
        )}
      </div>
      <div className={`max-w-[75%] ${own ? "items-end text-right" : ""} flex flex-col`}>
        {showSender && !own && (
          <span className="mb-0.5 text-xs text-zinc-400">{message.sender?.name}</span>
        )}
        <div
          className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
            own
              ? "bg-indigo-600 text-white"
              : "bg-zinc-800 text-zinc-100"
          } ${message.failed ? "border border-red-500/60" : ""}`}
        >
          {message.replyTo && (
            <div className="mb-1 border-l-2 border-white/40 pl-2 text-xs opacity-80">
              <span className="font-medium">
                {message.replyTo.sender?.name ?? "Unknown"}
              </span>
              <span className="line-clamp-1">{message.replyTo.body ?? message.replyTo.type}</span>
            </div>
          )}
          {message.body}
        </div>
        <div className="mt-0.5 flex h-4 items-center gap-1 text-[10px] text-zinc-500">
          {message.pending && <span title="sending">⏱</span>}
          {message.failed && <span className="text-red-400">failed to send</span>}
          {own && !message.pending && !message.failed && <span title="sent">✓</span>}
          <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </div>
    </div>
  );
}