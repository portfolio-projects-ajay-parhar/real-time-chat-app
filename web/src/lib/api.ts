import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { ApiErrorCode } from "@chat/shared";

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public status: number
  ) {
    super(message);
  }

  static unauthenticated(message = "You must be signed in") {
    return new ApiError("UNAUTHENTICATED", message, 401);
  }
  static forbidden(message = "You are not allowed to do that") {
    return new ApiError("FORBIDDEN", message, 403);
  }
  static notFound(message = "Not found") {
    return new ApiError("NOT_FOUND", message, 404);
  }
  static validation(message: string) {
    return new ApiError("VALIDATION", message, 422);
  }
  static rateLimited(message = "Too many requests, slow down") {
    return new ApiError("RATE_LIMITED", message, 429);
  }
  static conflict(message: string) {
    return new ApiError("CONFLICT", message, 409);
  }
  static payloadTooLarge(message = "File too large") {
    return new ApiError("PAYLOAD_TOO_LARGE", message, 413);
  }
}

export function handleApiError(err: unknown) {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { ok: false, code: err.code, message: err.message },
      { status: err.status }
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { ok: false, code: "VALIDATION", message: err.issues[0]?.message ?? "Invalid input" },
      { status: 422 }
    );
  }
  console.error("[api] unhandled error:", err);
  return NextResponse.json(
    { ok: false, code: "INTERNAL", message: "Something went wrong" },
    { status: 500 }
  );
}
