"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ConversationItem } from "./ConversationItem";
import { NotificationsChip } from "./NotificationsChip";
import { inboxQuery } from "@/lib/queries";

/**
 * The conversation list pane — rendered in the desktop split view's sidebar
 * (320px column) by (app)/layout.tsx. On mobile it is hidden and the
 * /conversations page renders the same list full-screen instead.
 */
export function SidebarList({ viewerId }: { viewerId: string }) {
  const pathname = usePathname();
  const { data, isLoading, isError } = useQuery(inboxQuery);

  return (
    <>
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-100">Chats</h1>
        <div className="flex items-center gap-2">
          <NotificationsChip />
          <Link
            href="/new"
            className={`rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 ${
              pathname === "/new" ? "opacity-50" : ""
            }`}
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
          <ConversationItem
            key={c.id}
            conversation={c}
            viewerId={viewerId}
            active={pathname === `/conversations/${c.id}`}
          />
        ))}
      </div>
    </>
  );
}
