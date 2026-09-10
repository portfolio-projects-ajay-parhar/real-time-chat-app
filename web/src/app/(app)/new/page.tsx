"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Avatar } from "@/components/chat/Avatar";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

interface DirectoryUser {
  id: string;
  name: string;
  image: string | null;
  bio: string | null;
  lastSeenAt: string;
}

/**
 * /new (phase 8.1) — start a conversation: debounced user-directory search
 * → click starts a DIRECT (server advisory-lock dedupe makes double clicks
 * idempotent) or switch to the Group tab to build a named group with a
 * multi-select member picker.
 */
export default function NewConversationPage() {
  const router = useRouter();
  const [tab, setTab] = useState<"direct" | "group">("direct");
  const [query, setQuery] = useState("");
  const [groupName, setGroupName] = useState("");
  const [selected, setSelected] = useState<Map<string, DirectoryUser>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 250);

  const { data: users, isLoading } = useQuery({
    queryKey: ["users", debouncedQuery],
    queryFn: async (): Promise<DirectoryUser[]> => {
      const res = await fetch(`/api/users?q=${encodeURIComponent(debouncedQuery)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Search failed");
      const json = (await res.json()) as { users: DirectoryUser[] };
      return json.users;
    },
    enabled: debouncedQuery.trim().length >= 2,
  });

  const startDirect = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "DIRECT", userId }),
      });
      const payload: unknown = await res.json().catch(() => null);
      const conversation = (payload as { conversation?: { id?: string } } | null)?.conversation;
      if (!res.ok || !conversation?.id) {
        throw new Error(
          (payload as { message?: string } | null)?.message ?? "Could not start the chat"
        );
      }
      router.push(`/conversations/${conversation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the chat");
      setBusy(false);
    }
  };

  const toggleMember = (user: DirectoryUser) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(user.id)) next.delete(user.id);
      else next.set(user.id, user);
      return next;
    });
  };

  const createGroup = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "GROUP",
          name: groupName.trim(),
          memberIds: [...selected.keys()],
        }),
      });
      const payload: unknown = await res.json().catch(() => null);
      const conversation = (payload as { conversation?: { id?: string } } | null)?.conversation;
      if (!res.ok || !conversation?.id) {
        throw new Error(
          (payload as { message?: string } | null)?.message ?? "Could not create the group"
        );
      }
      router.push(`/conversations/${conversation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the group");
      setBusy(false);
    }
  };

  const searching = debouncedQuery.trim().length < 2;

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <Link
          href="/conversations"
          className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          aria-label="Back to chats"
        >
          ←
        </Link>
        <h1 className="text-lg font-semibold text-zinc-100">New conversation</h1>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800 px-4 pt-2">
        {(
          [
            ["direct", "Direct message"],
            ["group", "Group"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium ${
              tab === key
                ? "border-b-2 border-indigo-500 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-400" role="alert">
            {error}
          </div>
        )}

        {/* Group tab controls */}
        {tab === "group" && (
          <div className="mb-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400" htmlFor="group-name">
                Group name
              </label>
              <input
                id="group-name"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={80}
                placeholder="e.g. Weekend plans"
                className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            {selected.size > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {[...selected.values()].map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggleMember(u)}
                    className="flex items-center gap-1 rounded-full bg-indigo-600/30 px-2 py-0.5 text-xs text-indigo-200 hover:bg-indigo-600/50"
                  >
                    {u.name} ✕
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              disabled={busy || !groupName.trim() || selected.size < 1}
              onClick={() => void createGroup()}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Create group ({selected.size} member{selected.size === 1 ? "" : "s"})
            </button>
          </div>
        )}

        {/* Directory search */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people by name or email…"
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-indigo-500"
        />

        <div className="mt-3 space-y-1">
          {searching && (
            <p className="p-4 text-center text-sm text-zinc-500">
              Type at least 2 characters to search the directory.
            </p>
          )}
          {!searching && isLoading && (
            <p className="p-4 text-center text-sm text-zinc-500">Searching…</p>
          )}
          {!searching && !isLoading && users && users.length === 0 && (
            <p className="p-4 text-center text-sm text-zinc-500">No users found.</p>
          )}
          {users?.map((u) => {
            const isSelected = selected.has(u.id);
            return (
              <button
                key={u.id}
                type="button"
                disabled={busy}
                onClick={() => (tab === "direct" ? void startDirect(u.id) : toggleMember(u))}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-zinc-800/60 disabled:opacity-50 ${
                  isSelected ? "bg-zinc-800" : ""
                }`}
              >
                <Avatar name={u.name} imageKey={u.image} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-100">
                    {u.name}
                  </span>
                  {u.bio && (
                    <span className="block truncate text-xs text-zinc-500">{u.bio}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {tab === "direct" ? "Chat →" : isSelected ? "Selected ✓" : "Select"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

