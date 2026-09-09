import type { Redis } from "ioredis";

/**
 * Redis fixed-window rate limiter for socket sends (PLAN §security):
 * 30 messages / 10 s per user, else the ack returns `RATE_LIMITED`.
 *
 * The INCR + EXPIRE pair runs as one Lua script so a crash between the two
 * can never leave a windowless counter (a key that counts forever and locks
 * the user out permanently). Fail-open on Redis trouble — a chat must not
 * stop working because the limiter's backing store hiccupped; the same
 * trade-off the web REST limiter makes.
 */
const INCR_EXPIRE_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

export const SEND_RATE_LIMIT = 30;
export const SEND_RATE_WINDOW_S = 10;

export const sendRateLimitKey = (userId: string) => `ratelimit:${userId}:msg`;

/** Returns true when the send is allowed, false when over the window budget. */
export async function checkSendRateLimit(
  redis: Redis,
  userId: string,
  limit: number = SEND_RATE_LIMIT,
  windowSec: number = SEND_RATE_WINDOW_S
): Promise<boolean> {
  try {
    const n = await redis.eval(
      INCR_EXPIRE_LUA,
      1,
      sendRateLimitKey(userId),
      String(windowSec)
    );
    return Number(n) <= limit;
  } catch (err) {
    console.error("[rate-limit] redis unavailable, failing open:", err);
    return true;
  }
}