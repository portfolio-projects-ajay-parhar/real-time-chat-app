/**
 * Client-side signed media URLs (Phase 9 "fetch-time signing").
 *
 * Local-provider HMAC links expire; S3/Cloudinary presigned URLs too. Instead
 * of baking a URL into persisted data, components resolve a storage key to a
 * fresh URL at render time through `GET /api/media/sign` and cache the result
 * in this module (one fetch per key per cache lifetime, shared by every
 * component — bubbles, lightbox, avatars, notification icons).
 *
 * The sign route signs URLs for 1 h; the cache refreshes at 55 min so a
 * rendered `<img>` never sees an expired link.
 */

const CACHE_TTL_MS = 55 * 60_000;

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Sync read — warm hits render synchronously, no placeholder flash. */
export function getCachedSignedMediaUrl(key: string): string | null {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  if (hit) cache.delete(key);
  return null;
}

export async function getSignedMediaUrl(key: string): Promise<string> {
  const cached = getCachedSignedMediaUrl(key);
  if (cached) return cached;

  const res = await fetch(`/api/media/sign?key=${encodeURIComponent(key)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to sign media URL");
  const json = (await res.json()) as { url: string };
  cache.set(key, { url: json.url, expiresAt: Date.now() + CACHE_TTL_MS });
  return json.url;
}

/** Test hook — drop every cached URL (e.g. between tests). */
export function clearMediaUrlCache(): void {
  cache.clear();
}