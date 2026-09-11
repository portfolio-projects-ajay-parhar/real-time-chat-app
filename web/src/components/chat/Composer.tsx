"use client";

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { C2S, type ChatMessage, type MessageSendAck } from "@chat/shared";
import { useSocket } from "@/hooks/useSocket";
import {
  appendChatMessage,
  attachToOptimistic,
  markMessageFailed,
  removeChatMessage,
  type MessagesPage,
} from "@/lib/chat-cache";
import {
  checkAttachment,
  humanizeSize,
  measureImageDimensions,
  uploadAttachment,
  UploadError,
  type AttachmentKind,
} from "@/lib/attachment";

const TYPING_SEND_THROTTLE_MS = 2_000; // server broadcasts at most 1/2s anyway

interface PendingAttachment {
  file: File;
  kind: AttachmentKind;
  /** Object URL for the image thumbnail in the composer chip. */
  previewUrl: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Message composer — the optimistic-send pipeline (PLAN §state model):
 * clientId UUID → instant pending bubble → ack swaps in the persisted row →
 * 429 (or any error) flips the bubble to failed + surfaces the reason.
 */
export function Composer({
  conversationId,
  viewerId,
  replyTo,
  onCancelReply,
}: {
  conversationId: string;
  viewerId: string;
  /** Message being replied to — renders the quote banner, send carries replyToId. */
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
}) {
  const socket = useSocket();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const lastTypingSentRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke the thumbnail object URL when it changes or on unmount.
  useEffect(() => {
    return () => {
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, [attachment?.previewUrl]);

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

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const check = checkAttachment(file);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(null);
    setAttachment({ file, kind: check.kind, previewUrl: null, width: null, height: null });
    if (check.kind === "IMAGE") {
      if (file.type.startsWith("image/")) {
        // Thumbnail object URL for the composer chip.
        setAttachment((prev) =>
          prev && prev.file === file
            ? { ...prev, previewUrl: URL.createObjectURL(file) }
            : prev
        );
      }
      // Client-measured dims (PLAN §9.2) → no-CLS inline render.
      const dims = await measureImageDimensions(file);
      setAttachment((prev) =>
        prev && prev.file === file
          ? { ...prev, width: dims?.width ?? null, height: dims?.height ?? null }
          : prev
      );
    }
  };

  const clearAttachment = () => {
    if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment(null);
  };

  const send = () => {
    const body = value.trim();
    if (!socket || uploading) return;
    if (!body && !attachment) return;
    setError(null);

    const picked = attachment;
    const clientId = crypto.randomUUID();
    // Optimistic bubble — pending until the ack swaps it for the real row.
    const optimistic: ChatMessage = {
      id: `pending:${clientId}`,
      conversationId,
      senderId: viewerId,
      type: picked ? picked.kind : "TEXT",
      body: body || null,
      attachmentKey: null,
      attachmentName: picked?.file.name ?? null,
      attachmentSize: picked?.file.size ?? null,
      attachmentMime: picked?.file.type || null,
      attachmentWidth: picked?.width ?? null,
      attachmentHeight: picked?.height ?? null,
      clientId,
      replyToId: replyTo?.id ?? null,
      replyTo: replyTo
        ? {
            id: replyTo.id,
            type: replyTo.type,
            body: replyTo.body,
            senderId: replyTo.senderId,
            sender: replyTo.sender,
          }
        : null,
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
    const cancelledReply = replyTo;
    onCancelReply();
    sendTyping("stop");

    const emit = (
      att: { key: string; name: string; size: number; mime: string; width?: number; height?: number } | undefined
    ) => {
      socket.emit(
        C2S.MESSAGE_SEND,
        {
          conversationId,
          clientId,
          type: picked ? picked.kind : "TEXT",
          body: body || undefined,
          attachment: att,
          replyToId: cancelledReply?.id,
        },
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

    const finish = async () => {
      if (!picked) {
        emit(undefined);
        return;
      }
      setUploading(true);
      try {
        const uploaded = await uploadAttachment(picked.file);
        // Patch the pending bubble with the uploaded key so the inline
        // image/card renders (signed URL) while awaiting the send ack.
        const att = {
          key: uploaded.key,
          name: uploaded.name,
          size: uploaded.size,
          mime: uploaded.mime,
          width: picked.width ?? undefined,
          height: picked.height ?? undefined,
        };
        setMessages((pages) =>
          pages.map((page, i) =>
            i === pages.length - 1
              ? { ...page, messages: attachToOptimistic(page.messages, clientId, att) }
              : page
          )
        );
        emit(att);
      } catch (err) {
        // Upload failed — drop the pending bubble, surface the reason (the
        // 413/415 toast). The file stays selected so Send retries the upload.
        setMessages((pages) =>
          pages.map((page, i) =>
            i === pages.length - 1
              ? { ...page, messages: removeChatMessage(page.messages, clientId) }
              : page
          )
        );
        setValue(body);
        setError(
          err instanceof UploadError
            ? err.message
            : "Upload failed — check your connection and try again"
        );
      } finally {
        setUploading(false);
        clearAttachment();
      }
    };

    void finish();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-zinc-800 p-3">
      {replyTo && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-indigo-500 bg-zinc-800/60 px-3 py-1.5">
          <div className="min-w-0 flex-1 text-xs">
            <span className="block font-medium text-indigo-300">
              Replying to {replyTo.sender?.name ?? (replyTo.senderId === viewerId ? "yourself" : "Unknown")}
            </span>
            <span className="line-clamp-1 text-zinc-400">
              {replyTo.body ?? `[${replyTo.type.toLowerCase()}]`}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label="Cancel reply"
            className="rounded px-1 text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      )}
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-zinc-800/60 px-3 py-2">
          {attachment.kind === "IMAGE" && attachment.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={attachment.previewUrl}
              alt={attachment.file.name}
              className="h-12 w-12 rounded object-cover"
            />
          ) : (
            <span aria-hidden className="text-xl">
              {attachment.kind === "IMAGE" ? "🖼️" : "📄"}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
            {attachment.file.name}
            <span className="text-zinc-500"> · {humanizeSize(attachment.file.size)}</span>
          </span>
          <button
            type="button"
            onClick={clearAttachment}
            aria-label="Remove attachment"
            className="rounded px-1 text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="mb-2 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-400" role="alert">
          {error}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Attach an image or file"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800/80 text-lg leading-none text-zinc-400 ring-1 ring-white/5 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain"
          className="hidden"
          onChange={(e) => void onPickFile(e)}
        />
        <textarea
          value={value}
          rows={1}
          placeholder={
            attachment
              ? "Add a caption… (optional)"
              : "Type a message… (Enter to send, Shift+Enter for a newline)"
          }
          onChange={(e) => {
            setValue(e.target.value);
            if (e.target.value.trim()) sendTyping("start");
          }}
          onBlur={() => sendTyping("stop")}
          onKeyDown={onKeyDown}
          className="max-h-40 flex-1 resize-none rounded-2xl bg-zinc-800 px-4 py-2 text-sm text-zinc-100 outline-none ring-1 ring-white/5 transition-shadow placeholder:text-zinc-500 focus:bg-zinc-800/90 focus:ring-2 focus:ring-indigo-500/70"
        />
        <button
          type="button"
          onClick={send}
          disabled={!socket || uploading || (!value.trim() && !attachment)}
          className="h-9 rounded-full bg-gradient-to-b from-indigo-500 to-indigo-600 px-4 text-sm font-medium text-white shadow-sm shadow-indigo-950/50 transition-[filter,opacity] hover:brightness-110 disabled:opacity-40"
        >
          {uploading ? "Uploading…" : "Send"}
        </button>
      </div>
    </div>
  );
}