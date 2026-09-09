import { ApiError } from "./api";

/**
 * Keyset (cursor) pagination helpers for message history.
 *
 * Cursor = base64url("{createdAtISO}~{id}") over the oldest loaded message.
 * The `id` tiebreak keeps pages stable under same-millisecond bursts —
 * unlike offset pagination, a new message appended while the client pages
 * back never shifts the window.
 */
export const encodeCursor = (m: { createdAt: Date; id: string }) =>
  Buffer.from(`${m.createdAt.toISOString()}~${m.id}`).toString("base64url");

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function decodeCursor(cursor: string): Cursor {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw ApiError.validation("Invalid cursor");
  }
  const sep = raw.lastIndexOf("~");
  if (sep <= 0) throw ApiError.validation("Invalid cursor");
  const iso = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const createdAt = new Date(iso);
  if (!id || Number.isNaN(createdAt.getTime())) {
    throw ApiError.validation("Invalid cursor");
  }
  return { createdAt, id };
}
