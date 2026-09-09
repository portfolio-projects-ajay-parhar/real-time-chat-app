import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { requireMembership } from "@/lib/conversations";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/conversations/[id]/read — REST read fallback (the socket
 * `conversation:read` path in Phase 7 is primary). Advances the member's
 * `lastReadAt` watermark; unread derives from it everywhere.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;
    await requireMembership(id, me.id);

    const member = await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: id, userId: me.id } },
      data: { lastReadAt: new Date() },
      select: { lastReadAt: true },
    });

    return NextResponse.json({ ok: true, lastReadAt: member.lastReadAt });
  } catch (err) {
    return handleApiError(err);
  }
}
