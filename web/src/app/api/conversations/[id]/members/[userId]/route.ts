import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { requireMembership } from "@/lib/conversations";

type Params = { params: Promise<{ id: string; userId: string }> };

/**
 * DELETE /api/conversations/[id]/members/[userId]
 * Self → leave (GROUP; last owner → 409). Other → OWNER removes (GROUP only).
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id, userId } = await params;
    const membership = await requireMembership(id, me.id);

    if (membership.conversation.type !== "GROUP") {
      throw ApiError.forbidden("Direct conversations have fixed members");
    }

    const isSelf = userId === me.id;
    if (!isSelf && membership.role !== "OWNER") {
      throw ApiError.forbidden("Only the group owner can remove members");
    }
    if (!isSelf) {
      const target = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: id, userId } },
      });
      if (!target) throw ApiError.notFound("Member not found");
    }

    if (isSelf && membership.role === "OWNER") {
      const otherOwners = await prisma.conversationMember.count({
        where: { conversationId: id, role: "OWNER", userId: { not: me.id } },
      });
      if (otherOwners === 0) {
        throw ApiError.conflict(
          "You are the last owner — promote another member before leaving"
        );
      }
    }

    const removedUser = isSelf
      ? { name: me.name }
      : await prisma.user.findUniqueOrThrow({
          where: { id: userId },
          select: { name: true },
        });

    await prisma.$transaction([
      prisma.conversationMember.delete({
        where: { conversationId_userId: { conversationId: id, userId } },
      }),
      prisma.message.create({
        data: {
          conversationId: id,
          type: "SYSTEM",
          body: isSelf
            ? `${me.name} left the group`
            : `${me.name} removed ${removedUser.name}`,
        },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
