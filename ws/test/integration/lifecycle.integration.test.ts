/**
 * Phase 10.2 integration — connection-lifecycle guarantees across TWO server
 * instances (4131/4132, same Redis, real Postgres): DM advisory-lock dedupe
 * under parallel create, kicked-member DB re-check WITHOUT reconnect, unread
 * fan-out to a second device, typing throttle.
 *
 * Auto-skips without .env (same pattern as the other integration suites).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { Redis } from "ioredis";
import { encode } from "next-auth/jwt";
import { PrismaClient, type User } from "@prisma/client";
import {
  C2S,
  S2C,
  type MessageSendAck,
  type TypingUpdateEvent,
  type UnreadUpdateEvent,
} from "@chat/shared";
// The REAL web-side helper — the exact code path POST /api/conversations runs.
// (Resolved from the monorepo root by vitest; its relative imports pull in
// web's prisma/redis singletons, which reuse the same local services.)
import { findOrCreateDirectConversation } from "../../../web/src/lib/conversations";
import { createChatServer, type ChatServer } from "../../src/app.js";
import { loadEnv, type Env } from "../../src/config.js";

const hasInfra = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;

const PORT_A = 4131;
const PORT_B = 4132;
const WS_PATH = "/socket.io/ws";

const TEST_USERS = [
  { email: "p10-alice@test.local", name: "Lifecycle Alice" },
  { email: "p10-bob@test.local", name: "Lifecycle Bob" },
  { email: "p10-dm1@test.local", name: "Lifecycle DM-A" },
  { email: "p10-dm2@test.local", name: "Lifecycle DM-B" },
] as const;

const prisma = new PrismaClient();
let env: Env;
let serverA: ChatServer;
let serverB: ChatServer;
let redis: Redis;

let alice!: User;
let bob!: User;
let dmUser1!: User;
let dmUser2!: User;
let aliceToken = "";
let bobToken = "";
let dmUser1Token = "";
let dmUser2Token = "";
let dmId = ""; // alice ↔ bob

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function connect(port: number, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${port}`, {
      path: WS_PATH,
      transports: ["websocket"],
      forceNew: true,
      auth: { token },
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });
}

async function waitForRoom(server: ChatServer, socketId: string, room: string) {
  await waitFor(() => {
    const s = server.io.of("/").sockets.get(socketId);
    return !!s && s.rooms.has(room);
  });
}

function send(socket: Socket, payload: object): Promise<MessageSendAck> {
  return new Promise((resolve) => {
    socket
      .timeout(5000)
      .emit(C2S.MESSAGE_SEND, payload, (timeoutErr: Error | null, ack: MessageSendAck) => {
        resolve(timeoutErr ? { ok: false, code: "INTERNAL", message: "ack timeout" } : ack);
      });
  });
}

const textPayload = (conversationId: string, clientId: string, body: string) => ({
  conversationId,
  clientId,
  type: "TEXT" as const,
  body,
});

describe.skipIf(!hasInfra)("connection lifecycle across two ws instances", () => {
  let aliceSocket: Socket; // instance A
  let bobSocket: Socket; // instance B
  let bobSecondDevice: Socket; // instance A — same user:{bob} room, other instance

  beforeAll(async () => {
    env = loadEnv(process.env);
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

    const created = await Promise.all(
      TEST_USERS.map((u) =>
        prisma.user.upsert({
          where: { email: u.email },
          update: {},
          create: { email: u.email, name: u.name, passwordHash: "unused-in-ws-tests" },
        })
      )
    );
    [alice, bob, dmUser1, dmUser2] = created;

    const dm = await prisma.conversation.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: alice.id } } },
          { members: { some: { userId: bob.id } } },
        ],
      },
    });
    dmId =
      dm?.id ??
      (
        await prisma.conversation.create({
          data: {
            type: "DIRECT",
            createdById: alice.id,
            members: { create: [{ userId: alice.id }, { userId: bob.id }] },
          },
        })
      ).id;

    const secret = env.NEXTAUTH_SECRET;
    const mk = (u: User) => encode({ token: { sub: u.id, email: u.email }, secret });
    [aliceToken, bobToken, dmUser1Token, dmUser2Token] = await Promise.all([
      mk(alice),
      mk(bob),
      mk(dmUser1),
      mk(dmUser2),
    ]);
    void dmUser1Token;
    void dmUser2Token;

    serverA = createChatServer({ ...env, WS_PORT: PORT_A });
    serverB = createChatServer({ ...env, WS_PORT: PORT_B });

    aliceSocket = await connect(PORT_A, aliceToken);
    bobSocket = await connect(PORT_B, bobToken);
    await waitForRoom(serverA, aliceSocket.id, `conversation:${dmId}`);
    await waitForRoom(serverB, bobSocket.id, `conversation:${dmId}`);
    await waitForRoom(serverB, bobSocket.id, `user:${bob.id}`);
  }, 30_000);

  afterAll(async () => {
    if (!alice || !redis) return;
    aliceSocket?.close();
    bobSocket?.close();
    bobSecondDevice?.close();

    await Promise.all(
      [alice, bob, dmUser1, dmUser2].flatMap((u) => [
        redis.del(`unread:${u.id}`, `ratelimit:${u.id}:msg`, `presence:${u.id}`, `sockets:${u.id}`),
      ])
    );
    await prisma.user.deleteMany({ where: { email: { in: TEST_USERS.map((u) => u.email) } } });
    await redis.quit();
    await serverA.close();
    await serverB.close();
    await prisma.$disconnect();
  });

  it("dedupes parallel DM creation on the advisory lock (Promise.all both sides → ONE conversation)", async () => {
    const [a, b] = await Promise.all([
      findOrCreateDirectConversation(dmUser1.id, dmUser2.id),
      findOrCreateDirectConversation(dmUser2.id, dmUser1.id),
    ]);

    expect(a.id).toBe(b.id);
    const rows = await prisma.conversation.findMany({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: dmUser1.id } } },
          { members: { some: { userId: dmUser2.id } } },
        ],
      },
      include: { members: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].members).toHaveLength(2);
  });

  it("pushes unread:update to EVERY device of a member (second device on the other instance)", async () => {
    bobSecondDevice = await connect(PORT_A, bobToken);
    await waitForRoom(serverA, bobSecondDevice.id, `user:${bob.id}`);

    const updates: { socket: Socket; payload: UnreadUpdateEvent }[] = [];
    const collect = (s: Socket) =>
      s.on(S2C.UNREAD_UPDATE, (p: UnreadUpdateEvent) => updates.push({ socket: s, payload: p }));
    collect(bobSocket);
    collect(bobSecondDevice);

    const ack = await send(aliceSocket, textPayload(dmId, crypto.randomUUID(), "badge every device"));
    expect(ack.ok).toBe(true);

    await waitFor(() => updates.filter((u) => u.payload.conversationId === dmId).length >= 2);
    const forDm = updates.filter((u) => u.payload.conversationId === dmId);
    expect(forDm.some((u) => u.socket === bobSocket)).toBe(true); // device on instance B
    expect(forDm.some((u) => u.socket === bobSecondDevice)).toBe(true); // device on instance A
    expect(forDm.every((u) => u.payload.count >= 1)).toBe(true);
  });

  it("kicks a member via DB removal and their NEXT send acks NOT_FOUND without reconnect", async () => {
    // Bob stays connected to instance B with a stale conversation room — the
    // membership re-check in Postgres is the real gate (rooms are a cache).
    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: dmId, userId: bob.id } },
    });

    const kicked = await send(bobSocket, textPayload(dmId, crypto.randomUUID(), "am I still here?"));
    expect(kicked.ok).toBe(false);
    if (!kicked.ok) expect(kicked.code).toBe("NOT_FOUND"); // 404-not-403 (Phase 6 convention)

    // alice is unaffected
    const ack = await send(aliceSocket, textPayload(dmId, crypto.randomUUID(), "still a member"));
    expect(ack.ok).toBe(true);

    // after reconnect, room join (driven by DB memberships) no longer includes him
    bobSocket.disconnect();
    const fresh = await connect(PORT_B, bobToken);
    try {
      await waitForRoom(serverB, fresh.id, `user:${bob.id}`);
      const inConv = serverB.io.of("/").sockets.get(fresh.id)?.rooms.has(`conversation:${dmId}`);
      expect(inConv).toBe(false);
      const ack2 = await send(fresh, textPayload(dmId, crypto.randomUUID(), "rejoined but kicked"));
      expect(ack2.ok).toBe(false);
      if (!ack2.ok) expect(ack2.code).toBe("NOT_FOUND");
    } finally {
      fresh.close();
    }

    // restore membership so the suite stays re-runnable (upsert'd users, id-stable DM),
    // then bring bob's original socket back online for the typing test
    await prisma.conversationMember.create({
      data: { conversationId: dmId, userId: bob.id },
    });
    bobSocket.connect();
    await waitFor(() =>
      [...serverB.io.of("/").sockets.values()].some(
        (s) => s.data.userId === bob.id && s.rooms.has(`conversation:${dmId}`)
      )
    );
  });

  it("throttles typing:start to at most ONE broadcast per 2 s window", async () => {
    const updates: TypingUpdateEvent[] = [];
    bobSocket.on(S2C.TYPING_UPDATE, (p: TypingUpdateEvent) => updates.push(p));

    // let any prior throttle window lapse, then burst 10 starts inside ~1 s
    await new Promise((r) => setTimeout(r, 2100));
    const before = updates.length;
    for (let i = 0; i < 10; i++) {
      aliceSocket.emit(C2S.TYPING_START, { conversationId: dmId });
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500)); // let the single broadcast land

    const during = updates.slice(before);
    const aliceTyping = during.filter((t) => t.userIds.includes(alice.id));
    expect(aliceTyping.length).toBeGreaterThanOrEqual(1);
    expect(aliceTyping.length).toBeLessThanOrEqual(1);
  });
});