import { NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { getStorage } from "@/lib/storage";

/**
 * GET /api/media/sign?key= — mint a fresh signed download URL for a storage
 * key (session-guarded; the signature itself is provider-side: HMAC for the
 * local provider, presigned URLs for S3/Cloudinary).
 *
 * The client fetches this lazily at render time (lib/media-url.ts) and caches
 * the result, so a long-lived chat never renders an expired link — the phase-9
 * "fetch-time signing" lifecycle. URL TTL is 1 h; the client cache refreshes
 * before that.
 */
export async function GET(req: NextRequest) {
  try {
    await requireUser();

    const key = req.nextUrl.searchParams.get("key");
    if (!key || key.length > 512 || key.includes("..")) {
      throw ApiError.validation("Invalid storage key");
    }

    const url = await getStorage().getDownloadUrl(key, 60 * 60);
    return NextResponse.json(
      { url },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
