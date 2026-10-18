import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { bindingToken, catalog, connectGranola, db, granolaRows, laneState, mirror, PublishStore, query, ready, resetAll, tokens } from "./harness.js";
import { FakeGranola, note } from "./fake-granola.js";
import { runGranolaSourceBackfill, runGranolaSourcePoll } from "../../../../src/source-lane/providers/granola/lane.js";
import { granolaCoverage } from "../../../../src/source-lane/providers/granola/coverage.js";
import { granolaNoteDirectory } from "../../../../src/source-lane/providers/granola/export-map.js";
import { granolaProvider } from "../../../../src/source-lane/providers/granola/index.js";
import { refetchGranolaNotes, resetGranolaRateGatesForTests } from "../../../../src/integrations/granola/poller.js";
import { granolaIntegration } from "../../../../src/integrations/granola/index.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";

const T = "tenant-granola-a";
const KEY = "grn_synthetic_key_account_a";
const KEY_B = "grn_synthetic_key_account_b";
const DAY = 86_400_000;
/** ISO time `days` before now (notes must predate the run start: the watermark never passes it). */
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

let fake: FakeGranola;

function ctx() {
  return { tenantId: T, executor: db as never };
}

async function seed(ids: string[], createdDaysAgo = 10): Promise<void> {
  ids.forEach((id, i) => fake.put(KEY, note(id, ago(createdDaysAgo - i * 0.5))));
}

async function cover(tenant = T) {
  const reports = await granolaCoverage({ tenantId: tenant, executor: db as never });
  return { current: reports.find((r) => !r.scope.endsWith(":history"))!, history: reports.find((r) => r.scope.endsWith(":history"))! };
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetGranolaRateGatesForTests();
  fake = new FakeGranola();
  fake.account(KEY);
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Granola inventory pass (granola.backfill through the source lane)", () => {
  it("lists every page without a date bound, checkpoints each page, stores every note and never moves the poll watermark", async () => {
    await seed(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    const watermark = ago(3);
    await connectGranola(T, KEY, { lastUpdatedAt: watermark });

    const result = await runGranolaSourceBackfill(T);

    expect(result).toMatchObject({ listed: 7, processed: 7, failed: 0, stored: 7, capHit: false, inventoryComplete: true });
    const lists = fake.listCalls();
    expect(lists.map((u) => u.searchParams.get("cursor"))).toEqual([null, "c3", "c6"]);
    for (const u of lists) {
      expect(u.searchParams.has("updated_after")).toBe(false);
      expect(u.searchParams.has("created_after")).toBe(false);
    }
    for (const u of fake.detailCalls()) expect(u.searchParams.get("include")).toBe("transcript");

    const rows = await granolaRows(T);
    expect(rows.map((r) => r.source_event_id).sort()).toEqual(
      [...fake.notes.values()].map((n) => `granola:${n.id}:${n.updated_at}`).sort(),
    );
    // Original note raw is kept whole (post-redaction) next to the donor aliases.
    const n1 = rows.find((r) => r.source_event_id.startsWith("granola:n1:"))!;
    expect(n1.raw_payload.transcript[0]).toEqual(fake.notes.get("n1")!.transcript![0]);
    expect(n1.raw_payload.calendar_event.calendar_event_id).toBe("cal-n1");
    expect(n1.source_object_id).toBe("meeting_note:n1");

    const state = await laneState(T);
    expect(state).toMatchObject({ inventory_phase: "complete", inventory_listing_complete: true, inventory_pages: 3, inventory_listed: 7, inventory_generation: 1 });
    expect(state.inventory_complete_key).toBe(state.inventory_key);
    expect(tokens.get(`${T}:granola`)!.metadata!.lastUpdatedAt).toBe(watermark);

    const files = await mirror(T);
    const dir = granolaNoteDirectory("n1", "Meeting n1");
    expect(files.get(`${dir}/transcript.md`)).toContain("hello from owner in n1");
    expect(files.get(`${dir}/summary.md`)).toContain("## Summary of n1");

    await runGranolaSourcePoll(T);
    const { current, history } = await cover();
    expect(current.state).toBe("complete");
    expect(current.counts).toMatchObject({ live_notes: 7, failed_notes: 0 });
    expect(history.state).toBe("partial");
  });

  it("a failed list page leaves a durable checkpoint: the retry resumes there, earlier notes are not re-fetched, coverage stays pending meanwhile", async () => {
    await seed(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(3) });
    fake.script((url) => (url.pathname === "/v1/notes" && url.searchParams.get("cursor") === "c3" ? new Response("upstream boom", { status: 502 }) : null));

    await expect(runGranolaSourceBackfill(T)).rejects.toThrow("(502)");
    let state = await laneState(T);
    expect(state).toMatchObject({ inventory_phase: "running", inventory_cursor: "c3", inventory_pages: 1, inventory_listed: 3 });
    expect((await cover()).current.state).toBe("pending");
    expect(await granolaRows(T)).toHaveLength(3);

    const detailBefore = fake.detailCalls().length;
    const listBefore = fake.listCalls().length;
    const result = await runGranolaSourceBackfill(T);
    expect(result.inventoryComplete).toBe(true);
    expect(fake.listCalls().slice(listBefore).map((u) => u.searchParams.get("cursor"))).toEqual(["c3", "c6"]);
    expect(fake.detailCalls().length - detailBefore).toBe(4);
    expect(await granolaRows(T)).toHaveLength(7);
    state = await laneState(T);
    expect(state).toMatchObject({ inventory_phase: "complete", inventory_listed: 7, inventory_generation: 1 });
  });

  it("an expired resume cursor restarts the pass instead of failing forever", async () => {
    await seed(["n1", "n2", "n3", "n4"]);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(3) });
    fake.script((url) => (url.searchParams.get("cursor") === "c3" ? new Response("boom", { status: 503 }) : null));
    await expect(runGranolaSourceBackfill(T)).rejects.toThrow("(503)");
    fake.script((url) => (url.searchParams.get("cursor") === "c3" ? new Response("cursor expired", { status: 400 }) : null));
    await expect(runGranolaSourceBackfill(T)).rejects.toThrow("(400)");
    expect((await laneState(T)).inventory_cursor).toBeNull();
    const result = await runGranolaSourceBackfill(T);
    expect(result.inventoryComplete).toBe(true);
    expect(await granolaRows(T)).toHaveLength(4);
  });

  it("retries a note whose fetch failed by id before declaring the pass complete", async () => {
    await seed(["n1", "n2", "n3"]);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(3) });
    fake.script((url) => (url.pathname === "/v1/notes/n2" ? new Response("boom", { status: 500 }) : null));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await runGranolaSourceBackfill(T);

    expect(result).toMatchObject({ failed: 0, inventoryComplete: true });
    expect(fake.detailCalls("n2")).toHaveLength(2);
    expect((await laneState(T)).failed_notes).toEqual({});
    expect(await granolaRows(T)).toHaveLength(3);
  });
});

