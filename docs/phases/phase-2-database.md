# Phase 2 — Database Schema & Seed

## Goals
1. Full Prisma schema: NextAuth models + `User`, `Conversation`, `ConversationMember`, `Message`
2. The DM advisory-lock helper — concurrency-correct "find or create direct conversation"
3. Realistic seed: users, DMs, groups, 60+ messages with edge cases

## Steps

### 2.1 Prisma schema (web/prisma/schema.prisma)
Models exactly as PLAN §Database Schema — checklist:
- [ ] Enums `ConversationType`, `MemberRole`, `Message` enums `MessageType`
- [ ] `User` — `email @unique`, `passwordHash`, `image` (storage key), `bio`, `lastSeenAt`
- [ ] `Conversation` — `type`, `name?`, `avatarKey?`, `createdById`, `lastMessageAt` + `@@index([lastMessageAt(sort: Desc)])`
- [ ] `ConversationMember` — `role`, `lastReadAt`, `isMuted` + `@@unique([conversationId, userId])` + `@@index([userId])`
- [ ] `Message` — self-relation `replyTo`, `clientId @unique`, soft `deletedAt`, attachment columns + `@@index([conversationId, createdAt(sort: Desc), id])` and `@@index([senderId])`
- [ ] NextAuth: `Account`, `Session`, `VerificationToken` (standard adapter models)

```bash
npx prisma migrate dev --name init && npx prisma generate
```

Singleton clients in **both** apps (`web/src/lib/prisma.ts`, `ws/src/lib/prisma.ts`):
```ts
import { PrismaClient } from "@prisma/client";
export const prisma = globalThis.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__prisma = prisma;
```

### 2.2 DM find-or-create with advisory lock
`web/src/lib/conversations.ts` (imported by the REST route in Phase 4 and reusable in tests):
```ts
export async function findOrCreateDirectConversation(aId: string, bId: string, creatorId: string) {
  const [lo, hi] = [aId, bId].sort();
  return prisma.$transaction(async (tx) => {
    // serialize concurrent creates for this user pair — two "start chat" clicks race-safe
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lo} || ":" || ${hi}))`;
    const existing = await tx.conversation.findFirst({
      where: {
        type: "DIRECT",
        AND: [
          { members: { some: { userId: aId } } },
          { members: { some: { userId: bId } } },
        ],
      },
      include: { members: true },
    });
    if (existing) return { conversation: existing, created: false };
    const conversation = await tx.conversation.create({
      data: {
        type: "DIRECT",
        createdById: creatorId,
        members: { create: [{ userId: aId, role: "MEMBER" }, { userId: bId, role: "MEMBER" }] },
      },
    });
    return { conversation, created: true };
  });
}
```

### 2.3 Seed (web/prisma/seed.ts)
- [ ] `bcryptjs.hash("Password123!", 10)` for all users
- [ ] **6 users**: alice, bob, carol, dev, erin, frank (avatar: none; distinct bios)
- [ ] **2 DMs**: alice↔bob (20 messages incl. one reply chain + one edited + one soft-deleted), carol↔dev (6 messages)
- [ ] **2 groups**: "Project Phoenix" (alice OWNER + bob, dev — SYSTEM "Alice created the group", 15 messages) and "All Hands" (dev OWNER + everyone, 20 messages)
- [ ] Staggered `lastReadAt`: bob has ~3 unread in DM-with-alice, erin ~5 in All Hands; alice fully read
- [ ] One IMAGE message with a tiny generated PNG uploaded through the **local** storage provider (`makeDummyPng()` — 8×8 valid PNG buffer), `attachmentWidth/Height: 8`
- [ ] `"db:seed": "tsx prisma/seed.ts"` script; seed is idempotent (`deleteMany` first in FK order)

## Verify (Definition of Done)
- [ ] `npm run db:migrate && npm run db:seed` → exit 0; Prisma Studio shows 6 users / 4 conversations / ~60 messages
- [ ] Unit test (web): `findOrCreateDirectConversation` — two parallel calls with the same pair resolve to **one** conversation id (real Postgres from compose)
- [ ] Index spot-check: `\d "Message"` in psql shows the keyset composite index
