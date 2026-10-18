/**
 * Google Docs fidelity fix F4: gigabrain 4a4d68fc's bounded concurrent changelog page fetch, restored in both
 * capture paths (source-lane `captureChangelogPages` and the donor `fetchDocChangelog`), with fail-closed
 * contiguous-prefix semantics, per-credential pacing and no 429 amplification. Synthetic latency-injected fakes only.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { db, entry, liveFile, ready, resetTenant, xssi, passGoogleFloors } from "./harness.js";
import { captureChangelogPages, type ChangelogCaptureResult } from "../../../../src/source-lane/providers/google-docs/changelog-capture.js";
import { exportDocHistory } from "../../../../src/source-lane/providers/google-docs/history-export.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { resetChangelogPacingForTests } from "../../../../src/source-lane/providers/google-docs/changelog-page-pool.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";
import { collectSnapshotOps, fetchDocChangelog, parseChangelogEntries } from "../../../../src/polling/_archived-gdocs/gdocs-revisions-load.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";

const deps = { db: db as unknown as SqlDatabase };
const DOC = "doc-concurrency";
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0);
const A = "user-ada";

function entries(total: number): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 1; i <= total; i++) out.push(entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: String.fromCharCode(97 + (i % 26)) } }, T0 + i * 1000, A, i));
  return out;
}

interface Scenario {
  entries: unknown[][];
  latencyMs?: number;
  /** Failures answer after 1 ms, so the pool learns of them while siblings are still in flight (deterministic order). */
  /** load start -> override */
  fail?: Record<number, { status: number; headers?: Record<string, string> }>;
  short?: Record<number, number>;
  loadStatus?: number;
  tilesTotal?: number | null;
}

/** Fake Google with per-request latency; records dispatch/finish times and concurrency of /revisions/load. */
function latencyFetch(s: Scenario) {
  const log: Array<{ start: number; sentAt: number; doneAt: number; status: number }> = [];
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname.split("/").pop()!);
    if (url.pathname.endsWith("/revisions/tiles")) {
      const total = s.tilesTotal === undefined ? s.entries.length : s.tilesTotal;
      if (total === null) return new Response("", { status: 500 });
      return xssi({ tileInfo: [{ start: 1, end: total, endMillis: T0, users: [A] }], userMap: { [A]: { name: "Ada", anonymous: false } } });
    }
    const start = Number(url.searchParams.get("start"));
    const end = Number(url.searchParams.get("end"));
    const sentAt = performance.now();
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const fail = s.loadStatus ? { status: s.loadStatus } : s.fail?.[start];
    await sleep(fail && !s.loadStatus ? 1 : (s.latencyMs ?? 15));
    inFlight--;
    const res = fail
      ? new Response(JSON.stringify({ error: { message: "synthetic" } }), { status: fail.status, headers: fail.headers })
      : xssi({ changelog: s.entries.slice(start - 1, s.short?.[start] ? start - 1 + s.short[start] : end), ...(start === 1 ? { chunkedSnapshot: [[]] } : {}) });
    log.push({ start, sentAt, doneAt: performance.now(), status: res.status });
    return res;
  };
  return { impl, log, calls, maxInFlight: () => maxInFlight };
}

let tokenSeq = 0;
async function capture(s: Scenario, pageConcurrency: number, requestsPerSecond = 0, token = `tok-${++tokenSeq}`) {
  const f = latencyFetch(s);
  const result = await captureChangelogPages(
    { tenantId: "tenant-conc", mailbox: "ada@corp.example", accessToken: token, fetchImpl: f.impl },
    DOC,
    { pageConcurrency, requestsPerSecond, authMode: "domain_wide_delegation" },
  );
  return { result, ...f };
}

/** Everything a caller consumes, without wall-clock fields. */
function observable(r: ChangelogCaptureResult) {
  return {
    state: r.state, reason: r.reason, httpStatus: r.httpStatus, retryAfterSeconds: r.retryAfterSeconds, failedRange: r.failedRange,
    fetchedEntries: r.fetchedEntries, tilesTotal: r.tilesTotal,
    pages: r.pages.map((p) => ({ start: p.start, end: p.end, changelog: p.changelog, chunkedSnapshot: p.chunkedSnapshot })),
  };
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await passGoogleFloors();
  resetChangelogPacingForTests();
});

