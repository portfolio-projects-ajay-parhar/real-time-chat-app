import { prisma } from "./prisma";

/**
 * Find-or-create a DIRECT conversation between two users.
 *
 * There is no relational constraint for "the DIRECT conversation whose member
 * set is exactly {A, B}", so concurrent "start chat" clicks from both sides
 * could create duplicate DMs. Instead we serialize on a Postgres transaction-
 * scoped advisory lock keyed by the sorted user pair, then find-or-create.
 */
export async function findOrCreateDirectConversation(aId: string, bId: string) {
  const [lo, hi] = [aId, bId].sort();
  return prisma.$transaction(async (tx) => {
    // Lock the pair for the lifetime of this transaction; concurrent callers
    // block here until the first one commits.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`dm:${lo}~${hi}`}))::text`;

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
    if (existing && existing.members.length === 2) return existing;

    return tx.conversation.create({
      data: {
        type: "DIRECT",
        createdById: aId,
        members: {
          create: [{ userId: aId }, { userId: bId }],
        },
      },
      include: { members: true },
    });
  });
}
