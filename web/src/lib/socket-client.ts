"use client";

import { io, type Socket } from "socket.io-client";
import { signOut } from "next-auth/react";
import { CONN } from "@chat/shared";

/**
 * Singleton chat socket — one connection per tab, created lazily on the
 * client only. The handshake rides the same-origin Next rewrite
 * (`/socket.io/ws` → ws server) so the session cookie goes along for free;
 * `auth.token` (raw JWE from GET /api/ws-token) is the explicit fallback for
 * environments where the cookie doesn't survive the proxy.
 */
let socketPromise: Promise<Socket> | null = null;

export function getChatSocket(): Promise<Socket> | null {
  if (typeof window === "undefined") return null;
  if (!socketPromise) {
    socketPromise = (async () => {
      let token: string | undefined;
      try {
        const res = await fetch("/api/ws-token", { cache: "no-store" });
        if (res.ok) {
          const data: unknown = await res.json();
          if (
            data &&
            typeof data === "object" &&
            "token" in data &&
            typeof (data as { token: unknown }).token === "string"
          ) {
            token = (data as { token: string }).token;
          }
        }
      } catch {
        // ws-token is a fallback — the cookie handshake may still succeed
      }

      const socket = io({
        path: "/socket.io/ws",
        transports: ["websocket"],
        reconnectionDelayMax: 5000,
        ...(token ? { auth: { token } } : {}),
      });

      // A rejected handshake surfaces as connect_error("UNAUTHENTICATED")
      // (see ws/src/auth.ts) — bounce to sign-in.
      socket.on(CONN.CONNECT_ERROR, (err: Error) => {
        if (err.message === "UNAUTHENTICATED") {
          void signOut({ callbackUrl: "/signin" });
        }
      });

      return socket;
    })();
  }
  return socketPromise;
}

/** Test/dev hook — drops the singleton so a fresh connect can be forced. */
export function resetChatSocket() {
  socketPromise = null;
}