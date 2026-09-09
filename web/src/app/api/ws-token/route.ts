import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getToken } from "next-auth/jwt";
import type { NextApiRequest } from "next";
import { handleApiError, ApiError } from "@/lib/api";
import { getAuthSession } from "@/lib/session";

/**
 * Returns the raw NextAuth session JWT for the WS handshake fallback
 * (used when the same-origin /socket.io cookie proxy isn't available).
 * Authenticated user only — never exposed to third parties.
 */
export async function GET() {
  try {
    const session = await getAuthSession();
    if (!session?.user?.id) throw ApiError.unauthenticated();

    // next-auth/jwt getToken() expects a Pages-API-style req; build a shim
    // from the App Router headers.
    const cookieHeader = (await headers()).get("cookie") ?? "";
    const cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((p) => p.trim().split(/=(.*)/))
        .filter((p) => p.length >= 2)
        .map(([k, v]) => [k, decodeURIComponent(v)])
    );
    const shimmedReq = {
      headers: { cookie: cookieHeader },
      cookies,
    } as unknown as NextApiRequest;

    const token = await getToken({
      req: shimmedReq,
      secret: process.env.NEXTAUTH_SECRET,
      raw: true, // raw JWE string — the ws server decodes it with NEXTAUTH_SECRET
    });
    if (!token) throw ApiError.unauthenticated("Session token could not be read");

    return NextResponse.json({ token });
  } catch (err) {
    return handleApiError(err);
  }
}