describe("Granola change polling (granola.poll through the source lane)", () => {
  async function inventoried(ids: string[], createdDaysAgo = 10): Promise<void> {
    await seed(ids, createdDaysAgo);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(createdDaysAgo - ids.length) });
    await runGranolaSourceBackfill(T);
  }

  it("appends an edited note as a new immutable revision and keeps the earlier raw row byte-identical", async () => {
    await inventoried(["n1", "n2"]);
    await runGranolaSourcePoll(T);
    const [before] = await query(`SELECT raw_payload::text AS raw FROM activity_events WHERE source_event_id LIKE 'granola:n2:%'`);
    const edited = { ...fake.notes.get("n2")!, updated_at: ago(0.5), summary_markdown: "## Revised summary", title: "Renamed meeting" };
    fake.notes.set("n2", edited);

    const result = await runGranolaSourcePoll(T);

    expect(result).toMatchObject({ failed: 0, stored: 1 });
    const n2rows = (await granolaRows(T)).filter((r) => r.source_object_id === "meeting_note:n2");
    expect(n2rows.map((r) => r.source_event_id)).toEqual([`granola:n2:${fake.notes.get("n2")!.created_at}`, `granola:n2:${edited.updated_at}`]);
    const [after] = await query(`SELECT raw_payload::text AS raw FROM activity_events WHERE source_event_id = $1`, [n2rows[0]!.source_event_id]);
    expect(after!.raw).toBe(before!.raw);
    expect(await catalog(T, "n2")).toMatchObject({ revision_count: 2, title: "Renamed meeting", latest_updated_at: edited.updated_at });
    const files = await mirror(T);
    expect(files.get(`${granolaNoteDirectory("n2", "Renamed meeting")}/summary.md`)).toContain("## Revised summary");
    expect([...files.keys()].some((p) => p.startsWith(granolaNoteDirectory("n2", "Meeting n2")))).toBe(false);
    // The watermark never passes the run start minus the safety margin.
    const watermark = String(tokens.get(`${T}:granola`)!.metadata!.lastUpdatedAt);
    expect(watermark).toBe(edited.updated_at);
  });

  it("captures a transcript that arrives later without an updated_at bump as a content revision", async () => {
    fake.transcriptPending.add("n1");
    await inventoried(["n1"], 1);
    const first = await granolaRows(T);
    expect(first).toHaveLength(1);
    expect(first[0]!.raw_payload.transcript).toEqual([]);
    expect(await catalog(T, "n1")).toMatchObject({ transcript_segments: 0 });

    fake.transcriptPending.delete("n1");
    const result = await runGranolaSourcePoll(T);

    expect(result.transcriptRechecked).toBe(1);
    const rows = await granolaRows(T);
    expect(rows).toHaveLength(2);
    const base = `granola:n1:${fake.notes.get("n1")!.updated_at}`;
    expect(rows[0]!.source_event_id).toBe(base);
    expect(rows[1]!.source_event_id).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#[0-9a-f]{16}$`));
    expect(rows[1]!.raw_payload.transcript).toEqual(fake.notes.get("n1")!.transcript);
    expect(rows[0]!.raw_payload.transcript).toEqual([]);
    expect(await catalog(T, "n1")).toMatchObject({ revision_count: 2, transcript_segments: 2, latest_source_event_id: rows[1]!.source_event_id });
    expect((await mirror(T)).get(`${granolaNoteDirectory("n1", "Meeting n1")}/transcript.md`)).toContain("reply in n1");

    // Unchanged re-fetches are not new revisions.
    await refetchGranolaNotes(T, ["n1"]);
    expect(await granolaRows(T)).toHaveLength(2);
  });

  it("a 403 transcript fallback stores the note without transcript (coverage partial) and never replaces a captured transcript", async () => {
    fake.transcriptForbidden.add("n2");
    await inventoried(["n1", "n2"]);
    await runGranolaSourcePoll(T);
    const n2 = (await granolaRows(T)).find((r) => r.source_object_id === "meeting_note:n2")!;
    expect(n2.raw_payload.api).toMatchObject({ transcriptIncluded: false, transcriptError: "transcripts are not available on this plan" });
    const { current } = await cover();
    expect(current.state).toBe("partial");
    expect(current.reason).toContain("1 live note(s) have no transcript");

    fake.transcriptForbidden.add("n1");
    const outcomes = await refetchGranolaNotes(T, ["n1"]);
    expect(outcomes).toEqual([{ id: "n1", outcome: "unchanged", transcriptIncluded: false }]);
    expect((await granolaRows(T)).filter((r) => r.source_object_id === "meeting_note:n1")).toHaveLength(1);
    expect((await mirror(T)).get(`${granolaNoteDirectory("n1", "Meeting n1")}/transcript.md`)).toContain("hello from owner in n1");
  });

  it("a failed note fetch holds the watermark and the note is retried by id on the next poll", async () => {
    await inventoried(["n1"]);
    await runGranolaSourcePoll(T);
    const watermark = tokens.get(`${T}:granola`)!.metadata!.lastUpdatedAt;
    fake.put(KEY, note("n9", ago(0.5)));
    fake.script((url) => (url.pathname === "/v1/notes/n9" ? new Response("boom", { status: 500 }) : null));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const failed = await runGranolaSourcePoll(T);

    expect(failed).toMatchObject({ failed: 1, watermarkAdvancedTo: null });
    expect(tokens.get(`${T}:granola`)!.metadata!.lastUpdatedAt).toBe(watermark);
    expect(Object.keys((await laneState(T)).failed_notes)).toEqual(["n9"]);
    expect((await cover()).current.state).toBe("partial");

    const healed = await runGranolaSourcePoll(T);
    expect(healed).toMatchObject({ failed: 0, watermarkAdvancedTo: fake.notes.get("n9")!.updated_at });
    expect((await laneState(T)).failed_notes).toEqual({});
    expect((await granolaRows(T)).filter((r) => r.source_object_id === "meeting_note:n9")).toHaveLength(1);
    expect((await cover()).current.state).toBe("complete");
  });

  it("a note that keeps failing stops being retried every poll but keeps coverage partial (never silently dropped)", async () => {
    await inventoried(["n1"]);
    await runGranolaSourcePoll(T);
    await query(`UPDATE granola_source_state SET failed_notes = $2::jsonb WHERE tenant_id = $1`, [T, JSON.stringify({ ghost: { error: "boom", at: ago(1), attempts: 50 } })]);
    const before = fake.detailCalls("ghost").length;

    await runGranolaSourcePoll(T);

    expect(fake.detailCalls("ghost").length).toBe(before);
    expect(Object.keys((await laneState(T)).failed_notes)).toEqual(["ghost"]);
    const { current } = await cover();
    expect(current.state).toBe("partial");
    expect(current.reason).toContain("1 note(s) failed to fetch");
  });

  it("honours a Retry-After beyond the in-request cap: no early retry, a durable cooldown on the credential, deferred polls", async () => {
    await inventoried(["n1"]);
    await runGranolaSourcePoll(T);
    fake.put(KEY, note("n9", ago(0.5)));
    fake.script((url) => (url.pathname === "/v1/notes" ? new Response("slow down", { status: 429, headers: { "retry-after": "120" } }) : null));
    const listsBefore = fake.listCalls().length;

    await expect(runGranolaSourcePoll(T)).rejects.toThrow("(429)");

    expect(fake.listCalls().length - listsBefore).toBe(1);
    const [quota] = await query(`SELECT * FROM granola_source_quota`);
    expect(quota!.quota_key).toMatch(/^granola:api_key:[0-9a-f]{32}$/);
    expect(quota!.quota_key).not.toContain(KEY);
    const until = new Date(quota!.blocked_until).getTime();
    expect(until - Date.now()).toBeGreaterThan(110_000);

    const callsBefore = fake.calls.length;
    const deferred = await runGranolaSourcePoll(T);
    expect(deferred.deferredUntil).toBeTruthy();
    expect(fake.calls.length).toBe(callsBefore);
    const { current } = await cover();
    expect(current.state).toBe("partial");
    expect(current.reason).toContain("rate limited by Granola until");

    // Time passes: the in-process gate and the durable cooldown both expire.
    resetGranolaRateGatesForTests();
    const later = await runGranolaSourcePoll(T, {}, { now: () => new Date(until + 1_000) });
    expect(later).toMatchObject({ failed: 0, stored: 1 });
  });

  it("waits out a short Retry-After on a note fetch, pausing the credential, then succeeds", async () => {
    await inventoried(["n1"]);
    await runGranolaSourcePoll(T);
    fake.put(KEY, note("n9", ago(0.5)));
    fake.script((url) => (url.pathname === "/v1/notes/n9" ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } }) : null));
    const started = Date.now();

    const result = await runGranolaSourcePoll(T);

    expect(result).toMatchObject({ failed: 0, stored: 1 });
    const n9 = fake.calls.filter((c) => c.url.pathname === "/v1/notes/n9");
    expect(n9.map((c) => c.status)).toEqual([429, 200]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });

  it("tombstones a deleted note only after a confirming 404, and a restored then re-deleted note gets a second tombstone", async () => {
    await inventoried(["n1", "n2"]);
    await runGranolaSourcePoll(T); // baselines the deletion sweep clock
    const sweepDue = () => tokenMeta({ granolaDeletionSweepAt: new Date(Date.now() - 7 * 3600_000).toISOString() });
    sweepDue();
    fake.delete("n1");

    const swept = await runGranolaSourcePoll(T);

    expect(swept.deletionSweep).toMatchObject({ tracked: 2, missing: 1, tombstoned: 1, confirmFailed: 0 });
    let n1 = (await granolaRows(T)).filter((r) => r.source_object_id === "meeting_note:n1");
    expect(n1.map((r) => r.event_type)).toEqual(["meeting_note", "meeting_note.deleted"]);
    expect(n1[1]!.source_event_id).toBe("granola:n1:deleted");
    expect(await catalog(T, "n1")).toMatchObject({ deletion_reason: "missing_from_list" });
    expect((await catalog(T, "n1"))!.deleted_at).toBeTruthy();
    expect([...(await mirror(T)).keys()].some((p) => p.startsWith(granolaNoteDirectory("n1", "Meeting n1")))).toBe(false);
    expect((await laneState(T)).last_sweep).toMatchObject({ tombstoned: 1 });

    // Restored with a newer version, then deleted again.
    fake.put(KEY, note("n1", fake.notes.get("n2")!.created_at, { updated_at: ago(0.4), created_at: ago(10) }));
    await runGranolaSourcePoll(T);
    expect((await catalog(T, "n1"))!.deleted_at).toBeNull();
    expect([...(await mirror(T)).keys()].some((p) => p.startsWith(granolaNoteDirectory("n1", "Meeting n1")))).toBe(true);
    fake.delete("n1");
    sweepDue();
    await runGranolaSourcePoll(T);
    n1 = (await granolaRows(T)).filter((r) => r.source_object_id === "meeting_note:n1");
    expect(n1.map((r) => r.event_type)).toEqual(["meeting_note", "meeting_note.deleted", "meeting_note", "meeting_note.deleted"]);
    expect(n1[3]!.source_event_id).toBe(`granola:n1:deleted:${n1[2]!.raw_payload.updatedAt}`);
    expect((await catalog(T, "n1"))!.deleted_at).toBeTruthy();
    expect([...(await mirror(T)).keys()].some((p) => p.startsWith(granolaNoteDirectory("n1", "Meeting n1")))).toBe(false);
  });

  it("a different account (new API key) needs a new inventory pass; coverage is pending until it completes", async () => {
    await inventoried(["a1", "a2"]);
    await runGranolaSourcePoll(T);
    expect((await cover()).current.state).toBe("complete");
    const firstKey = (await laneState(T)).inventory_key;

    fake.account(KEY_B);
    fake.put(KEY_B, note("b1", ago(20)));
    const t = tokens.get(`${T}:granola`)!;
    tokens.set(`${T}:granola`, { ...t, token: KEY_B }); // reconnect keeps metadata (watermark, scope)

    const poll = await runGranolaSourcePoll(T);
    expect(poll.inventoryRequired).toBe(true);
    const state = await laneState(T);
    expect(state.inventory_key).not.toBe(firstKey);
    expect((await cover()).current.state).toBe("pending");
    // The watermark poll alone would never see b1 (updated before the watermark).
    expect((await granolaRows(T)).some((r) => r.source_object_id === "meeting_note:b1")).toBe(false);

    const pass = await runGranolaSourceBackfill(T);
    expect(pass).toMatchObject({ inventoryComplete: true, inventoryGeneration: 2 });
    expect((await granolaRows(T)).some((r) => r.source_object_id === "meeting_note:b1")).toBe(true);
    await runGranolaSourcePoll(T);
    expect((await cover()).current.state).toBe("complete");
  });

  it("an in-scope folder change also requires a new pass, and folder-scoped listing is used", async () => {
    await inventoried(["n1"]);
    tokenMeta({ folderId: "fld-1" });
    fake.notes.get("n1")!.folder_membership = [{ id: "fld-1", object: "folder", name: "Team" }];
    const poll = await runGranolaSourcePoll(T);
    expect(poll.inventoryRequired).toBe(true);
    await runGranolaSourceBackfill(T);
    expect(fake.listCalls().at(-1)!.searchParams.get("folder_id")).toBe("fld-1");
    expect((await cover()).current.scope).toBe("account:api-key/folder:fld-1");
  });
});

