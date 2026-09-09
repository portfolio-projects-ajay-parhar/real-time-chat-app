import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";

// vitest doesn't load .env — parse the repo root one manually (no dotenv dep).
function loadEnv() {
  try {
    const raw = readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // no .env — the DB-dependent suite stays skipped
  }
}
loadEnv();

const hasDb = !!process.env.DATABASE_URL;
const prisma = new PrismaClient();

let userIds: string[] = [];
let conversationId = "";

/** tiny helper so the `where` blocks below stay readable */
function conv() {
  if (!conversationId) throw new Error("test conversation missing");
  return conversationId;
}

function keysetWhere(cursor: string): Prisma.MessageWhereInput {
  const raw = Buffer.from(cursor, "base64url").toString();
  const sep = raw.lastIndexOf("~");
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  return {
    conversationId: conv(),
    deletedAt: null,
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: id } },
    ],
  };
}

function encode(m: { createdAt: Date; id: string }) {
  return Buffer.from(`${m.createdAt.toISOString()}~${m.id}`).toString("base64url");
}

/** Mirrors the API route: limit + 1 lookahead, newest first. */
function pageRows(cursor: string | null) {
  return prisma.message.findMany({
    where: cursor ? keysetWhere(cursor) : { conversationId: conv(), deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 16,
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  const [a, b] = await Promise.all([
    prisma.user.create({
      data: { email: `kstest-a-${Date.now()}@test.local`, name: "Keyset A", passwordHash: "x" },
    }),
    prisma.user.create({
      data: { email: `kstest-b-${Date.now()}@test.local`, name: "Keyset B", passwordHash: "x" },
    }),
  ]);
  userIds = [a.id, b.id];
  const c = await prisma.conversation.create({
    data: { type: "DIRECT", createdById: a.id, members: { create: [{ userId: a.id }, { userId: b.id }] } },
  });
  conversationId = c.id;
  // 40 backdated messages, 10 ms apart, oldest first
  const base = Date.now() - 60_000;
  await prisma.message.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({
      conversationId: c.id,
      senderId: i % 2 === 0 ? a.id : b.id,
      type: "TEXT",
      body: `msg ${i}`,
      createdAt: new Date(base + i * 10),
    })),
  });
}, 30_000);

afterAll(async () => {
  if (conversationId) {
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => {});
  }
  if (userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("keyset pagination over real Postgres", () => {
  it("pages strictly older messages with no duplicates until exhausted", async () => {
    const allIds: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 5; page++) {
      const rows: Awaited<ReturnType<typeof pageRows>> = await pageRows(cursor);
      const slice = rows.slice(0, 15);
      allIds.push(...slice.map((m) => m.id));
      cursor = rows.length > 15 ? encode(slice[slice.length - 1]) : null;
      if (rows.length <= 15) break;
    }

    expect(allIds).toHaveLength(40);
    expect(new Set(allIds).size).toBe(40); // no duplicates across page boundaries
  });

  it("is stable when a new message arrives mid-paging (the keyset win)", async () => {
    const page1 = await prisma.message.findMany({
      where: { conversationId: conv(), deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 16,
    });
    const firstPage = page1.slice(0, 15);
    const cursor = encode(firstPage[firstPage.length - 1]);

    // Simulate a live message arriving between page fetches
    const fresh = await prisma.message.create({
      data: { conversationId, senderId: userIds[0], type: "TEXT", body: "live" },
    });

    const page2 = await prisma.message.findMany({
      where: keysetWhere(cursor),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 15,
    });

    expect(page2.some((m) => m.id === fresh.id)).toBe(false);
    const page1Ids = new Set(firstPage.map((m) => m.id));
    for (const m of page2) expect(page1Ids.has(m.id)).toBe(false);

    await prisma.message.delete({ where: { id: fresh.id } });
  });

  it("filters soft-deleted tombstones out of pages", async () => {
    const victim = await prisma.message.findFirstOrThrow({
      where: { conversationId: conv() },
      orderBy: { createdAt: "desc" },
    });
    await prisma.message.update({
      where: { id: victim.id },
      data: { deletedAt: new Date() },
    });
    const count = await prisma.message.count({
      where: { conversationId: conv(), deletedAt: null },
    });
    expect(count).toBe(39);
    await prisma.message.update({ where: { id: victim.id }, data: { deletedAt: null } });
  });
});

