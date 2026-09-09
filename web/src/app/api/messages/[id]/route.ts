import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { requireMembership } from "@/lib/conversations";

type Params = { params: Promise<{ id: string }> };

const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

const patchSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty").max(4000),
});

/** PATCH /api/messages/[id] — edit own TEXT message within 15 minutes. */
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;

    const message = await prisma.message.findUnique({ where: { id } });
    if (!message || message.deletedAt) throw ApiError.notFound("Message not found");

    await requireMembership(message.conversationId, me.id);

    if (message.senderId !== me.id) {
      throw ApiError.forbidden("You can only edit your own messages");
    }
    if (message.type !== "TEXT") {
      throw ApiError.validation("Only text messages can be edited");
    }
    if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
      throw ApiError.validation("Edit window (15 minutes) has expired");
    }

    const { body } = patchSchema.parse(await req.json().catch(() => null));

    const updated = await prisma.message.update({
      where: { id },
      data: { body, editedAt: new Date() },
      include: {
        sender: {
          select: { id: true, name: true, image: true, bio: true, lastSeenAt: true },
        },
        replyTo: { include: { sender: { select: { id: true, name: true } } } },
      },
    });

    return NextResponse.json({ message: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE /api/messages/[id] — soft delete (tombstone stays in history). */
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const me = await requireUser();
    const { id } = await params;

    const message = await prisma.message.findUnique({ where: { id } });
    if (!message || message.deletedAt) throw ApiError.notFound("Message not found");

    const membership = await requireMembership(message.conversationId, me.id);

    const isSender = message.senderId === me.id;
    const isConversationOwner = membership.role === "OWNER";
    if (!isSender && !isConversationOwner) {
      throw ApiError.forbidden("Only the sender or a conversation owner can delete a message");
    }

    const updated = await prisma.message.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: { id: true, deletedAt: true, conversationId: true },
    });

    return NextResponse.json({ message: updated });
  } catch (err) {
    return handleApiError(err);
  }
}
