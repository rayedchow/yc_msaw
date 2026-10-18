/**
 * Google Docs fidelity fixes F1/F2/F5/F6 (independent review, 2026-10-18), through the production
 * `exportDocHistory` entrypoint with synthetic changelogs only.
 *
 * F1: a pasted credentialed URL used to be stored (and replayed) as a fixed 39-char placeholder, shifting every
 *     later OT index. Pages are now redacted length-preserving: derived history must have the exact unredacted
 *     positions and lengths, and no credential may be stored anywhere.
 * F2: stored-page reuse compared an unredacted live page with a redacted stored one and refetched the whole
 *     changelog on every run. Both sides now use the stored representation.
 * F5/F6: honest blocked notes (Composio has no content/snapshot diffs either; 401 vs 403 under OAuth).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { allStoredText, db, entry, fakeFetch, heads, liveFile, liveJson, ready, resetTenant, xssi } from "./harness.js";
import { exportDocHistory } from "../../../../src/source-lane/providers/google-docs/history-export.js";
import { docDirectory, docPaths } from "../../../../src/source-lane/providers/google-docs/paths.js";
import { getCheckpoint } from "../../../../src/source-lane/providers/google-docs/checkpoints.js";
import { jsonBytes, putSourceFile, type SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";
import { buildSessionDiffEvents, replayChangelog } from "../../../../src/source-lane/providers/google-docs/sessions.js";
import { collectSnapshotOps, parseChangelogEntries, replayWithDiffs } from "../../../../src/polling/_archived-gdocs/gdocs-revisions-load.js";
import { trackSuggestions } from "../../../../src/polling/_archived-gdocs/gdocs-suggestion-tracker.js";
import { redactProviderPayload } from "../../../../src/vault/redaction.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import { resetChangelogPacingForTests } from "../../../../src/source-lane/providers/google-docs/changelog-page-pool.js";

const deps = { db: db as unknown as SqlDatabase };
const TENANT = "tenant-redaction-fidelity";
const DOC = "doc-redaction-1";
const TITLE = "Launch Notes";
const DIR = docDirectory(DOC, TITLE);
const P = docPaths(DIR);
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 86_400_000;
const A = "user-ada";
const B = "user-bob";
const SECRETS = ["abc123", "s3cr3t-sig", "sn4p-jwt", "sug-tok-9"];

const URL_PASTE = "https://files.example.com/share?token=abc123"; // reviewer's pasted link
const URL_NESTED = "https://cdn.example.net/a/b.png?X-Goog-Signature=s3cr3t-sig&X-Goog-Expires=600";
const URL_SNAPSHOT = "https://dl.example.org/f?jwt=sn4p-jwt";
const URL_SUGGEST = "http://s.example/x?sig=sug-tok-9";

const userMap = { [A]: { name: "Ada", anonymous: false }, [B]: { name: "Bob", anonymous: false } };

/** The reviewer's four ops: insert "See: ", paste the link, type " (expires Friday)", delete exactly the link. */
function reviewerEntries(): unknown[][] {
  return [
    entry({ ty: "is", ibi: 1, s: "See: " }, T0, A, 1),
    entry({ ty: "is", ibi: 6, s: URL_PASTE }, T0 + 1000, A, 2),
    entry({ ty: "is", ibi: 6 + URL_PASTE.length, s: " (expires Friday)" }, T0 + 2000, A, 3),
    entry({ ty: "ds", si: 6, ei: 5 + URL_PASTE.length }, T0 + 3000, A, 4),
  ];
}

/** Nested ops, a snapshot-borne URL, a suggestion carrying a URL and a delete that cuts into a redacted span. */
function nestedEntries(): { entries: unknown[][]; chunkedSnapshot: unknown } {
  // Snapshot (state before entry 1): "Doc: <URL_SNAPSHOT>\n"
  const chunkedSnapshot = [[
    { ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: "Doc: " } },
    { ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 6, s: `${URL_SNAPSHOT}\n` } },
  ]];
  const base = 5 + URL_SNAPSHOT.length + 1; // length of the snapshot text
  const entries: unknown[][] = [
    // mlti > nm > is with a signed URL (whole string, with a leading space kept as structure)
    entry({ ty: "mlti", mts: [
      { ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: base + 1, s: ` ${URL_NESTED}` } },
      { ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: base + 2 + URL_NESTED.length, s: " shared by Ada." } },
    ] }, T0, A, 1),
    // Bob suggests a link (suggestion insert carrying a credentialed URL)
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "iss", ibi: 1, s: URL_SUGGEST, sugid: "suggest.link" } }, T0 + 30_000, B, 2, "s-bob"),
    // Ada deletes the tail of the nested URL plus " shared" (cuts into the redacted span)
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "ds", si: URL_SUGGEST.length + base + 1 + URL_NESTED.length - 9, ei: URL_SUGGEST.length + base + 1 + URL_NESTED.length + 7 } }, T0 + 60_000, A, 3),
    // and keeps typing after it: positions after the redacted spans must be exact
    entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: URL_SUGGEST.length + base + 1 + URL_NESTED.length - 9, s: " [link removed]" } }, T0 + 61_000, A, 4),
  ];
  return { entries, chunkedSnapshot };
}

