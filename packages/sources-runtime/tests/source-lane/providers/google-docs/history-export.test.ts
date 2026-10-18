import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { db, entry, fakeFetch, heads, liveFile, liveJson, query, ready, resetTenant, versionCount, xssi } from "./harness.js";
import { exportDocHistory } from "../../../../src/source-lane/providers/google-docs/history-export.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { getCheckpoint } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { collectSnapshotOps, parseChangelogEntries, fetchDocChangelog } from "../../../../src/polling/_archived-gdocs/gdocs-revisions-load.js";
import { replayChangelog } from "../../../../src/source-lane/providers/google-docs/sessions.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import type { SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";

const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-hist";
const DOC = "doc-hist-1";
const TITLE = "Quarterly Plan";
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const A = "user-ada";
const B = "user-bob";
const DIR = docDirectory(DOC, TITLE);
const P = docPaths(DIR);

/** Synthetic but structurally real changelog: nm/mlti nesting, two tabs, a suggestion, a delete, tab ops. */
function buildEntries(total: number): unknown[][] {
  const out: unknown[][] = [
    entry({ ty: "ac", d: ["t.second", [0, "Second"], [1]] }, T0, A, 1),
    entry({ ty: "nm", nmr: ["ksm", "t.0"], nmc: { ty: "is", ibi: 1, s: "Hello" } }, T0 + 1000, A, 2),
    entry({ ty: "mlti", mts: [
      { ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 6, s: " world" } },
      { ty: "nm", nmr: ["t.second"], nmc: { ty: "mlti", mts: [{ ty: "is", ibi: 1, s: "Tab2" }, { ty: "as", si: 1, ei: 4, st: "text", sm: { ts_bd: true } }] } },
    ] }, T0 + 2000, A, 3),
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "iss", ibi: 12, s: "!", sugid: "suggest.abc" } }, T0 + 10_000, B, 4, "s-bob"),
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "ds", si: 1, ei: 5 } }, T0 + 20_000, A, 5),
    entry({ ty: "mkch", d: [[1, "Renamed"]] }, T0 + 21_000, A, 6),
  ];
  // Filler: a second Ada session 10 minutes later (single-char inserts, 1s apart).
  let ms = T0 + 10 * 60_000;
  while (out.length < total) {
    out.push(entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: "x" } }, ms, A, out.length + 1));
    ms += 1000;
  }
  return out;
}

interface Scenario {
  entries: unknown[][];
  tilesTotal?: number | null;
  failRange?: { start: number; status: number; headers?: Record<string, string> };
  loadStatus?: number;
}

function changelogRoutes(s: Scenario) {
  return fakeFetch([
    (url) => {
      if (!url.pathname.endsWith("/revisions/tiles")) return undefined;
      const total = s.tilesTotal === undefined ? s.entries.length : s.tilesTotal;
      if (total === null) return new Response("", { status: 500 });
      return xssi({ tileInfo: [{ start: 1, end: total, endMillis: T0 + 3_600_000, users: [A, B] }], userMap: { [A]: { name: "Ada", anonymous: false }, [B]: { name: "Bob", anonymous: false } } });
    },
    (url) => {
      if (!url.pathname.endsWith("/revisions/load")) return undefined;
      if (s.loadStatus) return new Response("", { status: s.loadStatus });
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      if (s.failRange && start === s.failRange.start) {
        return new Response(JSON.stringify({ error: { message: "x" } }), { status: s.failRange.status, headers: s.failRange.headers });
      }
      return xssi({ changelog: s.entries.slice(start - 1, end), ...(start === 1 ? { chunkedSnapshot: [[]] } : {}) });
    },
  ]);
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  resetGoogleRateLimitCooldownsForTests();
  await resetTenant(TENANT);
  await resetTenant("tenant-other");
});

const run = (s: Scenario, now: Date, tenantId = TENANT) => {
  const f = changelogRoutes(s);
  return {
    calls: f.calls,
    result: exportDocHistory({ tenantId, docId: DOC, title: TITLE, mailbox: "ada@corp.example", authMode: "domain_wide_delegation", accessToken: "tok", fetchImpl: f.impl, now, deps }),
  };
};

