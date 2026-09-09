import type { Prisma } from "@prisma/client";

/**
 * Canonical "user card" projection — the minimal user shape every list,
 * message sender and conversation member needs. Presence is rendered
 * client-side from the presence map, never trusted from `lastSeenAt` alone.
 */
export const userCard = {
  id: true,
  name: true,
  image: true,
  bio: true,
  lastSeenAt: true,
} satisfies Prisma.UserSelect;

export type UserCard = Prisma.UserGetPayload<{ select: typeof userCard }>;