describe("captureChangelogPages: bounded concurrent known-total fetch", () => {
  it("runs up to the bound in parallel and returns exactly what a serial run returns", async () => {
    const s = { entries: entries(8000), latencyMs: 25 };
    const serial = await capture(s, 1);
    const parallel = await capture(s, 4);
    expect(serial.maxInFlight()).toBe(1);
    expect(parallel.maxInFlight()).toBe(4);
    expect(parallel.result.stats).toMatchObject({ requests: 9, maxInFlight: 4, concurrency: 4 });
    expect(observable(parallel.result)).toEqual(observable(serial.result));
    expect(parallel.result.state).toBe("complete");
    expect(parallel.result.pages.map((p) => p.start)).toEqual([1, 1001, 2001, 3001, 4001, 5001, 6001, 7001]);
    expect(parallel.calls.filter((c) => c === "load")).toHaveLength(8); // no extra requests
  });

  it("a failed middle page stops the run: same prefix and failedRange as serial, nothing sent once it is known", async () => {
    const s = { entries: entries(10_000), latencyMs: 20, fail: { 4001: { status: 500 } } };
    const serial = await capture(s, 1);
    const parallel = await capture(s, 3);
    expect(observable(parallel.result)).toEqual(observable(serial.result));
    expect(parallel.result).toMatchObject({ state: "partial", reason: "load_http_500", failedRange: { start: 4001, end: 5000 }, fetchedEntries: 4000 });
    const failedAt = parallel.log.find((l) => l.start === 4001)!.doneAt;
    expect(parallel.log.filter((l) => l.sentAt > failedAt)).toEqual([]);
    // pages 1-3, then 3001/4001/5001 in flight together: 5001 is the only wasted request (< concurrency); 6001+ never sent
    expect(parallel.log.map((l) => l.start).sort((a, b) => a - b)).toEqual([1, 1001, 2001, 3001, 4001, 5001]);
    expect(serial.log).toHaveLength(5);
  });

  it("a short middle page is kept (as serially) and stops the run", async () => {
    const s = { entries: entries(6000), latencyMs: 10, short: { 3001: 999 } };
    const serial = await capture(s, 1);
    const parallel = await capture(s, 4);
    expect(observable(parallel.result)).toEqual(observable(serial.result));
    expect(parallel.result).toMatchObject({ state: "partial", reason: "short_page_expected_1000_got_999", failedRange: { start: 3001, end: 4000 } });
    expect(parallel.result.pages.map((p) => [p.start, p.changelog.length])).toEqual([[1, 1000], [1001, 1000], [2001, 1000], [3001, 999]]);
  });

  it("429s: takes the longest Retry-After, sends nothing new after the first 429, then honours the cooldown", async () => {
    const s = {
      entries: entries(12_000), latencyMs: 30,
      fail: { 2001: { status: 429, headers: { "retry-after": "120" } }, 3001: { status: 429, headers: { "retry-after": "300" } } },
    };
    const first = await capture(s, 4, 0, "tok-quota");
    expect(first.result).toMatchObject({ state: "partial", reason: "rate_limited", httpStatus: 429, retryAfterSeconds: 300, fetchedEntries: 2000, failedRange: { start: 2001, end: 3000 } });
    const first429 = Math.min(...first.log.filter((l) => l.status === 429).map((l) => l.doneAt));
    expect(first.log.filter((l) => l.sentAt > first429)).toEqual([]);
    expect(first.log.map((l) => l.start).sort((a, b) => a - b)).toEqual([1, 1001, 2001, 3001]); // only what was already in flight

    // Same identity: the per-identity cooldown stops every request before the network.
    const again = await capture(s, 4, 0, "tok-quota");
    expect(again.result).toMatchObject({ reason: "rate_limited" });
    expect(again.calls).toEqual([]);
  });

  it("page-1 refusals and empty changelogs keep their serial meaning under concurrency", async () => {
    const forbidden = await capture({ entries: entries(5000), loadStatus: 403 }, 4);
    expect(forbidden.result).toMatchObject({ state: "blocked", reason: "changelog_forbidden_writer_role_required", pages: [] });
    const empty = await capture({ entries: entries(3000), loadStatus: 400 }, 4);
    expect(empty.result).toMatchObject({ state: "complete", reason: "empty_changelog", fetchedEntries: 0 });
  });

  it("open-ended pagination (no tile count) stays serial", async () => {
    const r = await capture({ entries: entries(3500), tilesTotal: null }, 8);
    expect(r.maxInFlight()).toBe(1);
    expect(r.result).toMatchObject({ state: "complete", fetchedEntries: 3500 });
  });

  it("paces a burst per credential (requests/second), independent of the concurrency bound", async () => {
    const r = await capture({ entries: entries(6000), latencyMs: 5 }, 8, 10);
    const starts = r.log.map((l) => l.sentAt).sort((a, b) => a - b);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(90); // 10 req/s => >= 100 ms apart (timer slack)
    expect(starts[starts.length - 1] - starts[0]).toBeGreaterThanOrEqual(450);
  });
});

