"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { C2S, type ChatMessage, type MessageSendAck } from "@chat/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { useSocket } from "@/hooks/useSocket";
import { appendChatMessage, markMessageFailed, type MessagesPage } from "@/lib/chat-cache";

const TYPING_SEND_THROTTLE_MS = 2_000; // server broadcasts at most 1/2s anyway

/**
 * Message composer — the optimistic-send pipeline (PLAN §state model):
 * clientId UUID → instant pending bubble → ack swaps in the persisted row →
 * 429 (or any error) flips the bubble to failed + surfaces the reason.
 */
export function Composer({
  conversationId,
  viewerId,
}: {
  conversationId: string;
  viewerId: string;
}) {
  const socket = useSocket();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lastTypingSentRef = useRef(0);

  const setMessages = (updater: (pages: MessagesPage[]) => MessagesPage[]) => {
    queryClient.setQueryData<InfiniteData<MessagesPage>>(
      ["messages", conversationId],
      (prev) => (prev ? { ...prev, pages: updater(prev.pages) } : prev)
    );
  };

  const sendTyping = (event: "start" | "stop") => {
    if (!socket) return;
    if (event === "start") {
      const now = Date.now();
      if (now - lastTypingSentRef.current < TYPING_SEND_THROTTLE_MS) return;
      lastTypingSentRef.current = now;
    }
    socket.emit(event === "start" ? C2S.TYPING_START : C2S.TYPING_STOP, {
      conversationId,
    });
  };

  const send = () => {
    const body = value.trim();
    if (!body || !socket) return;
    setError(null);

    // Optimistic bubble — pending until the ack swaps it for the real row.
    const clientId = crypto.randomUUID();
    const optimistic: ChatMessage = {
      id: `pending:${clientId}`,
      conversationId,
      senderId: viewerId,
      type: "TEXT",
      body,
      attachmentKey: null,
      attachmentName: null,
      attachmentSize: null,
      attachmentMime: null,
      attachmentWidth: null,
      attachmentHeight: null,
      clientId,
      replyToId: null,
      replyTo: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
      sender: null,
      pending: true,
    };

    setMessages((pages) =>
      pages.map((page, i) =>
        i === pages.length - 1 ? { ...page, messages: appendChatMessage(page.messages, optimistic) } : page
      )
    );
    setValue("");
    sendTyping("stop");

    socket.emit(
      C2S.MESSAGE_SEND,
      { conversationId, clientId, type: "TEXT", body },
      (ack: MessageSendAck) => {
        if (ack.ok) {
          // Ack swap — replaces the pending bubble by clientId.
          setMessages((pages) =>
            pages.map((page, i) =>
              i === pages.length - 1
                ? { ...page, messages: appendChatMessage(page.messages, ack.message) }
                : page
            )
          );
        } else {
          setMessages((pages) =>
            pages.map((page, i) =>
              i === pages.length - 1
                ? { ...page, messages: markMessageFailed(page.messages, clientId) }
                : page
            )
          );
          setError(
            ack.code === "RATE_LIMITED" ? "You're sending too fast — slow down." : ack.message
          );
        }
      }
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-zinc-800 p-3">
      {error && (
        <div className="mb-2 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-400" role="alert">
          {error}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          disabled // attachments arrive in Phase 9
          title="Attachments come in a later phase"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-400"
        >
          +
        </button>
        <textarea
          value={value}
          rows={1}
          placeholder="Type a message… (Enter to send, Shift+Enter for a newline)"
          onChange={(e) => {
            setValue(e.target.value);
            if (e.target.value.trim()) sendTyping("start");
          }}
          onBlur={() => sendTyping("stop")}
          onKeyDown={onKeyDown}
          className="max-h-40 flex-1 resize-none rounded-2xl bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="button"
          onClick={send}
          disabled={!value.trim() || !socket}
          className="h-9 rounded-full bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}