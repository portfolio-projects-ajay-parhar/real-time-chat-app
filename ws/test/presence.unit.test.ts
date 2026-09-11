/**
 * Unit — presence service (ws/src/presence.ts) with ioredis-mock (Phase 10.1).
 *
 * ioredis-mock implements the SET/DEL/pipeline/SET+EX surface but cannot run
 * Lua, so `eval` is overridden with a faithful re-implementation of the two
 * scripts' exact semantics (SADD→SCARD / SREM(-1 guard)→SCARD). The interesting
 * behavior under test is the transition logic, not the Lua itself — the real
 * scripts are proven live by the presence/messaging/receipts integration
 * suites against real Redis.
 *
 * Prisma and rooms are mocked: this suite is about first/last-socket
 * transitions, TTL writes and mutuals-only targeting, not Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "socket.io";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { S2C } from "@chat/shared";
import { PRESENCE_TTL_S, onSocketConnected, onSocketDisconnected, startHeartbeat } from "../src/presence.js";

const prismaUpdate = vi.fn().mockResolvedValue({});
const getMutualUserIds = vi.fn(async () => ["mutual-1", "mutual-2"]);

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { user: { update: (args: unknown) => prismaUpdate(args) } },
}));
vi.mock("../src/rooms.js", () => ({
  getMutualUserIds: (...args: unknown[]) => getMutualUserIds(...(args as [])),
  userRoom: (id: string) => `user:${id}`,
}));

/** A redis client shaped like ioredis whose eval mirrors the Lua scripts. */
function makeRedis() {
  const redis = new RedisMock() as unknown as Redis & Record<string, unknown>;
  redis.eval = async (lua: string, numKeys: number, ...rest: unknown[]) => {
    if (lua.includes("SADD")) {
      // CONNECT script: (socketsKey, presenceKey, socketId, ttlSec). Heal a
      // stale sockets set when presence has expired, then SADD + SCARD +
      // refresh the presence TTL.
      const [socketsKey, presenceKey, socketId, ttl] = rest as [string, string, string, string];
      const presenceAlive = await (redis.exists as (k: string) => Promise<number>)(presenceKey);
      if (!presenceAlive) await (redis.del as (k: string) => Promise<number>)(socketsKey);
      await (redis.sadd as (k: string, m: string) => Promise<number>)(socketsKey, socketId);
      const card = await (redis.scard as (k: string) => Promise<number>)(socketsKey);
      await (redis.set as (k: string, v: string, mode: string, t: number) => Promise<unknown>)(
        presenceKey,
        "1",
        "EX",
        Number(ttl)
      );
      return card;
    }
    // DISCONNECT script: (socketsKey, socketId)
    const [socketsKey, socketId] = rest as [string, string];
    const removed = await (redis.srem as (k: string, m: string) => Promise<number>)(socketsKey, socketId);
    if (removed === 0) return -1;
    return (redis.scard as (k: string) => Promise<number>)(socketsKey);
  };
  return redis;
}

interface Emit {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

/** Minimal io + socket doubles that record room-targeted emits. */
function makeHarness() {
  const emitted: Emit[] = [];
  const socketMap = new Map<string, { id: string; data: { userId?: string } }>();
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => emitted.push({ room, event, payload }),
    }),
    of: (_ns: string) => ({ sockets: socketMap }),
  } as unknown as Server;
  const mkSocket = (id: string, userId: string) => {
    const s = { id, data: { userId } };
    socketMap.set(id, s);
    return s as never;
  };
  return { io, emitted, socketMap, mkSocket };
}

let redis: ReturnType<typeof makeRedis>;

beforeEach(async () => {
  redis = makeRedis();
  // ioredis-mock instances share ONE in-memory server — isolate each test
  await redis.flushall();
  prismaUpdate.mockClear();
  getMutualUserIds.mockClear();
  getMutualUserIds.mockImplementation(async () => ["mutual-1", "mutual-2"]);
});