describe("Granola task handlers", () => {
  const taskCtx = (tenantId: string) => ({ task: { id: "task-1", queue: "sync", tenantId, groupKey: `${tenantId}:granola`, kind: "granola.poll", payload: {}, attempt: 1 }, heartbeat: async () => {} }) as never;

  it("run for the task row's tenant, refuse a payload naming another tenant, and arm an inventory pass when none completed", async () => {
    await seed(["n1"]);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(3) });
    const handlers = granolaIntegration.taskHandlers!();

    await expect(handlers["granola.poll"]!({ tenantId: "tenant-other" }, taskCtx(T))).rejects.toThrow(/does not match/);
    expect(fake.calls).toHaveLength(0);

    const out = await handlers["granola.poll"]!({}, taskCtx(T));
    expect(out).toMatchObject({ inventoryRequired: true });
    const queued = await query(`SELECT tenant_id, kind, queue, dedupe_key FROM task_queue WHERE kind = 'granola.backfill'`);
    expect(queued).toEqual([{ tenant_id: T, kind: "granola.backfill", queue: "backfill", dedupe_key: `${T}:granola:backfill:inventory` }]);

    const backfill = await handlers["granola.backfill"]!({ tenantId: T }, taskCtx(T));
    expect(backfill).toMatchObject({ failed: 0, inventoryComplete: true });
    // A second (e.g. donor "initial") backfill for a completed key does not re-list everything.
    const lists = fake.listCalls().length;
    await handlers["granola.backfill"]!({}, taskCtx(T));
    expect(fake.listCalls().length).toBe(lists);
  });
});

