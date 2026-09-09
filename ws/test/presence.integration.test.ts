/**
 * Phase 5 integration smoke — presence across TWO server instances on the SAME
 * Redis (the adapter proof) with real socket.io-client connections.
 *
 * Auto-skips when the repo-root .env (DATABASE_URL / REDIS_URL) is missing —
 * same pattern as web/test/keyset.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { Redis } from "ioredis";
import { decode, encode } from "next-auth/jwt";
import { PrismaClient, type User } from "@prisma/client";
import { S2C, presenceUpdateEventSchema, type PresenceUpdateEvent } from "@chat/shared";
import { createChatServer, type ChatServer } from "../src/app.js";
import { loadEnv, type Env } from "../src/config.js";

// .env is loaded by test/setup.ts (registered in vitest.config.ts setupFiles)
// — it must land before module imports because the ws server constructs its
// PrismaClient at import time.
const hasInfra = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;

const PORT_A = 4101;
const PORT_B = 4102;
const WS_PATH = "/socket.io/ws";

const TEST_USERS = [
  { email: "p5-alice@test.local", name: "Presence Alice" },
  { email: "p5-bob@test.local", name: "Presence Bob" },
  { email: "p5-gina@test.local", name: "Presence Gina (no shared convs)" },
] as const;

const prisma = new PrismaClient();
let env: Env;
let serverA: ChatServer;
let serverB: ChatServer;
let redis: Redis;

let alice!: User;
let bob!: User;
let gina!: User;
let aliceToken = "";
let bobToken = "";

const aliceEvents: PresenceUpdateEvent[] = [];
let ginaEvents: PresenceUpdateEvent[] = [];

function connect(
  port: number,
  userId: string,
  opts: { token?: string; cookie?: string } = {}
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // forceNew: a dedicated engine per client — no manager-level multiplexing
    // state that could swallow disconnect packets between tests
    const socket = io(`http://localhost:${port}`, {
      path: WS_PATH,
      transports: ["websocket"],
      forceNew: true,
      ...(opts.token ? { auth: { token: opts.token } } : {}),
      ...(opts.cookie ? { extraHeaders: { Cookie: opts.cookie } } : {}),
    });
    socket.once("connect", () => {
      // Settle the server-side connect: onSocketConnected's SADD must have
      // landed before the test proceeds — otherwise a fast disconnect races
      // the async setup and leaves a phantom socket id in the set.
      waitFor(async () => (await redis.sismember(`sockets:${userId}`, socket.id)) === 1)
        .then(() => resolve(socket))
        .catch(reject);
    });
    socket.once("connect_error", (err) => {
      socket.close(); // stop the client's reconnect loop (unauth test)
      reject(err);
    });
  });
}

/**
 * Disconnect and wait until the server has actually processed it
 * (`SREM sockets:{userId}` landed) — client disconnect() is fire-and-forget,
 * and every presence assertion below depends on the server-side transition.
 */
async function disconnectAndSettle(socket: Socket, userId: string): Promise<void> {
  const id = socket.id;
  socket.disconnect();
  await waitFor(async () => (await redis.sismember(`sockets:${userId}`, id)) === 0);
}

/** Wait for an async predicate. */
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}


