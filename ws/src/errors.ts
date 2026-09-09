import type { Socket } from "socket.io";
import { S2C, type ApiErrorCode } from "@chat/shared";

/**
 * Emit a typed error event to a single socket.
 * Ack-based flows (Phase 6) return `{ ok: false, code, message }` instead —
 * this is for out-of-band errors like room-scoped failures.
 */
export function emitError(
  socket: Socket,
  code: ApiErrorCode,
  message: string,
  scope?: string
) {
  socket.emit(S2C.ERROR, { code, message, ...(scope ? { scope } : {}) });
}
