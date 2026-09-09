import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { requireMembership } from "@/lib/conversations";
import { userCard } from "@/lib/selects";

type Params = { params: Promise<{ id: string }> };

const addSchema = z.object({
  userIds: z.array(z.string().min(1).max(64)).min(1).max(20),
});

/**
 * POST /api/conversations/[id]/members — add members.
 * OWNER only and GROUP only (a DM's member set is fixed by design).
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;
    const membership = await requireMembership(id, me.id);

    if (membership.conversation.type !== "GROUP") {
      throw ApiError.forbidden("Members cannot be added to a direct conversation");
    }
    if (membership.role !== "OWNER") {
      throw ApiError.forbidden("Only the group owner can add members");
    }

    const { userIds } = addSchema.parse(await req.json().catch(() => null));

    const existing = await prisma.conversationMember.findMany({
      where: { conversationId: id },
      select: { userId: true },
    });
    const existingIds = new Set(existing.map((m) => m.userId));

    const toAdd = [...new Set(userIds)].filter((uid) => !existingIds.has(uid));
    if (toAdd.length === 0) {
      throw ApiError.validation("All users are already members");
    }

    const users = await prisma.user.findMany({
      where: { id: { in: toAdd } },
      select: { id: true, name: true },
    });
    if (users.length !== toAdd.length) {
      throw ApiError.validation("One or more users do not exist");
    }

    const [conversation] = await prisma.$transaction([
      prisma.conversation.update({
        where: { id },
        data: { members: { create: toAdd.map((userId) => ({ userId })) } },
        include: { members: { include: { user: { select: userCard } } } },
      }),
      prisma.message.create({
        data: {
          conversationId: id,
          type: "SYSTEM",
          body: `${me.name} added ${users.map((u) => u.name).join(", ")}`,
        },
      }),
    ]);

    return NextResponse.json(
      {
        members: conversation.members.map((m) => ({
          id: m.userId,
          role: m.role,
          lastReadAt: m.lastReadAt,
          isMuted: m.isMuted,
          user: {
            id: m.user.id,
            name: m.user.name,
            image: m.user.image,
            bio: m.user.bio,
          },
        })),
      },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
