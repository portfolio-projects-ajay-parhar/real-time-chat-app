"use client";

import { useSyncExternalStore } from "react";
import type { PresenceUpdateEvent } from "@chat/shared";

/**
 * Client-side presence map — the live picture of who is online, fed ONLY by
 * `presence:update` events (PLAN §presence UX). Initial state comes from the
 * REST surfaces (inbox `member.online`, `user.lastSeenAt`); this store wins
 * once the first event lands and heals on every transition. Same pattern as
 * typing-store: module-level state + `useSyncExternalStore`, no React
 * context, no extra dependency.
 */

export interface PresenceEntry {
  online: boolean;
  /** Server-reported last-seen for offline transitions; null otherwise. */
  lastSeenAt: string | null;
}

type Listener = (snapshot: Record<string, PresenceEntry>) => void;

const listeners = new Set<Listener>();
/** Stable server-render snapshot — the store is empty until a socket event lands. */
const EMPTY_SNAPSHOT: Record<string, PresenceEntry> = {};
let presence: Record<string, PresenceEntry> = {};
let snapshot: Record<string, PresenceEntry> = presence;

function emit() {
  snapshot = { ...presence };
  for (const listener of listeners) listener(snapshot);
}

/** Feed a `presence:update` payload into the store. */
export function applyPresenceUpdate(
  userId: string,
  status: PresenceUpdateEvent["status"],
  lastSeenAt?: string
): void {
  const prev = presence[userId];
  const next: PresenceEntry = {
    online: status === "online",
    lastSeenAt: lastSeenAt ?? prev?.lastSeenAt ?? null,
  };
  if (prev && prev.online === next.online && prev.lastSeenAt === next.lastSeenAt) return;
  presence = { ...presence, [userId]: next };
  emit();
}

/** Clear everything (sign-out / socket teardown). */
export function resetPresenceStore() {
  presence = {};
  emit();
}

export function subscribePresence(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPresenceSnapshot(): Record<string, PresenceEntry> {
  return snapshot;
}

/** Server snapshot (required for SSR) — no presence exists pre-hydration. */
export function getPresenceServerSnapshot(): Record<string, PresenceEntry> {
  return EMPTY_SNAPSHOT;
}

/** The whole presence map — use for GROUP "N online" counts (stable hook). */
export function usePresenceMap(): Record<string, PresenceEntry> {
  return useSyncExternalStore(subscribePresence, getPresenceSnapshot, getPresenceServerSnapshot);
}

/** Live presence of one user (undefined until the first event). */
export function usePresence(userId: string): PresenceEntry | undefined {
  const all = useSyncExternalStore(subscribePresence, getPresenceSnapshot, getPresenceServerSnapshot);
  return all[userId];
}