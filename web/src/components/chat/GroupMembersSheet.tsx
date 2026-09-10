"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar } from "./Avatar";
import { usePresenceMap } from "@/lib/presence-store";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { isRecentLastSeen, relativeLastSeen } from "@/lib/relative-time";
import type { ConversationDetail } from "@/lib/chat-cache";

interface DirectoryUser {
  id: string;
  name: string;
  image: string | null;
  bio: string | null;
  lastSeenAt: string;
}

/**
 * Group management sheet (phase 8.2): members with role chips + presence,
 * OWNER actions (add / remove / rename), and leave-group with the
 * last-owner 409 surfaced as an inline hint. Every mutation is REST; the
 * SYSTEM messages they persist land in the timeline via the invalidated
 * history cache (edit/delete propagation scope, §phase 8.3 note).
 */
export function GroupMembersSheet({
  conversation,
  viewerId,
  open,
  onClose,
}: {
  conversation: ConversationDetail;
  viewerId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const presenceMap = usePresenceMap();
  const isOwner = conversation.members.some(
    (m) => m.id === viewerId && m.role === "OWNER"
  );

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(conversation.name ?? "");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);

  useEffect(() => {
    if (open) {
      setError(null);
      setName(conversation.name ?? "");
      setSearch("");
    }
  }, [open, conversation.name]);

  // Add-member directory — existing members filtered out.
  const { data: candidates } = useQuery({
    queryKey: ["users", debouncedSearch],
    queryFn: async (): Promise<DirectoryUser[]> => {
      const res = await fetch(`/api/users?q=${encodeURIComponent(debouncedSearch)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Search failed");
      const json = (await res.json()) as { users: DirectoryUser[] };
      return json.users;
    },
    enabled: open && isOwner && debouncedSearch.trim().length >= 2,
  });
  const memberIds = new Set(conversation.members.map((m) => m.id));
  const addable = (candidates ?? []).filter((u) => !memberIds.has(u.id));

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversation.id] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    void queryClient.invalidateQueries({ queryKey: ["messages", conversation.id] });
  };

  const mutate = async (
    fn: () => Promise<Response>,
    success?: () => void
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const payload: unknown = await res.json().catch(() => null);
        const message =
          (payload as { message?: string } | null)?.message ?? "Something went wrong";
        setError(message);
        return false;
      }
      refresh();
      success?.();
      return true;
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Group members">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <aside className="relative flex h-full w-80 max-w-full flex-col border-l border-zinc-800 bg-zinc-900">
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">
            Members · {conversation.members.length}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          {error && (
            <div className="mb-3 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-400" role="alert">
              {error}
            </div>
          )}

          {isOwner && (
            <div className="mb-4">
              <label className="mb-1 block text-xs font-medium text-zinc-400" htmlFor="group-name">
                Group name
              </label>
              <div className="flex gap-2">
                <input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  disabled={busy || !name.trim() || name.trim() === conversation.name}
                  onClick={() =>
                    void mutate(async () => {
                      const res = await fetch(`/api/conversations/${conversation.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name: name.trim() }),
                      });
                      if (res.ok) onClose();
                      return res;
                    })
                  }
                  className="rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  Rename
                </button>
              </div>
            </div>
          )}

          <ul className="space-y-1">
            {conversation.members.map((m) => {
              const online = presenceMap[m.id]?.online;
              const lastSeenAt = presenceMap[m.id]?.lastSeenAt ?? m.user.lastSeenAt;
              return (
                <li key={m.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-800/60">
                  <Avatar name={m.user.name} imageKey={m.user.image} size={32} online={online} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-zinc-100">
                        {m.user.name}
                        {m.id === viewerId && <span className="text-zinc-500"> (you)</span>}
                      </span>
                      {m.role === "OWNER" && (
                        <span className="rounded bg-indigo-600/30 px-1 text-[10px] font-medium text-indigo-300">
                          owner
                        </span>
                      )}
                    </div>
                    <span className={`text-[10px] ${online ? "text-emerald-400" : "text-zinc-500"}`}>
                      {online
                        ? "online"
                        : isRecentLastSeen(lastSeenAt)
                          ? `last seen ${relativeLastSeen(lastSeenAt)}`
                          : "offline"}
                    </span>
                  </div>
                  {isOwner && m.id !== viewerId && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(() =>
                          fetch(`/api/conversations/${conversation.id}/members/${m.id}`, {
                            method: "DELETE",
                          })
                        )
                      }
                      className="rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10"
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {isOwner && (
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-zinc-400" htmlFor="add-member">
                Add members
              </label>
              <input
                id="add-member"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search users…"
                className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-indigo-500"
              />
              {debouncedSearch.trim().length >= 2 && addable.length === 0 && (
                <p className="mt-2 text-xs text-zinc-500">No users found.</p>
              )}
              <ul className="mt-1 space-y-1">
                {addable.map((u) => (
                  <li key={u.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-800/60">
                    <Avatar name={u.name} imageKey={u.image} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{u.name}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(() =>
                          fetch(`/api/conversations/${conversation.id}/members`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ userIds: [u.id] }),
                          })
                        )
                      }
                      className="rounded bg-indigo-600/80 px-2 py-0.5 text-[10px] text-white hover:bg-indigo-500"
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <footer className="border-t border-zinc-800 p-3">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void mutate(
                () =>
                  fetch(`/api/conversations/${conversation.id}/members/${viewerId}`, {
                    method: "DELETE",
                  }),
                () => {
                  onClose();
                  router.push("/conversations");
                }
              )
            }
            className="w-full rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            Leave group
          </button>
        </footer>
      </aside>
    </div>
  );
}
