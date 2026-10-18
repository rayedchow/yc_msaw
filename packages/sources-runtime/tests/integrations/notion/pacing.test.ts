import { afterEach, describe, expect, it, vi } from "vitest";
import { notionApiWithToken } from "../../../src/integrations/notion/client.js";

// Notion's rate limit is ~3 requests/second average per integration; the
// client paces request starts a minimum interval (~334ms) apart so bulk
// paging (e.g. /search walking up to 100 pages) never fires back-to-back.
describe("Notion proactive request pacing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("spaces concurrent request starts ~334ms apart (~3 req/s)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = Promise.all([
      notionApiWithToken("tok", "/search", { method: "POST", body: "{}" }),
      notionApiWithToken("tok", "/search", { method: "POST", body: "{}" }),
      notionApiWithToken("tok", "/search", { method: "POST", body: "{}" }),
    ]);

    // First request goes out immediately.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second request must not start before the pacing interval elapses.
    await vi.advanceTimersByTimeAsync(333);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Third request waits a full interval after the second.
    await vi.advanceTimersByTimeAsync(333);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await expect(pending).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);
  });
});
