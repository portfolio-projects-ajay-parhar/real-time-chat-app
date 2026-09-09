import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { userCard } from "@/lib/selects";

/**
 * GET /api/users?q= — user directory search.
 * ILIKE on name/email, ≥2 chars, limit 20, excludes self.
 * Presence is rendered client-side from the presence map, not trusted here.
 */
export async function GET(req: NextRequest) {
  try {
    const me = await requireUser();
    const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) return NextResponse.json({ users: [] });

    const users = await prisma.user.findMany({
      where: {
        id: { not: me.id },
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: userCard,
      orderBy: { name: "asc" },
      take: 20,
    });

    return NextResponse.json({ users });
  } catch (err) {
    return handleApiError(err);
  }
}
