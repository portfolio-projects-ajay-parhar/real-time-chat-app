"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "@chat/shared";
import { Avatar } from "./Avatar";
import { Lightbox } from "./Lightbox";
import { MarkdownLite } from "@/lib/markdown-lite";
import { useSignedMediaUrl } from "@/hooks/useSignedMediaUrl";
import { humanizeSize } from "@/lib/attachment";

/**
 * One message row. Own-vs-other layout, transport states (pending clock →
 * sent ✓ → read ✓✓ via the other member's watermark, failed ⚠), reply
 * preview (click jumps to the original if loaded), sender grouping,
 * markdown-lite body, edited marker, deleted tombstone and the Phase 8
 * action menu (reply / edit / delete).
 */
export function MessageBubble({
  message,
  viewerId,
  showSender,
  read,
  canEdit,
  canDelete,
  onReply,
  onEdit,
  onDelete,
  onJumpToMessage,
}: {
  message: ChatMessage;
  viewerId: string;
  showSender: boolean;
  /** DIRECT only: the other member's watermark covers this message. */
  read?: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onReply: (message: ChatMessage) => void;
  onEdit: (messageId: string, body: string) => void;
  onDelete: (messageId: string) => void;
  onJumpToMessage: (messageId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      editRef.current?.setSelectionRange(draft.length, draft.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (message.type === "SYSTEM") {
    return <div className="my-2 text-center text-xs text-zinc-500">{message.body}</div>;
  }

  const own = message.senderId === viewerId;
  const deleted = Boolean(message.deletedAt);
  const edited = Boolean(message.editedAt) && !deleted;

  const startEdit = () => {
    setDraft(message.body ?? "");
    setEditing(true);
  };

  const submitEdit = () => {
    const body = draft.trim();
    if (!body) return;
    onEdit(message.id, body);
    setEditing(false);
  };

  const onEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitEdit();
    }
    if (e.key === "Escape") setEditing(false);
  };

  // Tombstone — the soft-deleted placeholder stays in the timeline.
  if (deleted) {
    return (
      <div className={`flex gap-2 ${own ? "flex-row-reverse" : ""}`}>
        <div className="w-8 shrink-0" />
        <div className="flex max-w-[75%] flex-col">
          <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-800/40 px-3 py-2 text-sm italic text-zinc-500">
            Message deleted
          </div>
        </div>
      </div>
    );
  }

  const actionButton =
    "rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 focus-visible:bg-zinc-700";

  return (
    <div className={`group flex gap-2 ${own ? "flex-row-reverse" : ""}`}>
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
            own ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-100"
          } ${message.failed ? "border border-red-500/60" : ""}`}
        >
          {message.replyTo && (
            <button
              type="button"
              onClick={() => onJumpToMessage(message.replyTo!.id)}
              title="Jump to the original message"
              className={`mb-1 block w-full rounded border-l-2 pl-2 text-left text-xs opacity-80 ${
                own ? "border-white/60 hover:bg-white/10" : "border-indigo-400/60 hover:bg-white/5"
              }`}
            >
              <span className="block font-medium">
                {message.replyTo.sender?.name ?? "Unknown"}
              </span>
              <span className="line-clamp-2">
                {message.replyTo.body ?? `[${message.replyTo.type.toLowerCase()}]`}
              </span>
            </button>
          )}
          {editing ? (
            <div className="min-w-48">
              <textarea
                ref={editRef}
                value={draft}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onEditKeyDown}
                className="w-full resize-none rounded-lg bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none ring-1 ring-indigo-500"
              />
              <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-zinc-500">
                <span>Enter to save · Esc to cancel</span>
                <button
                  type="button"
                  onClick={submitEdit}
                  className="rounded bg-indigo-600 px-2 py-0.5 text-white hover:bg-indigo-500"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <AttachmentBody message={message} />
          )}
        </div>
        <div className="mt-0.5 flex h-4 items-center gap-1 text-[10px] text-zinc-500">
          {message.pending && <span title="sending">⏱</span>}
          {message.failed && <span className="text-red-400">failed to send</span>}
          {own && !message.pending && !message.failed &&
            (read ? (
              <span title="Read" className="text-indigo-400">✓✓</span>
            ) : (
              <span title="Sent">✓</span>
            ))}
          <span>
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {edited && <span className="italic"> · edited</span>}
          </span>
        </div>
        {/* Action menu — appears on hover/focus for delivered, live messages. */}
        {!message.pending && !message.failed && (
          <div
            className={`-mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
              own ? "flex-row-reverse" : ""
            }`}
          >
            <button type="button" className={actionButton} onClick={() => onReply(message)}>
              Reply
            </button>
            {canEdit && (
              <button type="button" className={actionButton} onClick={startEdit}>
                Edit
              </button>
            )}
            {canDelete && (
              <button type="button" className={actionButton} onClick={() => onDelete(message.id)}>
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Attachment + caption rendering (Phase 9.3): IMAGE inline with
 * client-measured dimensions (no layout shift) and a lightbox on click;
 * FILE as a download card with a humanized size; a "pending" bubble without
 * a key yet is mid-upload. Caption (body) renders below the attachment.
 */
function AttachmentBody({ message }: { message: ChatMessage }) {
  const [lightbox, setLightbox] = useState(false);
  const url = useSignedMediaUrl(message.attachmentKey);
  const waitingForUpload =
    message.pending && message.type !== "TEXT" && !message.attachmentKey;

  if (message.type === "IMAGE" || message.type === "FILE") {
    return (
      <>
        {waitingForUpload && <UploadingPlaceholder />}
        {!waitingForUpload && message.type === "IMAGE" && message.attachmentKey && (
          <>
            {url ? (
              <button
                type="button"
                onClick={() => setLightbox(true)}
                title="Open image"
                className="block"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={message.attachmentName ?? "Shared image"}
                  loading="lazy"
                  width={message.attachmentWidth ?? undefined}
                  height={message.attachmentHeight ?? undefined}
                  className="max-h-80 w-auto max-w-full rounded-lg object-contain"
                />
              </button>
            ) : (
              <div
                aria-label="Loading image"
                className="h-48 w-64 animate-pulse rounded-lg bg-zinc-700/40"
              />
            )}
          </>
        )}
        {!waitingForUpload && message.type === "FILE" && message.attachmentKey && (
          <a
            href={url ?? "#"}
            download={message.attachmentName ?? true}
            aria-disabled={!url}
            onClick={(e) => {
              if (!url) e.preventDefault();
            }}
            className={`flex items-center gap-3 rounded-xl bg-zinc-900/70 px-3 py-2 text-left ring-1 ring-white/10 transition-colors ${
              url ? "hover:bg-zinc-900" : ""
            }`}
            title="Download file"
          >
            <span aria-hidden className="text-2xl">📄</span>
            <span className="min-w-0">
              <span className="block max-w-48 truncate text-sm font-medium text-zinc-100">
                {message.attachmentName ?? "File"}
              </span>
              {message.attachmentSize != null && (
                <span className="text-[10px] text-zinc-500">
                  {humanizeSize(message.attachmentSize)}
                </span>
              )}
            </span>
            {url && <span className="ml-1 text-xs text-indigo-400">↓</span>}
          </a>
        )}
        {message.body && (
          <div className="mt-1 text-sm">
            <MarkdownLite text={message.body} />
          </div>
        )}
        {lightbox && url && (
          <Lightbox
            src={url}
            alt={message.attachmentName ?? "Shared image"}
            onClose={() => setLightbox(false)}
          />
        )}
      </>
    );
  }

  return message.body ? <MarkdownLite text={message.body} /> : null;
}

function UploadingPlaceholder() {
  return (
    <div className="flex h-16 items-center justify-center rounded-lg bg-zinc-900/60 px-4 text-xs text-zinc-400">
      Uploading…
    </div>
  );
}