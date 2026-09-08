import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { ApiError } from "./api";
import { prisma } from "./prisma";
import type { Session } from "next-auth";

export async function getAuthSession(): Promise<Session | null> {
  return getServerSession(authOptions);
}

/** Guard for API handlers — throws typed ApiError(401) when unauthenticated. */
export async function requireUser() {
  const session = await getAuthSession();
  if (!session?.user?.id) throw ApiError.unauthenticated();
  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) throw ApiError.unauthenticated("Session user no longer exists");
  return user;
}