describe("onSocketConnected", () => {
  it("first socket → online broadcast to each mutual's user room + presence key + lastSeenAt stamp", async () => {
    const { io, emitted, mkSocket } = makeHarness();
    await onSocketConnected(io, mkSocket("s1", "u1"), redis);

    expect(emitted.filter((e) => e.event === S2C.PRESENCE_UPDATE)).toHaveLength(2); // one per mutual
    for (const e of emitted) {
      expect(e.room).toMatch(/^user:mutual-/);
      expect(e.payload).toMatchObject({ userId: "u1", status: "online" });
    }
    expect(await redis.get("presence:u1")).toBe("1");
    const ttl = await redis.ttl("presence:u1");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_S);
    expect(prismaUpdate).toHaveBeenCalledTimes(1);
  });

  it("second tab of the same user → NO transition broadcast (multi-device tracking)", async () => {
    const { io, emitted, mkSocket } = makeHarness();
    await onSocketConnected(io, mkSocket("s1", "u1"), redis);
    emitted.length = 0;
    prismaUpdate.mockClear();

    await onSocketConnected(io, mkSocket("s2", "u1"), redis);
    expect(emitted).toHaveLength(0);
    expect(prismaUpdate).not.toHaveBeenCalled();
    expect(await redis.scard("sockets:u1")).toBe(2);
  });

  it("presence TTL is refreshed on every (re)connect of the same user", async () => {
    const { io, mkSocket } = makeHarness();
    await onSocketConnected(io, mkSocket("s1", "u1"), redis);
    await onSocketConnected(io, mkSocket("s2", "u1"), redis);
    const ttl = await redis.ttl("presence:u1");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_S);
  });
});

describe("onSocketDisconnected", () => {
  it("last socket → offline broadcast WITH lastSeenAt, presence key deleted", async () => {
    const { io, emitted, mkSocket } = makeHarness();
    await onSocketConnected(io, mkSocket("s1", "u1"), redis);

    await onSocketDisconnected(io, mkSocket("s1", "u1"), redis);
    const offline = emitted.filter((e) => e.payload.status === "offline");
    expect(offline).toHaveLength(2); // one per mutual
    for (const e of offline) {
      expect(e.payload).toMatchObject({ userId: "u1", status: "offline" });
      expect(typeof e.payload.lastSeenAt).toBe("string");
    }
    expect(await redis.get("presence:u1")).toBeNull();
    expect(await redis.scard("sockets:u1")).toBe(0);
  });

  it("a remaining tab keeps the user online (no broadcast)", async () => {
    const { io, emitted, mkSocket } = makeHarness();
    await onSocketConnected(io, mkSocket("s1", "u1"), redis);
    await onSocketConnected(io, mkSocket("s2", "u1"), redis);
    emitted.length = 0;

    await onSocketDisconnected(io, mkSocket("s1", "u1"), redis);
    expect(emitted).toHaveLength(0);
    expect(await redis.get("presence:u1")).toBe("1");
    expect(await redis.scard("sockets:u1")).toBe(1);
  });

  it("an untracked socket id (post-Redis-flush) is a no-op — no spurious offline", async () => {
    const { io, emitted, mkSocket } = makeHarness();
    await onSocketDisconnected(io, mkSocket("sX", "u1"), redis);
    expect(emitted).toHaveLength(0);
    expect(prismaUpdate).not.toHaveBeenCalled();
  });

  it("heals a stale sockets set after a hard kill (presence TTL expired)", async () => {
    const { io, emitted, mkSocket } = makeHarness();
    // crash aftermath: sockets:{u1} still lists dead socket ids, presence key gone
    await redis.sadd("sockets:u1", "dead-1", "dead-2", "dead-3");

    // reconnect → the stale entries must be wiped, u1 counts as FIRST socket
    await onSocketConnected(io, mkSocket("live-1", "u1"), redis);

    expect(emitted.filter((e) => e.event === S2C.PRESENCE_UPDATE)).toHaveLength(2); // online broadcast fired
    expect(await redis.scard("sockets:u1")).toBe(1);
    expect(await redis.smembers("sockets:u1")).toEqual(["live-1"]);
    expect(await redis.get("presence:u1")).toBe("1");
  });

  it("does NOT heal while the presence TTL key is still alive (live sockets elsewhere)", async () => {
    const { io, emitted, mkSocket } = makeHarness();
    await onSocketConnected(io, mkSocket("s1", "u1"), redis);
    emitted.length = 0;
    prismaUpdate.mockClear();

    // a new tab on another instance: presence alive → set untouched → no transition
    await onSocketConnected(io, mkSocket("s2", "u1"), redis);
    expect(emitted).toHaveLength(0);
    expect(await redis.scard("sockets:u1")).toBe(2);
  });
});

describe("startHeartbeat", () => {
  it("refreshes the presence TTL of every connected user (deduped per user) on ONE interval", async () => {
    vi.useFakeTimers();
    try {
      const { io, mkSocket } = makeHarness();
      mkSocket("s1", "u1");
      mkSocket("s2", "u2");
      mkSocket("s3", "u1"); // same user, second tab → the key set is a Set of user ids

      const timer = startHeartbeat(io, redis);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await redis.get("presence:u1")).toBe("1");
      expect(await redis.get("presence:u2")).toBe("1");
      const ttl = await redis.ttl("presence:u1");
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_S);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes nothing when the instance has no sockets", async () => {
    vi.useFakeTimers();
    try {
      const { io } = makeHarness();
      const timer = startHeartbeat(io, redis);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await redis.exists("presence:u1")).toBe(0);
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});