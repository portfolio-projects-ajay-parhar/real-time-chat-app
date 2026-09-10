"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { ConversationItem } from "@/components/chat/ConversationItem";
import { inboxQuery } from "@/lib/queries";

/**
 * The inbox — mobile full-screen list (the desktop split view renders the
 * same list in the layout's sidebar). TanStack Query for data so socket
 * events (message:new / unread:update / presence) can patch this cache live.
 */
export default function ConversationsPage() {
  const { data: session } = useSession();
  const viewerId = session?.user?.id ?? "";

  const { data, isLoading, isError } = useQuery(inboxQuery);

  return (
    <>
      {/* Mobile — full-screen list; desktop renders the list in the sidebar. */}
      <div className="mx-auto flex h-dvh max-w-md flex-col md:hidden">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h1 className="text-lg font-semibold text-zinc-100">Chats</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">{session?.user?.name}</span>
            <Link
              href="/new"
              className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
            >
              New chat
            </Link>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-2">
          {isLoading && <div className="p-6 text-center text-sm text-zinc-500">Loading…</div>}
          {isError && (
            <div className="p-6 text-center text-sm text-red-400">Could not load your chats.</div>
          )}
          {data && data.length === 0 && (
            <div className="p-6 text-center text-sm text-zinc-500">
              No conversations yet.
              <Link href="/new" className="mt-2 block text-indigo-400 hover:underline">
                Start one →
              </Link>
            </div>
          )}
          {data?.map((c) => (
            <ConversationItem key={c.id} conversation={c} viewerId={viewerId} />
          ))}
        </div>
      </div>

      {/* Desktop — the sidebar owns the list; this pane is the empty state. */}
      <div className="hidden h-dvh items-center justify-center md:flex">
        <div className="text-center">
          <p className="text-sm text-zinc-400">Select a conversation to start chatting</p>
          <Link
            href="/new"
            className="mt-3 inline-block rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          >
            New chat
          </Link>
        </div>
      </div>
    </>
  );
}
