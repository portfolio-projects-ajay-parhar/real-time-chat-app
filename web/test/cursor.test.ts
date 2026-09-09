import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
import { ApiError } from "@/lib/api";

describe("cursor encode/decode", () => {
  it("round-trips a message position", () => {
    const m = { createdAt: new Date("2026-09-09T12:34:56.789Z"), id: "cma0test123" };
    const encoded = encodeCursor(m);
    expect(encoded).not.toContain("~");
    expect(decodeCursor(encoded)).toEqual(m);
  });

  it("produces URL-safe base64", () => {
    const encoded = encodeCursor({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "abc?&=/+",
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it("rejects garbage", () => {
    for (const bad of ["not-a-cursor", "~~", "", "AAAA"] as string[]) {
      // "AAAA" decodes to NUL bytes → no valid `iso~id`
      expect(() => decodeCursor(bad)).toThrow(ApiError);
    }
  });

  it("rejects an invalid timestamp inside a decodable payload", () => {
    const forged = Buffer.from("nope~someid").toString("base64url");
    expect(() => decodeCursor(forged)).toThrow(/Invalid cursor/);
  });

  it("ApiError from bad cursor is VALIDATION/422", () => {
    try {
      decodeCursor("zzzz");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("VALIDATION");
      expect((err as ApiError).status).toBe(422);
    }
  });
});
