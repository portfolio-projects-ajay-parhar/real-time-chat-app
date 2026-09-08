import { Redis } from "ioredis";
import { prisma } from "./prisma";

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;

/**
 * Fixed-window rate limiter on a Redis counter.
 * Returns true if the action is allowed, false when over `limit` per `windowSec`.
 * Redis is best-effort: on connection failure we fail open (log + allow).
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<boolean> {
  try {
    if (redis.status !== "ready") await redis.connect().catch(() => {});
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return count <= limit;
  } catch (err) {
    console.error("[rate-limit] redis unavailable, failing open:", err);
    return true;
  }
}

/** Read the current count of a fixed-window counter (for tests/observability). */
export async function getRateLimitCount(key: string): Promise<number> {
  const raw = await redis.get(key);
  return raw ? parseInt(raw, 10) : 0;
}
