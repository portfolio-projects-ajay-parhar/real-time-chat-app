import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { requireMembership } from "@/lib/conversations";
import { userCard } from "@/lib/selects";

type Params = { params: Promise<{ id: string }> };

/** GET /api/conversations/[id] — details + members (lastReadAt drives receipts UI). */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;
    await requireMembership(id, me.id);

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        members: {
          include: { user: { select: userCard } },
          orderBy: { joinedAt: "asc" },
        },
      },
    });
    if (!conversation) throw ApiError.notFound("Conversation not found");

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        type: conversation.type,
        name: conversation.name,
        avatarKey: conversation.avatarKey,
        createdById: conversation.createdById,
        createdAt: conversation.createdAt,
        lastMessageAt: conversation.lastMessageAt,
        members: conversation.members.map((m) => ({
          id: m.userId,
          role: m.role,
          lastReadAt: m.lastReadAt,
          isMuted: m.isMuted,
          joinedAt: m.joinedAt,
          user: {
            id: m.user.id,
            name: m.user.name,
            image: m.user.image,
            bio: m.user.bio,
            lastSeenAt: m.user.lastSeenAt,
          },
        })),
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatarKey: z.string().min(1).max(512).optional(),
});

/** PATCH /api/conversations/[id] — GROUP rename/avatar, OWNER only. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const membership = await requireMembership(id, me.id);

    if (membership.conversation.type !== "GROUP") {
      throw ApiError.forbidden("Direct conversations cannot be renamed");
    }
    if (membership.role !== "OWNER") {
      throw ApiError.forbidden("Only the group owner can do that");
    }

    const body = patchSchema.parse(await req.json().catch(() => null));

    const [conversation] = await prisma.$transaction([
      prisma.conversation.update({ where: { id }, data: body }),
      ...(body.name
        ? [
            prisma.message.create({
              data: {
                conversationId: id,
                type: "SYSTEM",
                body: `${me.name} renamed the group to "${body.name}"`,
              },
            }),
          ]
        : []),
    ]);

    return NextResponse.json({ conversation });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * DELETE /api/conversations/[id] — leave a GROUP.
 * A group must always keep at least one owner → last owner gets 409.
 * (Direct conversations are left implicitly — they simply exist or don't.)
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const membership = await requireMembership(id, me.id);

    if (membership.conversation.type !== "GROUP") {
      throw ApiError.forbidden("Direct conversations cannot be left");
    }

    if (membership.role === "OWNER") {
      const otherOwners = await prisma.conversationMember.count({
        where: { conversationId: id, role: "OWNER", userId: { not: me.id } },
      });
      if (otherOwners === 0) {
        throw ApiError.conflict(
          "You are the last owner — promote another member before leaving"
        );
      }
    }

    await prisma.$transaction([
      prisma.conversationMember.delete({
        where: { conversationId_userId: { conversationId: id, userId: me.id } },
      }),
      prisma.message.create({
        data: {
          conversationId: id,
          type: "SYSTEM",
          body: `${me.name} left the group`,
        },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
