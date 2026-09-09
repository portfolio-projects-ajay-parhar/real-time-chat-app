import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  findOrCreateDirectConversation,
  createGroupConversation,
  getInbox,
} from "@/lib/conversations";

const createSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("DIRECT"), userId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal("GROUP"),
    name: z.string().trim().min(1, "Group name is required").max(80),
    memberIds: z.array(z.string().min(1).max(64)).min(1).max(49),
  }),
]);

/** GET /api/conversations — the inbox projection. */
export async function GET() {
  try {
    const me = await requireUser();
    const inbox = await getInbox(me.id);
    return NextResponse.json({ conversations: inbox });
  } catch (err) {
    return handleApiError(err);
  }
}

/** POST /api/conversations — start a DM (advisory-lock dedupe) or create a group. */
export async function POST(req: NextRequest) {
  try {
    const me = await requireUser();
    const body = createSchema.parse(await req.json().catch(() => null));

    // modest abuse cap: 20 conversation creations / hour / user
    const allowed = await checkRateLimit(`ratelimit:conv:${me.id}`, 20, 3600);
    if (!allowed) throw ApiError.rateLimited("Too many conversations created, try again later");

    if (body.type === "DIRECT") {
      if (body.userId === me.id) {
        throw ApiError.validation("You cannot start a chat with yourself");
      }
      const target = await prisma.user.findUnique({ where: { id: body.userId } });
      if (!target) throw ApiError.notFound("User not found");

      const conversation = await findOrCreateDirectConversation(me.id, body.userId);
      return NextResponse.json({ conversation }, { status: 201 });
    }

    // GROUP — every member must exist
    const uniqueMemberIds = [...new Set(body.memberIds)];
    const found = await prisma.user.findMany({
      where: { id: { in: uniqueMemberIds } },
      select: { id: true },
    });
    if (found.length !== uniqueMemberIds.length) {
      throw ApiError.validation("One or more members do not exist");
    }

    const conversation = await createGroupConversation(me.id, body.name, uniqueMemberIds);
    return NextResponse.json(
      {
        conversation: {
          id: conversation.id,
          type: conversation.type,
          name: conversation.name,
          createdById: conversation.createdById,
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
      },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