function filler(from: number, total: number): unknown[][] {
  const out: unknown[][] = [];
  let ms = T0 + 20 * 60_000;
  for (let i = from; i <= total; i++) {
    out.push(entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: "x" } }, ms, A, i));
    ms += 1000;
  }
  return out;
}

function routes(entries: unknown[][], opts: { chunkedSnapshot?: unknown; loadStatus?: number; failStart?: number } = {}) {
  return fakeFetch([
    (url) => url.pathname.endsWith("/revisions/tiles")
      ? xssi({ tileInfo: [{ start: 1, end: entries.length, endMillis: T0 + 3_600_000, users: [A, B] }], userMap })
      : undefined,
    (url) => {
      if (!url.pathname.endsWith("/revisions/load")) return undefined;
      if (opts.loadStatus) return new Response("", { status: opts.loadStatus });
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      if (opts.failStart === start) return new Response("{}", { status: 500 });
      return xssi({ changelog: entries.slice(start - 1, end), ...(start === 1 ? { chunkedSnapshot: opts.chunkedSnapshot ?? [[]] } : {}) });
    },
  ]);
}

function run(entries: unknown[][], now: Date, opts: Parameters<typeof routes>[1] & { authMode?: "domain_wide_delegation" | "oauth_direct" } = {}) {
  const f = routes(entries, opts);
  return {
    calls: f.calls,
    result: exportDocHistory({
      tenantId: TENANT, docId: DOC, title: TITLE, mailbox: "ada@corp.example", authMode: opts.authMode ?? "domain_wide_delegation",
      accessToken: "tok-redaction", fetchImpl: f.impl, now, deps, changelogFetch: { requestsPerSecond: 0 },
    }),
  };
}

const loadStarts = (calls: Array<{ url: string }>) =>
  calls.filter((c) => c.url.includes("/revisions/load")).map((c) => Number(new URL(c.url).searchParams.get("start")));

/** Walk raw vs stored values in parallel; every differing string must be a same-length placeholder. */
function substitutions(raw: unknown, stored: unknown, out = new Map<string, string>()): Map<string, string> {
  if (typeof raw === "string") {
    expect(typeof stored).toBe("string");
    if (raw !== stored) {
      const s = stored as string;
      expect(s.length).toBe(raw.length); // UTF-16 length preserved
      expect(s.trim()).toMatch(/^\[redacted/);
      expect(s).not.toMatch(/https?:|token|sig|jwt/i);
      expect(s.match(/^\s*/)![0]).toBe(raw.match(/^\s*/)![0]); // structural whitespace kept
      out.set(raw, s);
    }
  } else if (Array.isArray(raw)) {
    raw.forEach((v, i) => substitutions(v, (stored as unknown[])[i], out));
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) substitutions(v, (stored as Record<string, unknown>)[k], out);
  }
  return out;
}

function substitute<T>(value: T, map: Map<string, string>): T {
  if (typeof value === "string") return (map.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => substitute(v, map)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, map)])) as T;
  return value;
}

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function exportedOps(): Promise<Array<Record<string, unknown>>> {
  const file = await liveFile(TENANT, P.operations);
  return file!.bytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
}

async function exportedSessions(): Promise<Array<Record<string, any>>> {
  const out = [];
  for (const h of await heads(TENANT, `${P.sessionsDir}/`)) if (h.op === "put") out.push(await liveJson<Record<string, any>>(TENANT, h.path));
  return out.sort((a, b) => a.startEntry - b.startEntry);
}

async function stateText(sha: string): Promise<string> {
  return (await liveFile(TENANT, P.state(sha)))!.bytes.toString("utf8");
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  resetGoogleRateLimitCooldownsForTests();
  resetChangelogPacingForTests();
  await resetTenant(TENANT);
});

