/**
 * Unit — send rate limiter (ws/src/rateLimit.ts).
 * Redis is stubbed with the exact semantics of the INCR+EXPIRE Lua script;
 * the interesting behavior is the window boundary and fail-open.
 */
import { describe, expect, it, vi } from "vitest";
import { checkSendRateLimit, sendRateLimitKey } from "../src/rateLimit.js";

function stubRedis() {
  const counters = new Map<string, number>();
  return {
    counters,
    async eval(_lua: string, _num: number, key: string, windowSec: string) {
      // mirrors the script: INCR, then EXPIRE when the key was created
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    },
    expire(key: string) {
      // simulate window expiry
      counters.delete(key);
    },
  };
}

describe("checkSendRateLimit", () => {
  it("allows up to the limit and blocks the (limit+1)-th send", async () => {
    const redis = stubRedis();
    const key = sendRateLimitKey("u1");

    for (let i = 0; i < 30; i++) {
      expect(await checkSendRateLimit(redis as never, "u1")).toBe(true);
    }
    expect(redis.counters.get(key)).toBe(30);
    expect(await checkSendRateLimit(redis as never, "u1")).toBe(false);
    expect(redis.counters.get(key)).toBe(31);
  });

  it("resets after the window expires", async () => {
    vi.useFakeTimers();
    const redis = stubRedis();
    // burn the window
    for (let i = 0; i < 30; i++) await checkSendRateLimit(redis as never, "u2");
    expect(await checkSendRateLimit(redis as never, "u2")).toBe(false);

    // simulate TTL expiry of the fixed-window key
    redis.expire(sendRateLimitKey("u2"));
    expect(await checkSendRateLimit(redis as never, "u2")).toBe(true);
    vi.useRealTimers();
  });

  it("fails OPEN when redis errors (a limiter outage must not kill chat)", async () => {
    const failing = {
      async eval() {
        throw new Error("redis down");
      },
    };
    expect(await checkSendRateLimit(failing as never, "u3")).toBe(true);
  });

  it("honors custom limits", async () => {
    const redis = stubRedis();
    expect(await checkSendRateLimit(redis as never, "u4", 2)).toBe(true);
    expect(await checkSendRateLimit(redis as never, "u4", 2)).toBe(true);
    expect(await checkSendRateLimit(redis as never, "u4", 2)).toBe(false);
  });
});