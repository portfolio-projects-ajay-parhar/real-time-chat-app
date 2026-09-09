import { NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/api";
import { requireUser } from "@/lib/session";
import { validateUpload, MAX_UPLOAD_BYTES, ALLOWED_MIMES } from "@/lib/media";
import { getStorage } from "@/lib/storage";
import { createId } from "@/lib/id";

/**
 * POST /api/media — multipart upload → storage provider.
 * Allowlist + magic-byte sniff + 10 MB cap; the key embeds the uploader's
 * user id and is never client-controlled.
 */
export async function POST(req: NextRequest) {
  try {
    const me = await requireUser();

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw ApiError.validation("Expected multipart/form-data");
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw ApiError.validation("Missing file field");
    if (file.size === 0) throw ApiError.validation("Empty file");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw ApiError.payloadTooLarge("Files may be at most 10 MB");
    }

    const declaredMime = file.type || "application/octet-stream";
    if (!ALLOWED_MIMES.includes(declaredMime as (typeof ALLOWED_MIMES)[number])) {
      throw new ApiError(
        "VALIDATION",
        `File type ${declaredMime} is not allowed`,
        415
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const { mime } = validateUpload({ buffer, declaredMime });

    // attachments/{userId}/{cuid}-{safeName} — sanitized display name only.
    const safeName = (file.name || "file")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(-80);
    const key = `attachments/${me.id}/${createId()}-${safeName}`;

    await getStorage().upload(buffer, key, mime);

    return NextResponse.json(
      {
        key,
        name: file.name,
        size: buffer.length,
        mime,
      },
      { status: 201 }
    );
  } catch (err) {
    return handleApiError(err);
  }
}