describe("F1: credential redaction keeps OT positions exact", () => {
  it("reviewer repro: deleting a pasted signed link leaves exactly the surrounding text, with the link's true length", async () => {
    const entries = reviewerEntries();
    const r = await run(entries, new Date(T0 + DAY)).result;
    expect(r.state).toBe("complete");

    const ops = await exportedOps();
    expect(ops[1].insertedText).toHaveLength(URL_PASTE.length);
    expect(ops[3].deletedText).toHaveLength(URL_PASTE.length);
    expect(ops[3].deletedText).toBe(ops[1].insertedText); // the delete removed exactly the pasted span
    expect(ops[2].insertedText).toBe(" (expires Friday)");

    const [session] = await exportedSessions();
    const tab = session.tabs[0];
    expect(await stateText(tab.after.sha256)).toBe("See:  (expires Friday)"); // was "See: res Friday)" before the fix
    expect(tab.before.length).toBe(0);

    // Positions are identical to an unredacted replay.
    const unredacted = replayChangelog(parseChangelogEntries(DOC, entries, [], new Map()));
    expect(ops.map((o) => [o.type, o.startIndex, o.endIndex, (o.insertedText as string | undefined)?.length, (o.deletedText as string | undefined)?.length]))
      .toEqual(unredacted.map((o) => [o.type, o.startIndex, o.endIndex, o.insertedText?.length, o.deletedText?.length]));

    const stored = await allStoredText(TENANT);
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
    expect(stored).not.toContain("files.example.com");
  });

  it("nested ops, snapshot text, suggestions and revision chunks equal the production replay of the same-length-redacted input", async () => {
    const { entries, chunkedSnapshot } = nestedEntries();
    const all = [...entries, ...filler(entries.length + 1, 1500)]; // two pages: the redacted strings are on page 1
    const r = await run(all, new Date(T0 + DAY), { chunkedSnapshot }).result;
    expect(r.state).toBe("complete");

    // Stored raw page 1: every credential string became a same-length placeholder, nothing else changed.
    const page1 = await liveJson<{ redaction: string; response: { changelog: unknown[][]; chunkedSnapshot: unknown } }>(TENANT, P.changelogPage(1, 1000));
    expect(page1.redaction).toBe("google-docs/length-preserving-v1");
    const map = substitutions({ changelog: all.slice(0, 1000), chunkedSnapshot }, page1.response);
    expect([...map.keys()].sort()).toEqual([URL_SUGGEST, `${URL_SNAPSHOT}\n`, ` ${URL_NESTED}`].sort());

    // Reference = production parser/replay over the input with the same substitutions (no export involved).
    const refEntries = substitute(all, map);
    const refSnapshot = substitute(chunkedSnapshot, map);
    const tiles = [{ start: 1, end: all.length, endMillis: T0 + 3_600_000, users: [A, B] }];
    const refMap = new Map(Object.entries(userMap).map(([id, u]) => [id, { name: u.name, photo: undefined, anonymous: u.anonymous }]));
    const refChangelog = parseChangelogEntries(DOC, refEntries, collectSnapshotOps(refSnapshot), refMap);
    const now = new Date(T0 + DAY);

    expect(await exportedOps()).toEqual(roundTrip(replayChangelog(refChangelog)));
    const chunks = await liveJson<{ chunks: unknown[] }>(TENANT, P.revisionChunks);
    expect(chunks.chunks).toEqual(roundTrip(replayWithDiffs(refChangelog.operations, tiles, refChangelog.userMap)));
    const suggestions = await liveJson<Record<string, unknown>>(TENANT, P.suggestions);
    expect(suggestions).toMatchObject(roundTrip(trackSuggestions(refChangelog)) as unknown as Record<string, unknown>);
    const refSessions = buildSessionDiffEvents(refChangelog, now);
    const sessions = await exportedSessions();
    expect(sessions).toEqual(roundTrip(refSessions.sessions).sort((a, b) => a.startEntry - b.startEntry));

    // ...and that reference has the UNREDACTED positions and text lengths everywhere.
    const rawChangelog = parseChangelogEntries(DOC, all, collectSnapshotOps(chunkedSnapshot), refMap);
    const shape = (ops: ReturnType<typeof replayChangelog>) =>
      ops.map((o) => [o.changelogIndex, o.type, o.startIndex, o.endIndex, o.insertedText?.length ?? null, o.deletedText?.length ?? null]);
    expect(shape(replayChangelog(refChangelog))).toEqual(shape(replayChangelog(rawChangelog)));
    const rawSessions = buildSessionDiffEvents(rawChangelog, now);
    expect(sessions.map((s) => s.tabs.map((t: any) => [t.before.length, t.after.length])))
      .toEqual(rawSessions.sessions.map((s) => s.tabs.map((t) => [t.before.length, t.after.length])));
    // Text outside the redacted spans is exact: Ada's typing after the cut lands where it did unredacted.
    const deleteOp = (await exportedOps()).find((o) => o.changelogIndex === 3 && o.type === "delete")!;
    expect(deleteOp.deletedText as string).toMatch(/_{0,}\] shared$/);
    expect((deleteOp.deletedText as string).length).toBe(17); // 10 redacted URL chars + " shared"
    const lastSession = sessions.find((s) => s.actor.userId === A && s.startEntry === 1)!;
    expect(await stateText(lastSession.tabs[0].after.sha256)).toMatch(/ \[link removed\] by Ada\.$/);

    const stored = await allStoredText(TENANT);
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
  });
});

