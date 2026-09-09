"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { ConversationItem } from "@/components/chat/ConversationItem";
import type { InboxConversation } from "@/lib/chat-cache";

/**
 * The inbox — server-rendered shell, TanStack Query for data so socket
 * events (message:new / unread:update / presence) can patch this cache live.
 */
export default function ConversationsPage() {
  const { data: session } = useSession();
  const viewerId = session?.user?.id ?? "";

  const { data, isLoading, isError } = useQuery({
    queryKey: ["conversations"],
    queryFn: async (): Promise<InboxConversation[]> => {
      const res = await fetch("/api/conversations", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load conversations");
      const json = (await res.json()) as { conversations: InboxConversation[] };
      return json.conversations;
    },
  });

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col md:max-w-lg">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-100">Chats</h1>
        <span className="text-xs text-zinc-500">{session?.user?.name}</span>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && <div className="p-6 text-center text-sm text-zinc-500">Loading…</div>}
        {isError && (
          <div className="p-6 text-center text-sm text-red-400">Could not load your chats.</div>
        )}
        {data && data.length === 0 && (
          <div className="p-6 text-center text-sm text-zinc-500">
            No conversations yet.
          </div>
        )}
        {data?.map((c) => (
          <ConversationItem key={c.id} conversation={c} viewerId={viewerId} />
        ))}
      </div>
    </div>
  );
}
