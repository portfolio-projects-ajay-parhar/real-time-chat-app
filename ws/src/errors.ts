import type { Socket } from "socket.io";
import { S2C, type ApiErrorCode, type ApiErrorPayload } from "@chat/shared";

/**
 * Emit a typed error event to a single socket.
 * Ack-based flows return `{ ok: false, code, message }` instead —
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

/** Build the error half of an ack payload (`{ ok: false, code, message }`). */
export function ackError(code: ApiErrorCode, message: string): ApiErrorPayload {
  return { ok: false, code, message };
}
