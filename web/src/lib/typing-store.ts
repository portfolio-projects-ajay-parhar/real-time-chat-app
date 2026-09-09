"use client";

import { useSyncExternalStore } from "react";

/**
 * Client-side typing state — local, ephemeral, never persisted (PLAN
 * §frontend state model). Fed ONLY by `typing:update` events; each listed
 * user's timer is refreshed on every event and users are evicted after 4 s
 * of silence (server broadcast throttle is 2 s, so continuous typers stay
 * visible). Merge semantics: incoming userIds are added/refreshed, removal
 * is always by timeout — robust against the instance-local server registry
 * (see ws/src/handlers/typing.ts).
 */

const TYPING_TTL_MS = 4_000; // keep in sync with ws TYPING_TTL_MS
const EMPTY: string[] = [];

type Listener = (snapshot: Record<string, string[]>) => void;

const listeners = new Set<Listener>();
// conversationId → Map<userId, eviction timer>
const typers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
let snapshot: Record<string, string[]> = {};

function emit() {
  const next: Record<string, string[]> = {};
  for (const [conversationId, m] of typers) next[conversationId] = [...m.keys()];
  snapshot = next;
  for (const listener of listeners) listener(snapshot);
}

function removeTyper(conversationId: string, userId: string) {
  const m = typers.get(conversationId);
  if (!m || !m.delete(userId)) return;
  if (m.size === 0) typers.delete(conversationId);
  emit();
}

/** Feed a `typing:update` payload into the store. */
export function applyTypingUpdate(conversationId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  let m = typers.get(conversationId);
  if (!m) {
    m = new Map();
    typers.set(conversationId, m);
  }
  for (const userId of userIds) {
    const prev = m.get(userId);
    if (prev) clearTimeout(prev);
    m.set(
      userId,
      setTimeout(() => removeTyper(conversationId, userId), TYPING_TTL_MS)
    );
  }
  emit();
}

/** Clear everything (sign-out / socket teardown). */
export function resetTypingStore() {
  for (const m of typers.values()) for (const t of m.values()) clearTimeout(t);
  typers.clear();
  emit();
}

export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): Record<string, string[]> {
  return snapshot;
}

/** Reactive typing users for one conversation (excluding nobody — filter by viewer upstream). */
export function useTypingUsers(conversationId: string): string[] {
  const all = useSyncExternalStore(subscribe, getSnapshot);
  return all[conversationId] ?? EMPTY;
}