describe.skipIf(!hasInfra)("presence across two ws instances", () => {
  beforeAll(async () => {
    env = loadEnv(process.env);
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

    // Fixtures: alice↔bob share a DM; gina shares nothing with anyone
    const created = await Promise.all(
      TEST_USERS.map((u) =>
        prisma.user.upsert({
          where: { email: u.email },
          update: {},
          create: { email: u.email, name: u.name, passwordHash: "unused-in-ws-tests" },
        })
      )
    );
    [alice, bob, gina] = created;

    const dm = await prisma.conversation.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: alice.id } } },
          { members: { some: { userId: bob.id } } },
        ],
      },
    });
    if (!dm) {
      await prisma.conversation.create({
        data: {
          type: "DIRECT",
          createdById: alice.id,
          members: { create: [{ userId: alice.id }, { userId: bob.id }] },
        },
      });
    }

    const secret = env.NEXTAUTH_SECRET;
    aliceToken = await encode({ token: { sub: alice.id, email: alice.email }, secret });
    bobToken = await encode({ token: { sub: bob.id, email: bob.email }, secret });

    // Sanity: a token signed via next-auth/jwt encode() must decode on the ws side
    const decoded = await decode({ token: aliceToken, secret });
    expect(decoded?.sub).toBe(alice.id);

    // Boot two instances on the same Redis — the horizontal-scale setup
    serverA = createChatServer({ ...env, WS_PORT: PORT_A });
    serverB = createChatServer({ ...env, WS_PORT: PORT_B });

    // Observers first so their listeners are ready before alice connects.
    // Bob sits on instance B while alice will hit instance A — any presence
    // event alice triggers must cross the Redis adapter.
    const bobSocket = await connect(PORT_B, bob.id, { token: bobToken });
    bobSocket.on(S2C.PRESENCE_UPDATE, (payload: PresenceUpdateEvent) => {
      const parsed = presenceUpdateEventSchema.safeParse(payload);
      if (parsed.success) aliceEvents.push(parsed.data);
    });
    ginaEvents = [];
    const ginaSocket = await connect(PORT_A, gina.id, {
      token: await encode({ token: { sub: gina.id, email: gina.email }, secret }),
    });
    ginaSocket.on(S2C.PRESENCE_UPDATE, (payload: PresenceUpdateEvent) => {
      ginaEvents.push(payload);
    });
  });

  afterAll(async () => {
    // beforeAll may have failed before fixtures were created
    if (!alice || !redis) return;

    await redis.del(
      `presence:${alice.id}`,
      `sockets:${alice.id}`,
      `presence:${bob.id}`,
      `sockets:${bob.id}`,
      `presence:${gina.id}`,
      `sockets:${gina.id}`
    );
    await prisma.user.deleteMany({
      where: { email: { in: TEST_USERS.map((u) => u.email) } },
    });
    await redis.quit();
    await serverA.close();
    await serverB.close();
    await prisma.$disconnect();
  });

  it("rejects unauthenticated handshakes", async () => {
    await expect(connect(PORT_A, alice.id)).rejects.toThrow("UNAUTHENTICATED");
  });

  it("first socket online → exactly one presence:update to mutuals only", async () => {
    const aliceSocket = await connect(PORT_A, alice.id, { token: aliceToken });

    await waitFor(() =>
      aliceEvents.some((e) => e.userId === alice.id && e.status === "online")
    );

    expect(aliceEvents).toHaveLength(1); // no duplicates from the join dance
    expect(aliceEvents[0]).toMatchObject({ userId: alice.id, status: "online" });

    // Redis state: presence key set with TTL, one socket tracked
    expect(await redis.get(`presence:${alice.id}`)).toBe("1");
    const ttl = await redis.ttl(`presence:${alice.id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(70);
    expect(await redis.scard(`sockets:${alice.id}`)).toBe(1);
    expect(await redis.sismember(`sockets:${alice.id}`, aliceSocket.id)).toBe(1);

    // Mutuals-only: bob (shares the DM) got the event, gina (no shared
    // conversation with alice) got nothing at all
    expect(ginaEvents.filter((e) => e.userId === alice.id)).toHaveLength(0);
    expect(ginaEvents).toHaveLength(0);

    // Health endpoint reflects the connected sockets on this instance
    const health = await fetch(`http://localhost:${PORT_A}/health`);
    const body = (await health.json()) as { ok: boolean; sockets: number };
    expect(body.ok).toBe(true);
    expect(body.sockets).toBeGreaterThanOrEqual(1);

    await disconnectAndSettle(aliceSocket, alice.id);
  });

  it("session cookie handshake works too (same-origin proxy path)", async () => {
    // Index marker: assertions below only look at events that arrived during
    // THIS test — earlier tests' events (and any still in flight) are before
    // this index and can never satisfy these waits.
    const idx = aliceEvents.length;

    const aliceSocket = await connect(PORT_A, alice.id, {
      cookie: `next-auth.session-token=${aliceToken}`,
    });
    expect(aliceSocket.connected).toBe(true);
    await waitFor(() =>
      aliceEvents.slice(idx).some((e) => e.userId === alice.id && e.status === "online")
    );

    // Drain this test's offline transition so the multi-tab test starts with
    // no presence events in flight
    await disconnectAndSettle(aliceSocket, alice.id);
    await waitFor(() => aliceEvents.slice(idx).some((e) => e.status === "offline"));
  });

  it("multi-tab: second tab is silent, closing one keeps online, last close goes offline", async () => {
    const idx = aliceEvents.length;

    // Tab 1 on instance A
    const tab1 = await connect(PORT_A, alice.id, { token: aliceToken });
    await waitFor(() =>
      aliceEvents.slice(idx).some((e) => e.userId === alice.id && e.status === "online")
    );
    const onlineCount = aliceEvents.length;

    // Tab 2 on instance B — cross-instance socket tracking
    const tab2 = await connect(PORT_B, alice.id, { token: aliceToken });
    await waitFor(async () => (await redis.scard(`sockets:${alice.id}`)) === 2);
    expect(aliceEvents.length).toBe(onlineCount); // still exactly one online event

    // Close one tab — user stays online, no offline event
    await disconnectAndSettle(tab1, alice.id);
    expect(await redis.scard(`sockets:${alice.id}`)).toBe(1);
    expect(aliceEvents.slice(idx).every((e) => e.status === "online")).toBe(true);

    // Close the last tab — offline + lastSeenAt + Redis cleaned up
    await disconnectAndSettle(tab2, alice.id);
    await waitFor(() => aliceEvents.slice(idx).some((e) => e.status === "offline"));

    const offline = aliceEvents.find((e) => e.status === "offline");
    expect(offline?.userId).toBe(alice.id);
    expect(offline?.lastSeenAt).toBeTruthy();

    expect(await redis.get(`presence:${alice.id}`)).toBeNull();
    expect(await redis.scard(`sockets:${alice.id}`)).toBe(0);
    // lastSeenAt persisted to Postgres on the offline transition
    const user = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(user.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      new Date(offline!.lastSeenAt!).getTime() - 2000
    );
  });
});
