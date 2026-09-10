import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearMediaUrlCache,
  getCachedSignedMediaUrl,
  getSignedMediaUrl,
} from "@/lib/media-url";

const fetchMock = vi.fn();

beforeEach(() => {
  clearMediaUrlCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("media-url — fetch-time signing cache", () => {
  it("signs once and serves subsequent reads from the cache", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ url: "/api/media/attachments/a.png?exp=1&sig=x" })
    );

    const url = await getSignedMediaUrl("attachments/a.png");
    expect(url).toBe("/api/media/attachments/a.png?exp=1&sig=x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/sign?key=attachments%2Fa.png",
      expect.anything()
    );

    // sync cache read — no fetch, no await
    expect(getCachedSignedMediaUrl("attachments/a.png")).toBe(url);
    expect(await getSignedMediaUrl("attachments/a.png")).toBe(url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-signs after the cache TTL (55 min < 1 h server signature)", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(Response.json({ url: "/api/media/k?v1" }))
      .mockResolvedValueOnce(Response.json({ url: "/api/media/k?v2" }));

    expect(await getSignedMediaUrl("k")).toBe("/api/media/k?v1");

    vi.advanceTimersByTime(56 * 60_000);
    expect(await getSignedMediaUrl("k")).toBe("/api/media/k?v2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops failed sign responses instead of caching them", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(Response.json({ url: "/api/media/k?v2" }));

    await expect(getSignedMediaUrl("k")).rejects.toThrow();
    expect(getCachedSignedMediaUrl("k")).toBeNull();
    expect(await getSignedMediaUrl("k")).toBe("/api/media/k?v2");
  });
});