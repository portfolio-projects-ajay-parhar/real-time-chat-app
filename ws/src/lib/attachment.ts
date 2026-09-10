import type { AttachmentMime, MessageType } from "@chat/shared";
import { AttachmentMimeValues } from "@chat/shared";

/**
 * Attachment validation inside the `message:send` pipeline — defense in
 * depth (PLAN §security): the REST upload route already enforces size /
 * magic bytes, but a socket client could reference a key it never uploaded.
 * Room membership alone is never trusted, and neither is the payload's
 * attachment metadata.
 */
export type AttachmentCheck = { ok: true } | { ok: false; reason: string };

export function validateAttachment(input: {
  type: MessageType;
  mime: string;
  key: string;
  userId: string;
}): AttachmentCheck {
  if (!AttachmentMimeValues.includes(input.mime as AttachmentMime)) {
    return { ok: false, reason: `Attachment type ${input.mime} is not allowed` };
  }
  // Keys are minted server-side as `attachments/{uploaderId}/{cuid}-{name}` —
  // a client can never reference another user's object (or a crafted path).
  if (!input.key.startsWith(`attachments/${input.userId}/`) || input.key.includes("..")) {
    return { ok: false, reason: "Invalid attachment key" };
  }
  if (input.type === "IMAGE" && !input.mime.startsWith("image/")) {
    return { ok: false, reason: "IMAGE messages require an image attachment" };
  }
  if (input.type === "FILE" && input.mime.startsWith("image/")) {
    return { ok: false, reason: "FILE messages cannot use image attachments" };
  }
  return { ok: true };
}
