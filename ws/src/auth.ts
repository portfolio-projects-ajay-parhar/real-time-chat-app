import type { DefaultEventsMap, Socket } from "socket.io";
import { decode } from "next-auth/jwt";
import { prisma } from "./lib/prisma.js";
import { emitError } from "./errors.js";

/** Per-socket server-side state (lives on `socket.data`). */
export interface SocketData {
  userId: string;
  /** Conversation rooms joined at connect — a routing cache, never an auth check. */
  joinedConversationIds: string[];
}

export type ChatSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

// NextAuth v4 default session cookies (secure variant behind https)
const SESSION_COOKIE = "next-auth.session-token";
const SESSION_COOKIE_SECURE = "__Secure-next-auth.session-token";

function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if ((name === SESSION_COOKIE || name === SESSION_COOKIE_SECURE) && value) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/**
 * Resolve the socket's user id from the handshake:
 *   1. `auth.token` — raw JWE from GET /api/ws-token (explicit fallback)
 *   2. session cookie — the primary path; the Next.js dev/prod proxy
 *      (`/socket.io/ws` rewrite) forwards it same-origin.
 * The token is verified with the shared NEXTAUTH_SECRET. A token whose user
 * no longer exists is treated as unauthenticated (ghost sockets never join).
 */
export async function resolveHandshakeUserId(
  socket: Socket,
  secret: string
): Promise<string | null> {
  const authToken = socket.handshake.auth?.token;
  const raw =
    (typeof authToken === "string" && authToken.length > 0 ? authToken : null) ??
    readSessionCookie(socket.handshake.headers.cookie);
  if (!raw) return null;

  try {
    const payload = await decode({ token: raw, secret });
    const userId = payload?.sub;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return user ? userId : null;
  } catch {
    return null;
  }
}

/** Socket.IO middleware — attaches `socket.data.userId` or rejects the handshake. */
export function authMiddleware(secret: string) {
  return async (socket: ChatSocket, next: (err?: Error) => void) => {
    const userId = await resolveHandshakeUserId(socket, secret);
    if (!userId) {
      // The error packet emitted below may not be delivered to a rejected
      // handshake — clients should read the connect_error message ("UNAUTHENTICATED").
      emitError(socket, "UNAUTHENTICATED", "Authentication required");
      return next(new Error("UNAUTHENTICATED"));
    }
    socket.data.userId = userId;
    socket.data.joinedConversationIds = [];
    next();
  };
}
