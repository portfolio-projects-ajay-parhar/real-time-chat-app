/**
 * Phase 6 integration — real-time messaging across TWO server instances on
 * the SAME Redis (the adapter fan-out proof) with real Postgres persistence.
 *
 * Auto-skips when the repo-root .env (DATABASE_URL / REDIS_URL) is missing —
 * same pattern as presence.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { Redis } from "ioredis";
import { encode } from "next-auth/jwt";
import { PrismaClient, type User } from "@prisma/client";
import {
  C2S,
  S2C,
  type ChatMessage,
  type MessageSendAck,
  type TypingUpdateEvent,
  type UnreadUpdateEvent,
} from "@chat/shared";
import { createChatServer, type ChatServer } from "../src/app.js";
import { loadEnv, type Env } from "../src/config.js";

const hasInfra = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;

const PORT_A = 4111;
const PORT_B = 4112;
const WS_PATH = "/socket.io/ws";

const TEST_USERS = [
  { email: "p6-alice@test.local", name: "Messaging Alice" },
  { email: "p6-bob@test.local", name: "Messaging Bob" },
  { email: "p6-gina@test.local", name: "Messaging Gina (outsider)" },
  { email: "p6-carol@test.local", name: "Messaging Carol (rate-limit subject)" },
] as const;

const prisma = new PrismaClient();
let env: Env;
let serverA: ChatServer;
let serverB: ChatServer;
let redis: Redis;

let alice!: User;
let bob!: User;
let gina!: User;
let carol!: User;
let aliceToken = "";
let bobToken = "";
let ginaToken = "";
let carolToken = "";
let dmId = ""; // alice ↔ bob
let carolDmId = ""; // alice ↔ carol

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  ms = 5000
): Promise<void> {
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

/** Wait until the given server instance has actually joined the socket to a room. */
async function waitForRoom(server: ChatServer, socketId: string, room: string) {
  await waitFor(() => {
    const s = server.io.of("/").sockets.get(socketId);
    return !!s && s.rooms.has(room);
  });
}

/** Emit message:send and collect the ack (typed, safe when no ack arrives). */
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

