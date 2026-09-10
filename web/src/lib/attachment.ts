import { AttachmentMimeValues } from "@chat/shared";

/**
 * Client-side attachment helpers — the pre-upload gate in front of
 * POST /api/media. The server re-checks everything (allowlist + magic bytes +
 * 10 MB); this gives instant 413/415 feedback without a round trip.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type AttachmentKind = "IMAGE" | "FILE";

export type AttachmentCheck =
  | { ok: true; kind: AttachmentKind }
  | { ok: false; status: 413 | 415; message: string };

export function checkAttachment(file: File): AttachmentCheck {
  if (file.size === 0) {
    return { ok: false, status: 415, message: "Empty files can't be sent" };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, status: 413, message: "Files may be at most 10 MB" };
  }
  const mime = file.type || "application/octet-stream";
  if (!(AttachmentMimeValues as readonly string[]).includes(mime)) {
    return { ok: false, status: 415, message: `File type ${mime} is not allowed` };
  }
  return { ok: true, kind: mime.startsWith("image/") ? "IMAGE" : "FILE" };
}

/** "1.2 MB" / "340 KB" / "3 B" — file cards + previews. */
export function humanizeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Client-measured image dimensions (PLAN §9.2) — sent with the message so
 * the inline render reserves space and never layout-shifts.
 */
export async function measureImageDimensions(
  file: File
): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith("image/")) return null;
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const dims = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dims;
    } catch {
      // fall through to the <img> decode path
    }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.height });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** POST /api/media → the attachment metadata `message:send` expects. */
export interface UploadedAttachment {
  key: string;
  name: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
}

export class UploadError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/media", { method: "POST", body: form });
  const json: unknown = await res.json().catch(() => null);
  const body = (json ?? {}) as { key?: string; name?: string; size?: number; mime?: string; message?: string };
  if (!res.ok || !body.key) {
    throw new UploadError(
      res.status,
      body.message ?? (res.status === 413 ? "Files may be at most 10 MB" : "Upload failed")
    );
  }
  return {
    key: body.key,
    name: body.name ?? file.name,
    size: body.size ?? file.size,
    mime: body.mime ?? file.type,
  };
}