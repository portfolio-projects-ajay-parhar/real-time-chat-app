/**
 * Message-timeline grouping helpers — pure functions (unit-tested in
 * web/test/message-grouping.test.ts) driving the date separators and the
 * "avatar/name on the first bubble of a run" sender grouping (phase 8.4).
 */

/** Same calendar day (local time) for two ISO timestamps. */
export function isSameLocalDay(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Human day label: "Today" / "Yesterday" / localized date (year only when
 * not the current year). Intl-based — no extra dependency.
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameLocalDay(iso, now.toISOString())) return "Today";
  if (isSameLocalDay(iso, yesterday.toISOString())) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** A date separator renders before the first message and after every day change. */
export function shouldShowDateSeparator(prevIso: string | undefined, iso: string): boolean {
  if (!prevIso) return true;
  return !isSameLocalDay(prevIso, iso);
}

/** Consecutive-sender window for grouping bubbles (PLAN §component inventory). */
export const SENDER_GROUP_WINDOW_MS = 5 * 60_000;

export interface GroupingMessage {
  senderId: string | null;
  type: "TEXT" | "IMAGE" | "FILE" | "SYSTEM";
  createdAt: string;
}

/**
 * Sender grouping: avatar+name render only on the FIRST bubble of a run —
 * same sender, consecutive, neither is SYSTEM, and ≤5 minutes apart.
 */
export function shouldShowSender(prev: GroupingMessage | undefined, msg: GroupingMessage): boolean {
  if (!prev) return true;
  if (prev.type === "SYSTEM" || msg.type === "SYSTEM") return true;
  if (prev.senderId !== msg.senderId) return true;
  return new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() > SENDER_GROUP_WINDOW_MS;
}
