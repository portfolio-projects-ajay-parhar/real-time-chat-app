/**
 * Humanized "last seen" — deliberately tiny (no date-fns dependency for one
 * string). Windows: <1min "just now", minutes, hours, days, and a generic
 * phrase past a week (the UI renders plain "offline" for those instead).
 */
export function relativeLastSeen(iso: string, now: number = Date.now()): string {
  const diffMs = now - new Date(iso).getTime();
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return "a while ago";
}

/** Recent enough to show "last seen X" rather than a bare "offline". */
export function isRecentLastSeen(iso: string, now: number = Date.now()): boolean {
  return now - new Date(iso).getTime() < 7 * 24 * 60 * 60_000;
}