describe("exportDocHistory - complete changelog", () => {
  it("stores raw pages, parsed ops, sessions with exact before/after, suggestions and tabs from the production parser", async () => {
    const entries = buildEntries(1500);
    const now = new Date(T0 + 24 * 3_600_000);
    const { result, calls } = run({ entries }, now);
    const r = await result;

    expect(r.state).toBe("complete");
    expect(r.totalEntries).toBe(1500);
    expect(calls.map((c) => new URL(c.url).pathname.split("/").pop())).toEqual(["tiles", "load", "load"]);
    // The private endpoint is not a googleapis quota surface: no quotaUser there.
    expect(calls.every((c) => !c.headers.has("x-goog-quota-user"))).toBe(true);

    // Raw pages: the exact tuples, page-aligned.
    const page1 = await liveJson<{ start: number; end: number; response: { changelog: unknown[][]; chunkedSnapshot: unknown } }>(TENANT, P.changelogPage(1, 1000));
    const page2 = await liveJson<{ start: number; end: number; response: { changelog: unknown[][] } }>(TENANT, P.changelogPage(1001, 1500));
    expect(page1.response.changelog).toEqual(entries.slice(0, 1000));
    expect(page1.response.chunkedSnapshot).toEqual([[]]);
    expect(page2.response.changelog).toEqual(entries.slice(1000));

    // operations.jsonl is exactly the production parser + true-order replay.
    const expected = replayChangelog(parseChangelogEntries(DOC, entries, collectSnapshotOps([[]]), new Map([[A, { name: "Ada", anonymous: false }], [B, { name: "Bob", anonymous: false }]])));
    const opsFile = await liveFile(TENANT, P.operations);
    const ops = opsFile!.bytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(ops).toEqual(JSON.parse(JSON.stringify(expected)));
    // nested mlti -> nm -> mlti flattening kept per-sub-op tab ids
    expect(ops.filter((o) => o.changelogIndex === 3).map((o) => [o.type, o.tabId])).toEqual([
      ["insert", "t.0"], ["insert", "t.second"], ["format", "t.second"],
    ]);
    expect(ops.find((o) => o.changelogIndex === 5)).toMatchObject({ type: "delete", deletedText: "Hello", tabId: "t.0" });

    // Sessions: Ada's first session (entries 1-6, Bob's suggestion interleaved), Bob's, Ada's filler session.
    const sessionHeads = await heads(TENANT, `${P.sessionsDir}/`);
    expect(sessionHeads.filter((h) => h.op === "put")).toHaveLength(3);
    const sessions = await Promise.all(sessionHeads.map((h) => liveJson<Record<string, any>>(TENANT, h.path)));
    const adaFirst = sessions.find((s) => s.actor.userId === A && s.startEntry === 1)!;
    expect(adaFirst.actor.name).toBe("Ada");
    expect(adaFirst.interleavedEntries).toEqual([4]);
    expect(adaFirst.grouping).toContain("5-minute");
    const adaTab0 = adaFirst.tabs.find((t: any) => t.tabId === "t.0");
    const before = await liveFile(TENANT, P.state(adaTab0.before.sha256));
    const after = await liveFile(TENANT, P.state(adaTab0.after.sha256));
    expect(before!.bytes.toString("utf8")).toBe("");
    expect(after!.bytes.toString("utf8")).toBe(" world!");
    expect(adaFirst.donorAggregate.tabActivity.length).toBeGreaterThan(0);
    expect(adaFirst.donorAggregate).not.toHaveProperty("tabActivity.0.fullContent");

    const bob = sessions.find((s) => s.actor.userId === B)!;
    const bobTab = bob.tabs[0];
    expect((await liveFile(TENANT, P.state(bobTab.before.sha256)))!.bytes.toString("utf8")).toBe("Hello world");
    expect((await liveFile(TENANT, P.state(bobTab.after.sha256)))!.bytes.toString("utf8")).toBe("Hello world!");
    expect(bob.ops[0]).toMatchObject({ type: "insert_suggestion", sugId: "suggest.abc", insertedText: "!" });

    const suggestions = await liveJson<{ suggestions: Array<{ sugId: string; status: string }> }>(TENANT, P.suggestions);
    expect(suggestions.suggestions.map((s) => s.sugId)).toContain("suggest.abc");
    const tabs = await liveJson<{ events: Array<{ eventType: string; tabId: string; actorName: string }> }>(TENANT, P.tabs);
    expect(tabs.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "created", tabId: "t.second", actorName: "Ada" })]));

    const status = await liveJson<Record<string, unknown>>(TENANT, P.changelogStatus);
    expect(status).toMatchObject({ state: "complete", totalEntries: 1500, sessions: 3, pendingSessionOps: 0, authMode: "domain_wide_delegation" });

    const cp = await getCheckpoint(TENANT, DOC, deps);
    expect(cp).toMatchObject({ historyState: "complete", historyCompleteEntries: 1500 });

    // Every version row is journaled for the exporter in the writer's transaction.
    const journal = await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_lane_journal WHERE tenant_id = $1 AND table_name = 'gdocs_source_file_versions'`, [TENANT]);
    expect(journal[0].n).toBe(await versionCount(TENANT));
  });

  it("repeat polls are idempotent: only the status file gets a new version", async () => {
    const entries = buildEntries(1200);
    await (run({ entries }, new Date(T0 + 86_400_000))).result;
    const before = await versionCount(TENANT);
    const statusBefore = await versionCount(TENANT, P.changelogStatus);
    await (run({ entries }, new Date(T0 + 86_400_000 + 60_000))).result;
    expect(await versionCount(TENANT)).toBe(before + 1);
    expect(await versionCount(TENANT, P.changelogStatus)).toBe(statusBefore + 1);
  });

  it("an out-of-order (older) run cannot overwrite newer derived history", async () => {
    await (run({ entries: buildEntries(1200) }, new Date(T0 + 2 * 86_400_000))).result;
    const opsBefore = await liveFile(TENANT, P.operations);
    // An older capture of a shorter changelog finishing late.
    await (run({ entries: buildEntries(1100) }, new Date(T0 + 86_400_000))).result;
    const opsAfter = await liveFile(TENANT, P.operations);
    expect(opsAfter!.seq).toBe(opsBefore!.seq);
    expect(opsAfter!.bytes.equals(opsBefore!.bytes)).toBe(true);
  });
});

describe("exportDocHistory - fail closed", () => {
  it("a late partial changelog keeps the last complete cursor, stores the raw prefix, and reports partial", async () => {
    await (run({ entries: buildEntries(1500) }, new Date(T0 + 86_400_000))).result;
    const opsBefore = await liveFile(TENANT, P.operations);
    const sessionsBefore = await heads(TENANT, `${P.sessionsDir}/`);

    const grown = buildEntries(2600);
    const now = new Date(T0 + 2 * 86_400_000);
    const r = await (run({ entries: grown, failRange: { start: 2001, status: 500 } }, now)).result;

    expect(r.state).toBe("partial");
    expect(r.reason).toBe("load_http_500");
    const cp = await getCheckpoint(TENANT, DOC, deps);
    expect(cp!.historyState).toBe("partial");
    expect(cp!.historyCompleteEntries).toBe(1500); // cursor NOT advanced
    expect(cp!.historyFetchedEntries).toBe(2000);
    expect(Date.parse(cp!.historyRetryAt!)).toBeGreaterThan(now.getTime());

    // Derived history untouched (still the 1500-entry complete capture).
    const opsAfter = await liveFile(TENANT, P.operations);
    expect(opsAfter!.seq).toBe(opsBefore!.seq);
    expect(await heads(TENANT, `${P.sessionsDir}/`)).toEqual(sessionsBefore);
    // The newly fetched raw page is preserved.
    const page2 = await liveJson<{ response: { changelog: unknown[][] } }>(TENANT, P.changelogPage(1001, 2000));
    expect(page2.response.changelog).toEqual(grown.slice(1000, 2000));

    const status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status).toMatchObject({ state: "partial", reason: "load_http_500", fetchedEntries: 2000, tilesTotal: 2600, failedRange: { start: 2001, end: 2600 } });
    expect(status.lastComplete).toMatchObject({ entries: 1500 });
    expect(status.note).toMatch(/must not be read as full history/);
  });

  it("honours Retry-After on a rate-limited page and keys the cooldown per identity", async () => {
    const now = new Date(T0 + 86_400_000);
    const r = await (run({ entries: buildEntries(1500), failRange: { start: 1001, status: 429, headers: { "retry-after": "900" } } }, now)).result;
    expect(r.state).toBe("partial");
    expect(r.reason).toBe("rate_limited");
    const cp = await getCheckpoint(TENANT, DOC, deps);
    expect(Date.parse(cp!.historyRetryAt!) - now.getTime()).toBeGreaterThanOrEqual(900_000);

    // Another tenant's identity is not in this cooldown.
    const other = await (run({ entries: buildEntries(1200) }, now, "tenant-other")).result;
    expect(other.state).toBe("complete");
    // ...but the same identity is, without touching the network.
    const again = run({ entries: buildEntries(1500) }, now);
    const r2 = await again.result;
    expect(r2.reason).toBe("rate_limited");
    expect(again.calls).toHaveLength(0);
  });

  it("reports blocked (writer+ gate) when the first page is forbidden", async () => {
    const r = await (run({ entries: buildEntries(10), loadStatus: 403 }, new Date(T0 + 86_400_000))).result;
    expect(r.state).toBe("blocked");
    expect(r.reason).toBe("changelog_forbidden_writer_role_required");
    expect((await getCheckpoint(TENANT, DOC, deps))!.historyCompleteEntries).toBe(0);
    expect(await heads(TENANT, P.operations)).toEqual([]);
  });

  it("never calls the private endpoint for a Composio-proxied connection (ot_requires_bearer)", async () => {
    const f = changelogRoutes({ entries: buildEntries(10) });
    const r = await exportDocHistory({ tenantId: TENANT, docId: DOC, title: TITLE, authMode: "composio_proxy", fetchImpl: f.impl, now: new Date(), deps });
    expect(r).toMatchObject({ state: "blocked", reason: "ot_requires_bearer" });
    expect(f.calls).toHaveLength(0);
    expect(await liveJson(TENANT, P.changelogStatus)).toMatchObject({ state: "blocked", reason: "ot_requires_bearer", authMode: "composio_proxy" });
  });

  it("resumes from durable pages: re-verifies the newest stored full page and fetches only the tail", async () => {
    await (run({ entries: buildEntries(2500) }, new Date(T0 + 86_400_000))).result;
    const second = run({ entries: buildEntries(2700) }, new Date(T0 + 2 * 86_400_000));
    const r = await second.result;
    expect(r.state).toBe("complete");
    const ranges = second.calls.filter((c) => c.url.includes("/revisions/load")).map((c) => new URL(c.url).searchParams.get("start"));
    expect(ranges).toEqual(["1001", "2001"]); // page 1 reused, page 2 re-verified, tail refetched
    expect(r.totalEntries).toBe(2700);
  });

  it("discards stored pages and refetches from entry 1 when Google's history no longer matches", async () => {
    await (run({ entries: buildEntries(2500) }, new Date(T0 + 86_400_000))).result;
    const rewritten = buildEntries(2500).map((e, i) => (i === 1500 ? entry({ ty: "is", ibi: 1, s: "Z" }, T0, A, 1501) : e));
    const third = run({ entries: rewritten }, new Date(T0 + 2 * 86_400_000));
    const r = await third.result;
    expect(r.state).toBe("complete");
    const ranges = third.calls.filter((c) => c.url.includes("/revisions/load")).map((c) => new URL(c.url).searchParams.get("start"));
    expect(ranges).toEqual(["1001", "1", "1001", "2001"]);
    const page2 = await liveJson<{ response: { changelog: unknown[][] } }>(TENANT, P.changelogPage(1001, 2000));
    expect(page2.response.changelog[500]).toEqual(rewritten[1500]);
  });
});

describe("fetchDocChangelog (patched donor) is fail-closed", () => {
  it("returns null instead of a prefix when a later page fails", async () => {
    const entries = buildEntries(1500);
    const f = changelogRoutes({ entries, failRange: { start: 1001, status: 500 } });
    vi.stubGlobal("fetch", f.impl);
    try {
      expect(await fetchDocChangelog("u", DOC, undefined, "tok")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rethrows Google rate limits so callers honour Retry-After", async () => {
    const f = changelogRoutes({ entries: buildEntries(1500), failRange: { start: 1, status: 429, headers: { "retry-after": "30" } } });
    vi.stubGlobal("fetch", f.impl);
    try {
      await expect(fetchDocChangelog("u", DOC, 1500, "tok")).rejects.toMatchObject({ name: "GoogleRateLimitError", retryAfterSeconds: 30 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null on a short page against the tile count", async () => {
    const entries = buildEntries(1500);
    const f = changelogRoutes({ entries: entries.slice(0, 1400), tilesTotal: 1500 });
    vi.stubGlobal("fetch", f.impl);
    try {
      expect(await fetchDocChangelog("u", DOC, undefined, "tok")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses identically to the exported pure parser on a complete changelog", async () => {
    const entries = buildEntries(1200);
    const f = changelogRoutes({ entries });
    vi.stubGlobal("fetch", f.impl);
    try {
      const fetched = await fetchDocChangelog("u", DOC, undefined, "tok");
      const parsed = parseChangelogEntries(DOC, entries, collectSnapshotOps([[]]), fetched!.userMap);
      expect(fetched).toEqual(parsed);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
