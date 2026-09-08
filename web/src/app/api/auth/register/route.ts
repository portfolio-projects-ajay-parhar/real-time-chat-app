import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { handleApiError, ApiError } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";

const registerSchema = z.object({
  name: z.string().min(1, "Name is required").max(50),
  email: z.string().email("Invalid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72, "Password too long"),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const { name, email, password } = registerSchema.parse(body);

    // basic rate limit per IP: 5 registrations / hour
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
    const allowed = await checkRateLimit(`ratelimit:register:${ip}`, 5, 3600);
    if (!allowed) throw ApiError.rateLimited("Too many sign-up attempts, try again later");

    const normalized = email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalized } });
    if (existing) throw ApiError.conflict("An account with this email already exists");

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email: normalized, passwordHash },
      select: { id: true, name: true, email: true },
    });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