describe("exportDocHistory: concurrent capture is restart-safe and output-identical", () => {
  const TITLE = "Roadmap";
  const P = docPaths(docDirectory(DOC, TITLE));
  const runExport = (tenantId: string, all: unknown[][], now: Date, pageConcurrency: number) => {
    const f = latencyFetch({ entries: all, latencyMs: 5 });
    return exportDocHistory({
      tenantId, docId: DOC, title: TITLE, mailbox: "ada@corp.example", authMode: "domain_wide_delegation", accessToken: `tok-${tenantId}`,
      fetchImpl: f.impl, now, deps, changelogFetch: { pageConcurrency, requestsPerSecond: 0 },
    }).then((result) => ({ result, f }));
  };

  it("first capture and resume produce the same files and request counts as a serial run", async () => {
    for (const t of ["tenant-serial", "tenant-parallel"]) await resetTenant(t);
    const first = entries(5500);
    const grown = entries(7600);
    const out: Record<string, { loads: number[]; maxInFlight: number; ops: string }> = {};
    for (const [tenant, conc] of [["tenant-serial", 1], ["tenant-parallel", 4]] as const) {
      const a = await runExport(tenant, first, new Date(T0 + 86_400_000), conc);
      expect(a.result.state).toBe("complete");
      const b = await runExport(tenant, grown, new Date(T0 + 2 * 86_400_000), conc);
      expect(b.result.state).toBe("complete");
      out[tenant] = {
        loads: [a.f.log.length, b.f.log.length],
        maxInFlight: Math.max(a.f.maxInFlight(), b.f.maxInFlight()),
        ops: (await liveFile(tenant, P.operations))!.bytes.toString("utf8"),
      };
    }
    expect(out["tenant-parallel"].ops).toBe(out["tenant-serial"].ops);
    expect(out["tenant-parallel"].loads).toEqual(out["tenant-serial"].loads);
    expect(out["tenant-serial"].loads).toEqual([6, 4]); // resume: re-verify page 5 + fetch pages 6..8
    expect(out["tenant-parallel"].maxInFlight).toBe(4);
  });
});

describe("fetchDocChangelog (donor path) uses the same bounded fail-closed pool", () => {
  const withFetch = async <T>(f: ReturnType<typeof latencyFetch>, fn: () => Promise<T>): Promise<T> => {
    vi.stubGlobal("fetch", f.impl);
    vi.stubEnv("GDOCS_CHANGELOG_PAGE_CONCURRENCY", "4");
    vi.stubEnv("GDOCS_CHANGELOG_MAX_RPS", "10"); // production pacing stays on: 100 ms between request starts
    try {
      return await fn();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  };

  it("fetches known-total pages concurrently (paced) and parses identically", async () => {
    const all = entries(5000);
    // A page takes longer than the 100 ms pacing interval, so several are in flight at once.
    const f = latencyFetch({ entries: all, latencyMs: 450 });
    const changelog = await withFetch(f, () => fetchDocChangelog("u", DOC, undefined, "tok-donor-1"));
    expect(f.maxInFlight()).toBe(4);
    expect(changelog).toEqual(parseChangelogEntries(DOC, all, collectSnapshotOps([[]]), changelog!.userMap));
  });

  it("returns null on a middle failure without dispatching past it, and rethrows rate limits", async () => {
    const failing = latencyFetch({ entries: entries(9000), latencyMs: 20, fail: { 3001: { status: 500 } } });
    expect(await withFetch(failing, () => fetchDocChangelog("u", DOC, undefined, "tok-donor-2"))).toBeNull();
    const failedAt = failing.log.find((l) => l.start === 3001)!.doneAt;
    expect(failing.log.filter((l) => l.sentAt > failedAt)).toEqual([]);
    expect(failing.log.map((l) => l.start).sort((a, b) => a - b)).toEqual([1, 1001, 2001, 3001]);

    const limited = latencyFetch({ entries: entries(9000), latencyMs: 20, fail: { 5001: { status: 429, headers: { "retry-after": "45" } } } });
    await expect(withFetch(limited, () => fetchDocChangelog("u", DOC, 9000, "tok-donor-3")))
      .rejects.toMatchObject({ name: "GoogleRateLimitError", retryAfterSeconds: 45 });
  });
});
