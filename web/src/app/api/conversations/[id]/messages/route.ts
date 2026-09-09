import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { requireMembership } from "@/lib/conversations";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { userCard } from "@/lib/selects";

type Params = { params: Promise<{ id: string }> };

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

const messageInclude = {
  sender: { select: userCard },
  replyTo: { include: { sender: { select: userCard } } },
} as const;

/**
 * GET /api/conversations/[id]/messages — keyset-paginated history.
 *
 * Default: newest-first page addressed by `cursor` (base64url(createdAt~id)
 * of the oldest loaded message); `(createdAt, id)` tuple comparison with the
 * `id` tiebreak keeps pages stable under same-millisecond bursts and live
 * appends — the whole point of keyset over offset on this table.
 *
 * `?after=<ISO>` (reconnect gap backfill): ascending messages created after
 * the given instant.
 * Tombstones (soft-deleted) are filtered server-side; the client renders
 * pending/optimistic bubbles independently.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;
    await requireMembership(id, me.id);

    const sp = req.nextUrl.searchParams;
    const cursorParam = sp.get("cursor");
    const afterParam = sp.get("after");
    const limit = Math.min(
      Math.max(Number(sp.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );

    if (cursorParam && afterParam) {
      throw ApiError.validation("Use either cursor or after, not both");
    }

    // Reconnect backfill variant — ascending, strictly after `after`.
    if (afterParam) {
      const after = new Date(afterParam);
      if (Number.isNaN(after.getTime())) {
        throw ApiError.validation("Invalid after timestamp");
      }
      const messages = await prisma.message.findMany({
        where: {
          conversationId: id,
          deletedAt: null,
          createdAt: { gt: after },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit,
        include: messageInclude,
      });
      return NextResponse.json({ messages, nextCursor: null });
    }

    // Keyset page — newest first internally, returned oldest → newest.
    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    const where = cursor
      ? {
          conversationId: id,
          deletedAt: null,
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : { conversationId: id, deletedAt: null };

    const rows = await prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, // fetch one extra to detect the next page
      include: messageInclude,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

    return NextResponse.json({
      messages: [...page].reverse(),
      nextCursor,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
