import type { InboxConversation } from "@/lib/chat-cache";

/**
 * Shared TanStack Query definitions for data read from more than one place
 * (the mobile inbox page AND the desktop sidebar) — one cache key means one
 * live copy that socket events patch once.
 */
export const inboxQuery = {
  queryKey: ["conversations"] as const,
  queryFn: async (): Promise<InboxConversation[]> => {
    const res = await fetch("/api/conversations", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load conversations");
    const json = (await res.json()) as { conversations: InboxConversation[] };
    return json.conversations;
  },
};
