import { describe, expect, it } from "vitest";
import {
  dayLabel,
  isSameLocalDay,
  shouldShowDateSeparator,
  shouldShowSender,
} from "../src/lib/message-grouping";

const iso = (s: string) => new Date(s).toISOString();

describe("date separators", () => {
  // Local-time constructors so the test is timezone-independent.
  const local = (y: number, mo: number, d: number, h = 12) =>
    new Date(y, mo, d, h).toISOString();
  const now = new Date(2026, 8, 10, 15, 0); // 10 Sep 2026, local

  it("same local day detection", () => {
    expect(isSameLocalDay(local(2026, 8, 10, 1), local(2026, 8, 10, 23))).toBe(true);
    expect(isSameLocalDay(local(2026, 8, 10, 23), local(2026, 8, 11, 0))).toBe(false);
  });

  it("first message always gets a separator", () => {
    expect(shouldShowDateSeparator(undefined, local(2026, 8, 10, 10))).toBe(true);
  });

  it("separator on day change only", () => {
    const a = local(2026, 8, 10, 10);
    const b = local(2026, 8, 10, 18);
    const c = local(2026, 8, 11, 9);
    expect(shouldShowDateSeparator(a, b)).toBe(false);
    expect(shouldShowDateSeparator(b, c)).toBe(true);
  });

  it("day labels: Today / Yesterday / dated", () => {
    expect(dayLabel(now.toISOString(), now)).toBe("Today");
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    expect(dayLabel(yesterday.toISOString(), now)).toBe("Yesterday");
    // Locale-dependent order ("5 Mar" / "Mar 5") — assert on the parts.
    const label = dayLabel(iso("2026-03-05T12:00:00Z"), now);
    expect(label).toContain("Mar");
    expect(label).toContain("5");
    // different year → includes the year
    expect(dayLabel(iso("2024-03-05T12:00:00Z"), now)).toContain("2024");
  });
});

describe("sender grouping (5-minute window)", () => {
  const msg = (
    senderId: string,
    at: string,
    type: "TEXT" | "SYSTEM" = "TEXT"
  ) => ({
    senderId,
    type,
    createdAt: iso(at),
  });

  it("first message shows the sender", () => {
    expect(shouldShowSender(undefined, msg("a", "2026-09-10T10:00:00Z"))).toBe(true);
  });

  it("same sender within 5 minutes groups (no sender row)", () => {
    const prev = msg("a", "2026-09-10T10:00:00Z");
    expect(shouldShowSender(prev, msg("a", "2026-09-10T10:04:59Z"))).toBe(false);
  });

  it("same sender beyond 5 minutes breaks the group", () => {
    const prev = msg("a", "2026-09-10T10:00:00Z");
    expect(shouldShowSender(prev, msg("a", "2026-09-10T10:05:01Z"))).toBe(true);
  });

  it("different sender always breaks the group", () => {
    const prev = msg("a", "2026-09-10T10:00:00Z");
    expect(shouldShowSender(prev, msg("b", "2026-09-10T10:00:10Z"))).toBe(true);
  });

  it("SYSTEM messages never group", () => {
    const prev = msg("a", "2026-09-10T10:00:00Z", "SYSTEM");
    const next = msg("a", "2026-09-10T10:00:05Z", "SYSTEM");
    expect(shouldShowSender(prev, msg("a", "2026-09-10T10:00:05Z"))).toBe(true);
    expect(shouldShowSender(msg("a", "2026-09-10T10:00:00Z"), next)).toBe(true);
  });
});