describe("F1 + F2: resumed captures replay stored pages faithfully without refetching", () => {
  it("reuses a stored page that contains a redacted credential (2 load calls, not N+1) and keeps exact text", async () => {
    // The paste is on page 2, the newest reusable full page (reviewer's reuse-digest scenario).
    const grow = (total: number) => {
      const out = filler(1, total);
      out[1499] = entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: URL_PASTE } }, T0 + 30 * 60_000, A, 1500);
      out[1500] = entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "ds", si: 1, ei: URL_PASTE.length } }, T0 + 30 * 60_000 + 1000, A, 1501);
      return out;
    };
    await run(grow(2500), new Date(T0 + DAY)).result;
    const opsFirst = await exportedOps();

    const second = run(grow(2700), new Date(T0 + 2 * DAY));
    const r = await second.result;
    expect(r.state).toBe("complete");
    expect(loadStarts(second.calls)).toEqual([1001, 2001]); // page 1 reused, page 2 re-verified equal, tail fetched
    const status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status).toMatchObject({ reusedPages: 1, fetchedPages: 2, fetchStats: { requests: 3 } });

    // Replay of the resumed (stored) pages is identical to the first run's for the shared prefix...
    const ops = await exportedOps();
    expect(ops.slice(0, 2500)).toEqual(opsFirst);
    // ...and the delete removed exactly the pasted span (same length, same placeholder).
    expect(ops[1500].deletedText).toBe(ops[1499].insertedText);
    expect(ops[1500].deletedText).toHaveLength(URL_PASTE.length);
    expect(await allStoredText(TENANT)).not.toContain("abc123");
  });

  const legacyEntries = () => {
    const entries = filler(1, 2500);
    entries[1199] = entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "is", ibi: 1, s: URL_PASTE } }, T0 + 25 * 60_000, A, 1200);
    entries[1200] = entry({ ty: "nm", nmr: ["t.0"], nmc: { ty: "ds", si: 1, ei: URL_PASTE.length } }, T0 + 25 * 60_000 + 1000, A, 1201);
    return entries;
  };
  /** Overwrite page 2 with what the pre-fix exporter stored: shared fixed-length redaction, no `redaction` marker. */
  const storeLegacyPage2 = async (entries: unknown[][]) => {
    const legacyResponse = redactProviderPayload("google-docs", { changelog: entries.slice(1000, 2000) }) as Record<string, unknown>;
    await putSourceFile({
      tenantId: TENANT, fileId: DOC, path: P.changelogPage(1001, 2000), kind: "raw", contentType: "application/json",
      bytes: jsonBytes({ schema: "procmem.gdocs.changelog-page/v1", docId: DOC, start: 1001, end: 2000, entryCount: 1000, response: legacyResponse }),
      sourceOrder: T0 + DAY + 1, capturedAt: new Date(T0 + DAY + 1),
    }, deps);
  };
  const expectExactPaste = async () => {
    const ops = await exportedOps();
    expect(ops[1200].deletedText).toHaveLength(URL_PASTE.length);
    expect(ops[1200].deletedText).toBe(ops[1199].insertedText);
    expect(await allStoredText(TENANT)).not.toContain("abc123");
  };

  it("never reuses a legacy fixed-length-redacted page: refetches from it and repairs the derived history", async () => {
    const entries = legacyEntries();
    await run(entries, new Date(T0 + DAY)).result;
    await storeLegacyPage2(entries);

    const repair = run(entries, new Date(T0 + 2 * DAY));
    const r = await repair.result;
    expect(r.state).toBe("complete");
    expect(loadStarts(repair.calls)).toEqual([1, 1001, 2001]); // only clean page 1 offered (and re-verified); page 2 refetched
    const status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status.legacyRedactionRepaired).toEqual({ pages: [{ start: 1001, end: 2000 }] });
    expect(status.legacyRedaction).toBeUndefined();
    const page2 = await liveJson<{ redaction: string }>(TENANT, P.changelogPage(1001, 2000));
    expect(page2.redaction).toBe("google-docs/length-preserving-v1");
    await expectExactPaste();
  });

  it("keeps warning that lastComplete history is legacy-derived across partial recaptures until one completes", async () => {
    const entries = legacyEntries();
    await run(entries, new Date(T0 + DAY)).result;
    await storeLegacyPage2(entries);

    // Partial: page 2 is refetched (stored in the new representation) but derived history is still the old one.
    const first = run(entries, new Date(T0 + 2 * DAY), { failStart: 2001 });
    expect((await first.result).state).toBe("partial");
    expect(loadStarts(first.calls)).toEqual([1, 1001, 2001]);
    let status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status.legacyRedaction).toMatchObject({ pages: [{ start: 1001, end: 2000 }] });
    expect(status.legacyRedaction.note).toMatch(/may be shifted until a complete recapture/);

    // Partial again: no stored page is legacy any more, the warning is carried from the previous status.
    const second = run(entries, new Date(T0 + 3 * DAY), { failStart: 2001 });
    expect((await second.result).state).toBe("partial");
    expect(loadStarts(second.calls)).toEqual([1001, 2001]);
    status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status.legacyRedaction).toMatchObject({ pages: [{ start: 1001, end: 2000 }] });

    const done = await run(entries, new Date(T0 + 4 * DAY)).result;
    expect(done.state).toBe("complete");
    status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status.legacyRedactionRepaired).toEqual({ pages: [{ start: 1001, end: 2000 }] });
    expect(status.legacyRedaction).toBeUndefined();
    await expectExactPaste();

    // Once repaired, later runs say nothing about legacy pages.
    await run(entries, new Date(T0 + 5 * DAY)).result;
    status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status.legacyRedactionRepaired).toBeUndefined();
  });
});

