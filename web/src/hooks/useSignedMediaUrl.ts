"use client";

import { useEffect, useState } from "react";
import { getCachedSignedMediaUrl, getSignedMediaUrl } from "@/lib/media-url";

/**
 * Resolve a storage key to a fresh signed URL (cached module-wide, see
 * lib/media-url.ts). Returns null while resolving or when there is no key.
 * Warm cache hits render synchronously; the async sign response arrives via
 * the effect's subscription callback.
 */
export function useSignedMediaUrl(key: string | null | undefined): string | null {
  // Async resolution result, keyed so it never leaks across keys.
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null);

  const cached = key ? getCachedSignedMediaUrl(key) : null;
  const url = key ? (cached ?? (resolved?.key === key ? resolved.url : null)) : null;

  useEffect(() => {
    if (!key || cached) return;
    let alive = true;
    getSignedMediaUrl(key)
      .then((signed) => {
        if (alive) setResolved({ key, url: signed });
      })
      .catch(() => {
        // leave the previous state; the component renders its placeholder
      });
    return () => {
      alive = false;
    };
  }, [key, cached]);

  return url;
}