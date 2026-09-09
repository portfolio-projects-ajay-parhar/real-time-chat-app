import { describe, it, expect } from "vitest";
import { validateUpload, MAX_UPLOAD_BYTES } from "@/lib/media";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from("GIF89a0100");
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
]);
const PDF = Buffer.from("%PDF-1.7\n%…\n");

describe("validateUpload — magic-byte rejection table", () => {
  it("accepts content matching the declared type", () => {
    expect(validateUpload({ buffer: JPEG, declaredMime: "image/jpeg" }).mime).toBe("image/jpeg");
    expect(validateUpload({ buffer: PNG, declaredMime: "image/png" }).mime).toBe("image/png");
    expect(validateUpload({ buffer: GIF, declaredMime: "image/gif" }).mime).toBe("image/gif");
    expect(validateUpload({ buffer: WEBP, declaredMime: "image/webp" }).mime).toBe("image/webp");
    expect(validateUpload({ buffer: PDF, declaredMime: "application/pdf" }).mime).toBe("application/pdf");
    expect(
      validateUpload({ buffer: Buffer.from("hello plain text"), declaredMime: "text/plain" }).mime
    ).toBe("text/plain");
  });

  it("rejects declared mime not on the allowlist (415)", () => {
    for (const mime of ["application/zip", "text/html", "application/javascript", "image/svg+xml"]) {
      try {
        validateUpload({ buffer: Buffer.from("x"), declaredMime: mime });
        expect.unreachable(`${mime} should have been rejected`);
      } catch (err) {
        expect((err as { status: number }).status).toBe(415);
      }
    }
  });

  it("rejects mismatched magic bytes (exe renamed to .png)", () => {
    const exe = Buffer.concat([
      Buffer.from("MZ"),
      Buffer.from([0x90, 0x00, 0x03, 0x00]),
    ]);
    expect(() => validateUpload({ buffer: exe, declaredMime: "image/png" })).toThrow();
  });

  it("rejects a png declared as jpeg (sniff ≠ declared)", () => {
    expect(() =>
      validateUpload({ buffer: PNG, declaredMime: "image/jpeg" })
    ).toThrow(/does not match/);
  });

  it("rejects binary content declared as text/plain", () => {
    expect(() =>
      validateUpload({ buffer: PNG, declaredMime: "text/plain" })
    ).toThrow();
    expect(() =>
      validateUpload({ buffer: Buffer.from("a\0b"), declaredMime: "text/plain" })
    ).toThrow();
  });

  it("rejects empty files and oversize payloads (413)", () => {
    expect(() => validateUpload({ buffer: Buffer.alloc(0), declaredMime: "image/png" })).toThrow(/Empty/);
    try {
      validateUpload({
        buffer: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1),
        declaredMime: "image/png",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as { status: number }).status).toBe(413);
    }
  });
});
