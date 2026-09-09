import { NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { verifyMediaSignature, getStorage } from "@/lib/storage";

type Params = { params: Promise<{ key: string[] }> };

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
};

/**
 * GET /api/media/[...key]?exp=&sig= — local provider streaming route.
 * HMAC-signed and time-limited (S3/Cloudinary serve their own URLs).
 * Requires an authenticated session in addition to a valid signature.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    await requireUser();

    const { key: keyParts } = await params;
    const key = keyParts.join("/");
    if (keyParts.length < 2) throw ApiError.forbidden("Invalid storage key");

    verifyMediaSignature(key, req.nextUrl.searchParams);

    let data: Buffer;
    try {
      data = await getStorage().read(key);
    } catch {
      throw ApiError.notFound("File not found");
    }

    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";

    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(data.length),
        // private: signed URLs are user-scoped; immutable: keys are cuid-suffixed
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
