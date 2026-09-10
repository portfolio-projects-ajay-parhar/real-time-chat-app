import { describe, it, expect } from "vitest";
import { validateAttachment } from "../src/lib/attachment.js";

describe("validateAttachment — message:send defense in depth", () => {
  const ok = {
    type: "IMAGE" as const,
    mime: "image/png",
    key: "attachments/alice/k1-photo.png",
    userId: "alice",
  };

  it("accepts an image attachment uploaded by the sender", () => {
    expect(validateAttachment(ok)).toEqual({ ok: true });
  });

  it("accepts FILE messages with non-image mimes", () => {
    expect(
      validateAttachment({
        ...ok,
        type: "FILE",
        mime: "application/pdf",
        key: "attachments/alice/k2-report.pdf",
      })
    ).toEqual({ ok: true });
  });

  it("rejects mimes outside the allowlist", () => {
    expect(validateAttachment({ ...ok, mime: "application/zip" }).ok).toBe(false);
    expect(validateAttachment({ ...ok, mime: "image/svg+xml" }).ok).toBe(false);
    expect(validateAttachment({ ...ok, mime: "text/html" }).ok).toBe(false);
  });

  it("rejects keys the sender never uploaded (or crafted paths)", () => {
    expect(
      validateAttachment({ ...ok, key: "attachments/mallory/other.png" }).ok
    ).toBe(false);
    expect(validateAttachment({ ...ok, key: "avatars/alice/x.png" }).ok).toBe(false);
    expect(
      validateAttachment({ ...ok, key: "attachments/alice/../../secrets" }).ok
    ).toBe(false);
    expect(validateAttachment({ ...ok, key: "" }).ok).toBe(false);
  });

  it("keeps IMAGE/FILE consistent with the mime kind", () => {
    expect(validateAttachment({ ...ok, mime: "application/pdf" }).ok).toBe(false);
    expect(
      validateAttachment({ ...ok, type: "FILE", key: "attachments/alice/k3" }).ok
    ).toBe(false);
  });
});