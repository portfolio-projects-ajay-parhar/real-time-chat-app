import { ApiError } from "./api";
import { AttachmentMimeValues } from "@chat/shared";

/** 10 MB hard cap (matches attachmentSchema.max in @chat/shared). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** MIME allowlist — single source of truth in @chat/shared. */
export const ALLOWED_MIMES = AttachmentMimeValues;

export type AllowedMime = (typeof ALLOWED_MIMES)[number];

/**
 * Hand-rolled magic-byte sniffer (avoids a `file-type` dependency).
 * Returns the detected MIME or null when nothing matches — `text/plain`
 * has no signature and is handled by the UTF-8/NUL-byte check below.
 */
export function sniffMime(buf: Buffer): AllowedMime | null {
  if (buf.length < 4) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF: GIF87a / GIF89a
  if (
    buf.subarray(0, 6).toString("ascii") === "GIF87a" ||
    buf.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif";
  }
  // WEBP: RIFF .... WEBP
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.length >= 12 &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  // PDF: %PDF-
  if (buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function looksLikePlainText(buf: Buffer): boolean {
  try {
    const s = buf.toString("utf8");
    if (s.includes("\uFFFD")) return false; // replacement char → not valid UTF-8
    return !s.includes("\0"); // NUL bytes → binary
  } catch {
    return false;
  }
}

export interface ValidateUploadArgs {
  buffer: Buffer;
  declaredMime: string;
}

export interface ValidatedUpload {
  mime: AllowedMime;
}

/**
 * Validate an uploaded attachment: size cap, MIME allowlist and
 * content-sniffing (declared MIME alone is never trusted).
 * Throws ApiError: 413 oversize, 415 bad mime / magic mismatch.
 */
export function validateUpload({ buffer, declaredMime }: ValidateUploadArgs): ValidatedUpload {
  if (buffer.length === 0) {
    throw new ApiError("VALIDATION", "Empty file", 415);
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw ApiError.payloadTooLarge("Files may be at most 10 MB");
  }
  if (!ALLOWED_MIMES.includes(declaredMime as AllowedMime)) {
    throw new ApiError(
      "VALIDATION",
      `File type ${declaredMime} is not allowed`,
      415
    );
  }

  const sniffed = sniffMime(buffer);

  if (declaredMime === "text/plain") {
    // No signature for plain text — reject anything binary-looking.
    if (sniffed !== null || !looksLikePlainText(buffer)) {
      throw new ApiError("VALIDATION", "File content does not match text/plain", 415);
    }
    return { mime: "text/plain" };
  }

  if (sniffed === null) {
    throw new ApiError("VALIDATION", "Unrecognized or corrupted file content", 415);
  }
  if (sniffed !== declaredMime) {
    throw new ApiError(
      "VALIDATION",
      "File content does not match its declared type",
      415
    );
  }
  return { mime: sniffed };
}
