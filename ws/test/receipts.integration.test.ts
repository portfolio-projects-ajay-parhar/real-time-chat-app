/**
 * Phase 7 integration — read receipts across TWO server instances on the
 * SAME Redis (adapter fan-out proof) with real Postgres watermark persistence.
 *
 * Auto-skips when the repo-root .env (DATABASE_URL / REDIS_URL) is missing —
 * same pattern as messaging.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { Redis } from "ioredis";
import { encode } from "next-auth/jwt";
import { PrismaClient, type User } from "@prisma/client";
import {
  C2S,
  S2C,
  type ConversationReadAck,
  type MessageSendAck,
  type ReceiptUpdateEvent,
  type UnreadUpdateEvent,
} from "@chat/shared";
import { createChatServer, type ChatServer } from "../src/app.js";
import { loadEnv, type Env } from "../src/config.js";

const hasInfra = !!process.env.DATABASE_URL && !!process.env.REDIS_URL;

const PORT_A = 4121;
const PORT_B = 4122;
const WS_PATH = "/socket.io/ws";

const TEST_USERS = [
  { email: "p7-alice@test.local", name: "Receipts Alice" },
  { email: "p7-bob@test.local", name: "Receipts Bob" },
  { email: "p7-gina@test.local", name: "Receipts Gina (outsider)" },
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
let ginaToken = "";
let dmId = ""; // alice ↔ bob

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

function markRead(socket: Socket, payload: unknown): Promise<ConversationReadAck> {
  return new Promise((resolve) => {
    socket
      .timeout(5000)
      .emit(C2S.CONVERSATION_READ, payload, (timeoutErr: Error | null, ack: ConversationReadAck) => {
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

describe.skipIf(!hasInfra)("read receipts across two ws instances", () => {
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
    [aliceToken, bobToken, ginaToken] = await Promise.all([mk(alice), mk(bob), mk(gina)]);

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

    await Promise.all(
      [alice, bob, gina].flatMap((u) => [
        redis.del(`unread:${u.id}`, `ratelimit:${u.id}:msg`, `presence:${u.id}`, `sockets:${u.id}`),
      ])
    );
    await prisma.user.deleteMany({ where: { email: { in: TEST_USERS.map((u) => u.email) } } });
    await redis.quit();
    await serverA.close();
    await serverB.close();
    await prisma.$disconnect();
  });
  // __TESTS__

  it("advances the watermark, clears the Redis unread hash and acks", async () => {
    // Seed: alice sends so bob has something unread.
    const sendAck = await send(aliceSocket, textPayload(dmId, crypto.randomUUID(), "read me"));
    expect(sendAck.ok).toBe(true);
    if (!sendAck.ok) return;

    await waitFor(async () => (await redis.hget(`unread:${bob.id}`, dmId)) !== null);

    const before = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: dmId, userId: bob.id } },
      select: { lastReadAt: true },
    });

    const ack = await markRead(bobSocket, { conversationId: dmId });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;

    const row = await prisma.conversationMember.findUnique({
      where: { conversationId_userId: { conversationId: dmId, userId: bob.id } },
      select: { lastReadAt: true },
    });
    expect(row!.lastReadAt.getTime()).toBeGreaterThanOrEqual(before!.lastReadAt.getTime());
    expect(row!.lastReadAt.getTime()).toBeGreaterThanOrEqual(
      new Date(sendAck.message.createdAt).getTime()
    );
    expect(new Date(ack.lastReadAt).getTime()).toBe(row!.lastReadAt.getTime());

    // Hot counter cleared (HDEL) — the badge authority is gone.
    expect(await redis.hget(`unread:${bob.id}`, dmId)).toBeNull();
  });

  it("broadcasts receipt:update to the conversation room across instances", async () => {
    const receipts: ReceiptUpdateEvent[] = [];
    aliceSocket.on(S2C.RECEIPT_UPDATE, (payload: ReceiptUpdateEvent) => receipts.push(payload));

    await send(aliceSocket, textPayload(dmId, crypto.randomUUID(), "receipt me"));

    const ack = await markRead(bobSocket, { conversationId: dmId });
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;

    await waitFor(() => receipts.some((r) => r.userId === bob.id));
    const receipt = receipts.find((r) => r.userId === bob.id)!;
    expect(receipt.conversationId).toBe(dmId);
    expect(new Date(receipt.lastReadAt).getTime()).toBe(new Date(ack.lastReadAt).getTime());
  });

  it("pushes unread:update {count: 0} to the reader's user room", async () => {
    const unreadUpdates: UnreadUpdateEvent[] = [];
    bobSocket.on(S2C.UNREAD_UPDATE, (payload: UnreadUpdateEvent) => unreadUpdates.push(payload));

    await send(aliceSocket, textPayload(dmId, crypto.randomUUID(), "badge again"));
    await waitFor(async () => (await redis.hget(`unread:${bob.id}`, dmId)) !== null);

    await markRead(bobSocket, { conversationId: dmId });

    await waitFor(() => unreadUpdates.some((u) => u.conversationId === dmId && u.count === 0));
  });

  it("rejects a non-member's read with NOT_FOUND", async () => {
    const ginaSocket = await connect(PORT_A, ginaToken);
    try {
      await waitForRoom(serverA, ginaSocket.id, `user:${gina.id}`);
      const ack = await markRead(ginaSocket, { conversationId: dmId });
      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.code).toBe("NOT_FOUND");
    } finally {
      ginaSocket.close();
    }
  });

  it("rejects a zod-invalid payload with VALIDATION", async () => {
    const ack = await markRead(bobSocket, { conversationId: "" });
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.code).toBe("VALIDATION");
  });

  it("re-reads are idempotent and never regress the watermark", async () => {
    const ack1 = await markRead(bobSocket, { conversationId: dmId });
    const ack2 = await markRead(bobSocket, { conversationId: dmId });
    expect(ack1.ok).toBe(true);
    expect(ack2.ok).toBe(true);
    if (ack1.ok && ack2.ok) {
      expect(new Date(ack2.lastReadAt).getTime()).toBeGreaterThanOrEqual(
        new Date(ack1.lastReadAt).getTime()
      );
    }
    expect(await redis.hget(`unread:${bob.id}`, dmId)).toBeNull();
  });
});