describe("F5/F6: capability and refusal wording", () => {
  it("401 is a credential failure, not a role gate", async () => {
    const r = await run(reviewerEntries(), new Date(T0 + DAY), { loadStatus: 401, authMode: "oauth_direct" }).result;
    expect(r).toMatchObject({ state: "blocked", reason: "changelog_unauthorized" });
    const status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status.note).toMatch(/rejected the credential \(401\)/);
    expect(status.note).not.toMatch(/writer\+ role on the document is required/);
  });

  it("403 under direct OAuth is reported as role OR OAuth acceptance, never as verified OAuth support", async () => {
    const r = await run(reviewerEntries(), new Date(T0 + DAY), { loadStatus: 403, authMode: "oauth_direct" }).result;
    expect(r).toMatchObject({ state: "blocked", reason: "changelog_forbidden_writer_role_or_oauth_unsupported" });
    expect((await liveJson<Record<string, any>>(TENANT, P.changelogStatus)).note).toMatch(/unverified for this deployment/);
    expect((await getCheckpoint(TENANT, DOC, deps))!.historyCompleteEntries).toBe(0);
  });

  it("403 under domain-wide delegation stays the writer+ gate", async () => {
    const r = await run(reviewerEntries(), new Date(T0 + DAY), { loadStatus: 403 }).result;
    expect(r).toMatchObject({ state: "blocked", reason: "changelog_forbidden_writer_role_required" });
  });

  it("a refusal on the reuse check uses the same honest reasons", async () => {
    await run(filler(1, 1500), new Date(T0 + DAY)).result;
    const r = await run(filler(1, 1500), new Date(T0 + 2 * DAY), { loadStatus: 401, authMode: "oauth_direct" }).result;
    expect(r).toMatchObject({ state: "blocked", reason: "changelog_unauthorized" });
  });

  it("Composio: no changelog call, and the status does not claim content or snapshot diffs", async () => {
    const f = routes(reviewerEntries());
    const r = await exportDocHistory({ tenantId: TENANT, docId: DOC, title: TITLE, authMode: "composio_proxy", fetchImpl: f.impl, now: new Date(T0), deps });
    expect(r).toMatchObject({ state: "blocked", reason: "ot_requires_bearer" });
    expect(f.calls).toHaveLength(0);
    const status = await liveJson<Record<string, any>>(TENANT, P.changelogStatus);
    expect(status.contentReason).toBe("docs_content_requires_bearer");
    expect(status.note).toMatch(/snapshot diffs \(documents\.get\) are not captured/);
    expect(status.note).not.toMatch(/still are/);
  });
});