describe("Granola export (real exporter, native catalog table)", () => {
  it("exports raw revisions, donor projections, note.json and transcript.json exactly as stored, and removes projections on deletion", async () => {
    await seed(["n1", "n2"]);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(3) });
    await runGranolaSourceBackfill(T);
    await runGranolaSourcePoll(T);
    const edited = { ...fake.notes.get("n1")!, updated_at: ago(0.5), summary_markdown: "## v2" };
    fake.notes.set("n1", edited);
    await runGranolaSourcePoll(T);

    const store = new PublishStore();
    vi.stubGlobal("fetch", store.fetch);
    await setTenantBinding(db as never, { tenantId: T, bindingId: "sb-0123456789abcdef", token: bindingToken(T), publishUrl: "http://127.0.0.1:9/", providers: ["*"] });
    const exporter = new SourceExporter({ db: db as never, registry: new SourceProviderRegistry([granolaProvider]), fetchImpl: store.fetch, log: () => {} });
    const drain = async () => {
      for (let i = 0; i < 20; i++) {
        const r = await exporter.runOnce();
        if (r.deadLettered) console.error(await query(`SELECT table_name, row_key, last_error FROM source_lane_journal WHERE dead_lettered_at IS NOT NULL`));
        expect(r.deadLettered).toBe(0);
        if (r.claimed === 0) return;
      }
      throw new Error("exporter did not drain");
    };
    await drain();

    const dir = granolaNoteDirectory("n1", "Meeting n1");
    const noteJson = store.json(`${dir}/note.json`);
    expect(noteJson).toMatchObject({ schema: "procmem.granola.note/v1", noteId: "n1", updatedAt: edited.updated_at, history: { revisions: 2 } });
    expect(noteJson.revisions.map((r: any) => r.kind)).toEqual(["snapshot", "snapshot"]);
    for (const r of noteJson.revisions) expect(store.current(r.raw)?.kind).toBe("raw");
    expect(noteJson.people.transcriptSpeakers).toEqual([
      { source: "microphone", diarization_label: null, name: null, email: null, segments: 1, firstStart: "2027-01-01T10:00:00.000Z" },
      { source: "speaker", diarization_label: "Speaker B", name: null, email: null, segments: 1, firstStart: "2027-01-01T10:00:05.000Z" },
    ]);
    expect(noteJson.people.owner).toEqual({ name: "Owner One", email: "owner@example.test" });
    expect(store.text(`${dir}/summary.md`)).toContain("## v2");
    const transcript = store.json(`${dir}/transcript.json`);
    expect(transcript.segments).toEqual(edited.transcript);
    expect(store.current(`${dir}/note.json`)!.sourceVersion).toEqual({ ref: `granola:n1:${edited.updated_at}`, ordinal: 2 });

    const raw = store.json(noteJson.current.raw);
    expect(raw.raw_payload.summary_markdown).toBe("## v2");
    expect(raw.raw_payload.transcript).toEqual(edited.transcript);
    expect(JSON.stringify(raw)).not.toContain(KEY);

    // Deletion: projections and catalog files are removed (history kept); raw revisions + tombstone stay.
    vi.stubGlobal("fetch", fake.fetch);
    tokenMeta({ granolaDeletionSweepAt: new Date(Date.now() - 7 * 3600_000).toISOString() });
    fake.delete("n1");
    await runGranolaSourcePoll(T);
    vi.stubGlobal("fetch", store.fetch);
    await drain();
    expect(store.current(`${dir}/note.json`)).toBeUndefined();
    expect(store.versions.get(`${dir}/note.json`)!.at(-1)).toMatchObject({ op: "delete", reason: "granola_missing_from_list" });
    expect(store.current(`${dir}/transcript.json`)).toBeUndefined();
    expect(store.current(`${dir}/summary.md`)).toBeUndefined();
    for (const r of noteJson.revisions) expect(store.current(r.raw)?.kind).toBe("raw");
    expect(store.live("sources/granola/_raw/").some((p) => p.includes("granola:n1:deleted"))).toBe(true);
    expect(store.current(`${granolaNoteDirectory("n2", "Meeting n2")}/note.json`)).toBeTruthy();

    const coverage = await exporter.coverage(T);
    expect(coverage.find((r) => r.provider === "granola" && r.scope === "account:api-key")?.state).toBe("complete");
  });
});

function tokenMeta(fields: Record<string, unknown>): void {
  const t = tokens.get(`${T}:granola`)!;
  t.metadata = { ...(t.metadata ?? {}), ...fields };
}
