/**
 * Unit — typing throttle + instance-local registry (ws/src/handlers/typing.ts).
 * Broadcast-only design: the registry is pure in-memory state, timers are
 * memory hygiene, clearUser powers the implicit disconnect stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createThrottle,
  createTypingRegistry,
  TYPING_TTL_MS,
} from "../src/handlers/typing.js";

describe("createThrottle", () => {
  it("fires once per window", () => {
    const fire = createThrottle(2_000);
    let now = 1_000;
    expect(fire("a:b", now)).toBe(true);
    expect(fire("a:b", now + 1_999)).toBe(false);
    expect(fire("a:b", now + 2_000)).toBe(true);
  });

  it("keys are independent (user+conversation pairs don't collide)", () => {
    const fire = createThrottle(2_000);
    const now = 1_000;
    expect(fire("a:c1", now)).toBe(true);
    expect(fire("a:c2", now)).toBe(true);
    expect(fire("a:c1", now + 100)).toBe(false);
  });
});

describe("createTypingRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tracks and clears typers per conversation", () => {
    const registry = createTypingRegistry();
    registry.start("c1", "u1");
    registry.start("c1", "u2");
    registry.start("c2", "u1");

    expect(registry.getUserIds("c1").sort()).toEqual(["u1", "u2"]);
    expect(registry.getUserIds("c2")).toEqual(["u1"]);
    expect(registry.getUserIds("c3")).toEqual([]);

    expect(registry.stop("c1", "u1")).toBe(true);
    expect(registry.stop("c1", "u1")).toBe(false); // already cleared
    expect(registry.getUserIds("c1")).toEqual(["u2"]);
  });

  it("auto-expires entries after TYPING_TTL_MS (memory hygiene)", () => {
    const registry = createTypingRegistry();
    registry.start("c1", "u1");
    expect(registry.getUserIds("c1")).toEqual(["u1"]);

    vi.advanceTimersByTime(TYPING_TTL_MS - 1);
    expect(registry.getUserIds("c1")).toEqual(["u1"]);

    vi.advanceTimersByTime(1);
    expect(registry.getUserIds("c1")).toEqual([]);
  });

  it("refreshing a typer extends their TTL", () => {
    const registry = createTypingRegistry();
    registry.start("c1", "u1");
    vi.advanceTimersByTime(TYPING_TTL_MS - 1);
    registry.start("c1", "u1"); // continuous typing → refresh
    vi.advanceTimersByTime(TYPING_TTL_MS - 1);
    expect(registry.getUserIds("c1")).toEqual(["u1"]);
  });

  it("clearUser drops every conversation entry for a user (disconnect)", () => {
    const registry = createTypingRegistry();
    registry.start("c1", "u1");
    registry.start("c2", "u1");
    registry.start("c1", "u2");

    const affected = registry.clearUser("u1");
    expect(affected.sort()).toEqual(["c1", "c2"]);
    expect(registry.getUserIds("c1")).toEqual(["u2"]);
    expect(registry.getUserIds("c2")).toEqual([]);

    expect(registry.clearUser("u1")).toEqual([]); // nothing left
  });
});