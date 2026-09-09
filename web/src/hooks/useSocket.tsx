"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Socket } from "socket.io-client";
import { getChatSocket } from "@/lib/socket-client";
import { resetTypingStore } from "@/lib/typing-store";
import { useChatEvents } from "./useChatEvents";

const SocketContext = createContext<Socket | null>(null);

/**
 * Owns the chat socket for the authenticated part of the app (mounted once
 * in `(app)/layout.tsx`): connects the singleton on mount, runs the
 * socket-event → Query-cache bridge exactly once, and hands the socket to
 * any component that needs to emit (composer, typing, read marks).
 */
export function SocketProvider({
  children,
  viewerId,
}: {
  children: ReactNode;
  viewerId: string;
}) {
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const promise = getChatSocket();
    if (!promise) return;
    let cancelled = false;
    promise.then((s) => {
      if (!cancelled) setSocket(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Leave nothing ghost-typing behind when the tab context goes away.
  useEffect(() => () => resetTypingStore(), []);

  useChatEvents(socket, viewerId);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

/** The chat socket, or null until the (async) connect completes. */
export function useSocket(): Socket | null {
  return useContext(SocketContext);
}