describe.skipIf(!hasInfra)("real-time messaging across two ws instances", () => {
  let aliceSocket: Socket; // instance A
  let bobSocket: Socket; // instance B — cross-instance by construction

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
    [alice, bob, gina, carol] = created;

    // Fixture DMs
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

    const carolDm = await prisma.conversation.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: alice.id } } },
          { members: { some: { userId: carol.id } } },
        ],
      },
    });
    carolDmId =
      carolDm?.id ??
      (
        await prisma.conversation.create({
          data: {
            type: "DIRECT",
            createdById: alice.id,
            members: { create: [{ userId: alice.id }, { userId: carol.id }] },
          },
        })
      ).id;

    const secret = env.NEXTAUTH_SECRET;
    const mk = (u: User) => encode({ token: { sub: u.id, email: u.email }, secret });
    [aliceToken, bobToken, ginaToken, carolToken] = await Promise.all([
      mk(alice),
      mk(bob),
      mk(gina),
      mk(carol),
    ]);

    serverA = createChatServer({ ...env, WS_PORT: PORT_A });
    serverB = createChatServer({ ...env, WS_PORT: PORT_B });

    // alice → A, bob → B: every delivery below must cross the Redis adapter
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

    // unread hashes + rate-limit counters are keyed by user id → clean up
    await Promise.all(
      [alice, bob, gina, carol].flatMap((u) => [
        redis.del(`unread:${u.id}`, `ratelimit:${u.id}:msg`, `presence:${u.id}`, `sockets:${u.id}`),
      ])
    );
    await prisma.user.deleteMany({ where: { email: { in: TEST_USERS.map((u) => u.email) } } });
    await redis.quit();
    await serverA.close();
    await serverB.close();
    await prisma.$disconnect();
  });

  it("delivers a send from instance A to instance B with a persisted ack", async () => {
    const received: ChatMessage[] = [];
    bobSocket.on(S2C.MESSAGE_NEW, (payload: { message: ChatMessage }) =>
      received.push(payload.message)
    );

    const clientId = crypto.randomUUID();
    const ack = await send(aliceSocket, textPayload(dmId, clientId, "hello across instances"));

    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    expect(ack.message.body).toBe("hello across instances");
    expect(ack.message.clientId).toBe(clientId);
    expect(ack.message.sender?.id).toBe(alice.id);

    await waitFor(() => received.some((m) => m.clientId === clientId));
    const delivered = received.find((m) => m.clientId === clientId)!;
    expect(delivered.id).toBe(ack.message.id);

    // persisted row exists (Postgres is the truth)
    const row = await prisma.message.findUnique({ where: { clientId } });
    expect(row?.conversationId).toBe(dmId);
  });

  it("pushes unread:update to the recipient's user:{id} room", async () => {
    const unreadUpdates: UnreadUpdateEvent[] = [];
    bobSocket.on(S2C.UNREAD_UPDATE, (payload: UnreadUpdateEvent) =>
      unreadUpdates.push(payload)
    );

    const clientId = crypto.randomUUID();
    const ack = await send(aliceSocket, textPayload(dmId, clientId, "badge test"));
    expect(ack.ok).toBe(true);

    await waitFor(() => unreadUpdates.some((u) => u.conversationId === dmId));
    const update = unreadUpdates.find((u) => u.conversationId === dmId)!;
    expect(update.count).toBeGreaterThanOrEqual(1);
  });

  it("dedupes a reconnect double-send by clientId (one row, both acks ok)", async () => {
    const clientId = crypto.randomUUID();
    const payload = textPayload(dmId, clientId, "sent once, hopefully");

    const ack1 = await send(aliceSocket, payload);
    const ack2 = await send(aliceSocket, payload);

    expect(ack1.ok).toBe(true);
    expect(ack2.ok).toBe(true);
    if (ack1.ok && ack2.ok) expect(ack2.message.id).toBe(ack1.message.id);

    const rows = await prisma.message.findMany({ where: { clientId } });
    expect(rows).toHaveLength(1);
  });

  it("rejects a non-member's send with NOT_FOUND", async () => {
    const ginaSocket = await connect(PORT_A, ginaToken);
    try {
      await waitForRoom(serverA, ginaSocket.id, `user:${gina.id}`);
      const ack = await send(ginaSocket, textPayload(dmId, crypto.randomUUID(), "let me in"));
      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.code).toBe("NOT_FOUND");
    } finally {
      ginaSocket.close();
    }
  });

  it("rejects a zod-invalid payload with VALIDATION", async () => {
    const ack = await send(aliceSocket, { conversationId: dmId, clientId: "not-a-uuid" });
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.code).toBe("VALIDATION");
  });

  it("broadcasts typing:update to the other instance", async () => {
    const typingUpdates: TypingUpdateEvent[] = [];
    bobSocket.on(S2C.TYPING_UPDATE, (payload: TypingUpdateEvent) =>
      typingUpdates.push(payload)
    );

    aliceSocket.emit(C2S.TYPING_START, { conversationId: dmId });
    await waitFor(() => typingUpdates.some((t) => t.userIds.includes(alice.id)));

    aliceSocket.emit(C2S.TYPING_STOP, { conversationId: dmId });
    await waitFor(() => {
      const last = typingUpdates[typingUpdates.length - 1];
      return !!last && !last.userIds.includes(alice.id);
    });
  });

  it("stops typing implicitly on disconnect (no ghost typers)", async () => {
    const typingUpdates: TypingUpdateEvent[] = [];
    bobSocket.on(S2C.TYPING_UPDATE, (payload: TypingUpdateEvent) =>
      typingUpdates.push(payload)
    );

    const tempAlice = await connect(PORT_A, aliceToken);
    tempAlice.emit(C2S.TYPING_START, { conversationId: dmId });
    await waitFor(() => typingUpdates.some((t) => t.userIds.includes(alice.id)));

    tempAlice.disconnect();
    await waitFor(() => {
      const last = typingUpdates[typingUpdates.length - 1];
      return !!last && !last.userIds.includes(alice.id);
    });
  });

  it("rate-limits the 31st send in a 10 s window with RATE_LIMITED", async () => {
    // fresh subject (carol) so other tests' sends don't touch this counter
    const carolSocket = await connect(PORT_A, carolToken);
    try {
      await waitForRoom(serverA, carolSocket.id, `conversation:${carolDmId}`);

      let limited = 0;
      for (let i = 0; i < 31; i++) {
        const ack = await send(
          carolSocket,
          textPayload(carolDmId, crypto.randomUUID(), `spam ${i}`)
        );
        if (!ack.ok && ack.code === "RATE_LIMITED") limited++;
      }
      expect(limited).toBe(1); // exactly the 31st
    } finally {
      carolSocket.close();
    }
  });
});