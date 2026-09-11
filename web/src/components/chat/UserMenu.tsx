"use client";

import { signOut, useSession } from "next-auth/react";
import { Avatar } from "./Avatar";

/**
 * Signed-in user footer: avatar, display name, email and the sign-out
 * action. Rendered at the bottom of the desktop sidebar; the mobile inbox
 * header embeds the same sign-out button inline.
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { data: session } = useSession();
  const user = session?.user;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => void signOut({ callbackUrl: "/signin" })}
        title={`Sign out (${user?.name ?? "you"})`}
        aria-label="Sign out"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 ring-1 ring-white/5 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
      >
        ⏻
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2.5 border-t border-zinc-800/80 px-3 py-3">
      <Avatar name={user?.name ?? "You"} imageKey={user?.image ?? null} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-100">{user?.name ?? "Signed in"}</div>
        <div className="truncate text-[11px] text-zinc-500">{user?.email}</div>
      </div>
      <button
        type="button"
        onClick={() => void signOut({ callbackUrl: "/signin" })}
        title="Sign out"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 ring-1 ring-white/5 transition-colors hover:bg-red-500/20 hover:text-red-400"
      >
        ⏻
      </button>
    </div>
  );
}