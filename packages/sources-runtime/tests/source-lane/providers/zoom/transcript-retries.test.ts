import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, json, pg, query, ready } from "../stripe/harness.js";
import { setZoomFetchForTests } from "../../../../src/integrations/zoom/client.js";
import { connectZoomWithTokens } from "../../../../src/integrations/zoom/connect.js";
import { sweepDueSchedules } from "../../../../src/queue/sweeper.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { sourceLaneTaskHandlers } from "../../../../src/source-lane/worker.js";
import { zoomMeetingsExport } from "../../../../src/source-lane/providers/zoom/index.js";
import type { ClaimedTask } from "../../../../src/queue/queue.js";

/**
 * Audit M6 (provider-repairs): a Zoom transcript file that was listed but not captured — a non-429 download
 * failure, an expired download URL, or a VTT still `processing` — is recorded durably, keeps coverage partial and
 * is retried by later leased runs (re-listing the meeting's own dates for fresh metadata), also for meetings older
 * than the 7-day poll window. Everything runs through the production connect, schedule sweep, task handlers,
 * provider coverage and export mapping on PGlite with the real migration plan. Synthetic data only.
 */
const T = "tenant-zoom-retry";
const T2 = "tenant-zoom-undisturbed";
const vtt = (who: string, text: string) => `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n${who}: ${text}`;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

type File = { id: string; status: string; body: string; ready: boolean };
class FakeZoom {
  meetings: Array<{ uuid: string; start: string; topic: string; files: File[] }> = [];
  listings = 0;
  calls: URL[] = [];
  /** Return a response to short-circuit; `gen` is the download URL generation (a fresh listing mints a new one). */
  hooks: Array<(url: URL) => Response | undefined> = [];
  readonly fetch = async (input: string): Promise<Response> => {
    const url = new URL(input);
    this.calls.push(url);
    for (const h of this.hooks) {
      const r = h(url);
      if (r) return r;
    }
    if (url.pathname === "/v2/users/me/recordings") {
      const gen = ++this.listings;
      const from = url.searchParams.get("from")!;
      const to = url.searchParams.get("to")!;
      const all = this.meetings.filter((m) => m.start.slice(0, 10) >= from && m.start.slice(0, 10) <= to);
      const start = Number(url.searchParams.get("next_page_token") ?? 0);
      return json({
        meetings: all.slice(start, start + 2).map((m) => ({
          uuid: m.uuid, id: 99, topic: m.topic, start_time: m.start, host_email: "host@acme.test",
          recording_files: m.files.map((f) => ({ id: f.id, file_type: "TRANSCRIPT", file_extension: "VTT", status: f.ready ? "completed" : "processing", recording_start: m.start, recording_end: m.start,
            ...(f.ready ? { download_url: `https://zoom.us/rec/download/${f.id}?gen=${gen}` } : {}) })),
        })),
        ...(start + 2 < all.length ? { next_page_token: String(start + 2) } : {}),
      });
    }
    if (url.pathname.startsWith("/v2/past_meetings/")) return json({ participants: [{ name: "Ada", user_email: "ada@acme.test" }] });
    if (url.hostname === "zoom.us" && url.pathname.startsWith("/rec/download/")) {
      const f = this.meetings.flatMap((m) => m.files).find((x) => x.id === url.pathname.split("/").pop());
      return f ? new Response(f.body, { status: 200, headers: { "content-type": "text/vtt" } }) : json({ code: 3301, message: "This recording does not exist." }, 404);
    }
    return json({ code: 404 }, 404);
  };
  add(uuid: string, start: string, files: Array<Partial<File> & { id: string }>, topic = `Meeting ${uuid}`) {
    this.meetings.push({ uuid, start, topic, files: files.map((f) => ({ status: "completed", ready: true, body: vtt("Ada", `${f.id} text`), ...f })) });
  }
  file(id: string) {
    return this.meetings.flatMap((m) => m.files).find((f) => f.id === id)!;
  }
}

let fake: FakeZoom;
const handlers = () => sourceLaneTaskHandlers(defaultRegistry());

async function connect(tenantId: string) {
  // The production OAuth completion: stores tokens, activates the connection, schedules zoom.poll, enqueues zoom.backfill.
  await connectZoomWithTokens(tenantId, { access_token: "at-0", refresh_token: "rt-0", expires_in: 3600 }, db as never);
}

/** Run every due queued task of `kind` (as the worker would) and return the handler outputs. */
async function runDue(kind: "zoom.poll" | "zoom.backfill", tenantId = T): Promise<Array<Record<string, unknown>>> {
  if (kind === "zoom.poll") {
    await pg.query(`UPDATE task_schedules SET due_at = now() WHERE tenant_id = $1 AND kind = 'zoom.poll'`, [tenantId]);
    await sweepDueSchedules(db as never);
  }
  const out: Array<Record<string, unknown>> = [];
  const tasks = await query<{ id: string; payload: Record<string, unknown>; group_key: string }>(
    `UPDATE task_queue SET state = 'running', attempt = attempt + 1 WHERE tenant_id = $1 AND kind = $2 AND state = 'queued' AND run_at <= now() RETURNING id, payload, group_key`, [tenantId, kind]);
  for (const t of tasks) {
    const task: ClaimedTask = { id: t.id, queue: kind === "zoom.poll" ? "sync" : "backfill", tenantId, groupKey: t.group_key, kind, payload: t.payload, attempt: 1, maxAttempts: 3, priority: 0, prevRunId: null };
    const r = (await handlers()[kind]!(t.payload, { task, heartbeat: async () => {} })) as Record<string, unknown>;
    await pg.query(`UPDATE task_queue SET state = 'succeeded', finished_at = now() WHERE id = $1`, [t.id]);
    out.push(r);
  }
  return out;
}

/** Drive the backfill task chain until it completes (follow-up tasks are made due immediately). */
async function backfillToCompletion(tenantId = T) {
  for (let i = 0; i < 20; i++) {
    const [r] = await runDue("zoom.backfill", tenantId);
    if (r?.status === "complete") return r;
    await pg.query(`UPDATE task_queue SET run_at = now() WHERE tenant_id = $1 AND kind = 'zoom.backfill' AND state = 'queued'`, [tenantId]);
    await pg.query(`UPDATE zoom_sync_state SET lease_until = NULL, lease_owner = NULL WHERE tenant_id = $1`, [tenantId]);
  }
  throw new Error("backfill did not complete");
}

const coverage = async (tenantId = T) => (await defaultRegistry().get("zoom")!.coverage!({ tenantId, executor: db as never }))[0]!;
const retryRows = (tenantId = T) => query<{ meeting_uuid: string; file_id: string; state: string; attempts: number; last_status: number | null; next_attempt_at: string }>(
  `SELECT meeting_uuid, file_id, state, attempts, last_status, next_attempt_at::text FROM zoom_transcript_files WHERE tenant_id = $1 ORDER BY file_id`, [tenantId]);
const elapse = (tenantId = T) => pg.query(`UPDATE zoom_transcript_files SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1`, [tenantId]);
const events = (tenantId = T) => query<{ n: number }>(`SELECT count(*)::int AS n FROM activity_events WHERE source = 'zoom' AND user_id = $1`, [tenantId]).then((r) => r[0]!.n);

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM zoom_meetings; DELETE FROM zoom_sync_state; DELETE FROM zoom_transcript_files; DELETE FROM zoom_oauth_states; DELETE FROM activity_events WHERE source = 'zoom';
    DELETE FROM integration_tokens; DELETE FROM connections; DELETE FROM task_queue; DELETE FROM task_schedules;`);
  fake = new FakeZoom();
  setZoomFetchForTests(fake.fetch);
  vi.stubEnv("ZOOM_CLIENT_ID", "zoom-client");
  vi.stubEnv("ZOOM_CLIENT_SECRET", "zoom-secret");
});
afterEach(() => {
  setZoomFetchForTests(null);
  vi.unstubAllEnvs();
});

describe("zoom transcript retries (audit M6)", () => {
  it("both lane kinds are registered with the source worker", () => {
    expect(Object.keys(handlers())).toEqual(expect.arrayContaining(["zoom.poll", "zoom.backfill"]));
  });

  it("a 500 download leaves the backfill partial; the poll retry captures it outside the 7-day window with the undisturbed identity; replay adds nothing", async () => {
    // Old meeting (40 days) with two VTT assets; one download 500s once. A second tenant sees the same data undisturbed.
    fake.add("old-1", day(40), [{ id: "old-1-a" }, { id: "old-1-b", body: vtt("Bo", "second asset") }], "Quarterly review");
    fake.add("old-2", day(41), [{ id: "old-2-a" }]);
    let failed = 0;
    fake.hooks.push((url) => (url.pathname.endsWith("/old-1-b") && failed++ === 0 && url.hostname === "zoom.us" ? new Response("upstream error", { status: 500 }) : undefined));
    await connect(T);
    await connect(T2);
    expect((await query(`SELECT kind FROM task_queue WHERE tenant_id = $1`, [T])).map((r) => r.kind)).toEqual(["zoom.backfill"]);
    const done = await backfillToCompletion(T);
    expect(done).toMatchObject({ status: "complete" });
    await runDue("zoom.poll");

    // The failure is durable, and coverage is partial even though the backfill finished and the poll is fresh.
    expect(await retryRows()).toMatchObject([{ meeting_uuid: "old-1", file_id: "old-1-b", state: "failed", attempts: 1, last_status: 500 }]);
    const partial = await coverage();
    expect(partial.state).toBe("partial");
    expect(partial.counts).toMatchObject({ transcriptFilesFailed: 1, transcriptFilesProcessing: 0 });
    expect(partial.reason).toMatch(/1 transcript file\(s\) failed to download/);
    // Only asset A of old-1 was captured so far (the meeting snapshot is still exported, nothing is lost).
    const [{ payload: firstPayload }] = await query<{ payload: { transcriptFileIds: string[] } }>(`SELECT payload FROM zoom_meetings WHERE tenant_id = $1 AND meeting_uuid = 'old-1'`, [T]);
    expect(firstPayload.transcriptFileIds).toEqual(["old-1-a"]);

    // Not due yet: the poll does not hammer the failed file.
    await runDue("zoom.poll");
    expect((await retryRows())[0]!.attempts).toBe(1);
    // Restart after a crash mid-run: a stale lease left behind by the dead process expires and the work resumes.
    await pg.query(`UPDATE zoom_sync_state SET lease_owner = 'crashed-worker', lease_until = now() - interval '1 second' WHERE tenant_id = $1 AND lane = 'poll'`, [T]);
    await elapse();
    const listingsBefore = fake.listings;
    const [retried] = await runDue("zoom.poll");
    expect(retried).toMatchObject({ status: "complete", retriedMeetings: 1, stored: 1 });
    expect(fake.listings - listingsBefore).toBeGreaterThanOrEqual(2); // 7-day poll + the meeting's own dates
    expect(await retryRows()).toEqual([]);
    expect((await coverage()).state).toBe("complete");

    // The re-captured meeting carries both assets, and its identity equals the undisturbed tenant's capture.
    await backfillToCompletion(T2);
    const ids = await query<{ tenant_id: string; source_event_id: string }>(`SELECT tenant_id, source_event_id FROM zoom_meetings WHERE meeting_uuid = 'old-1' ORDER BY tenant_id`);
    expect(ids).toHaveLength(2);
    expect(ids[0]!.source_event_id).toBe(ids[1]!.source_event_id);
    const [row] = await query<{ id: string }>(`SELECT id FROM zoom_meetings WHERE tenant_id = $1 AND meeting_uuid = 'old-1'`, [T]);
    const files = await zoomMeetingsExport.map({ tenantId: T, executor: db as never }, row!.id, { op: "UPDATE", enqueuedAt: new Date().toISOString() }, []);
    const transcript = (files.find((f) => f.path.endsWith("/transcript.md")) as { content: Buffer }).content.toString();
    expect(transcript).toContain("Ada: old-1-a text");
    expect(transcript).toContain("Bo: second asset");

    // Replay: re-running the whole backfill and the poll stores no duplicate versions.
    const before = await events();
    await pg.query(`UPDATE zoom_sync_state SET status = 'pending', completed_at = NULL WHERE tenant_id = $1 AND lane = 'backfill'`, [T]);
    await pg.query(`INSERT INTO task_queue (queue, tenant_id, group_key, kind, payload) VALUES ('backfill', $1, $2, 'zoom.backfill', '{}'::jsonb)`, [T, `${T}:zoom`]);
    await backfillToCompletion(T);
    await runDue("zoom.poll");
    expect(await events()).toBe(before);
    expect(before).toBe(3); // old-1 partial snapshot, old-1 complete snapshot, old-2
  });

  it("a transcript still processing at backfill time is captured once ready, after it has left the 7-day poll window", async () => {
    fake.add("proc-1", day(10), [{ id: "proc-1-vtt", ready: false }]);
    await connect(T);
    await backfillToCompletion(T);
    await runDue("zoom.poll");
    expect(await retryRows()).toMatchObject([{ file_id: "proc-1-vtt", state: "processing" }]);
    expect(await query(`SELECT 1 FROM zoom_meetings WHERE tenant_id = $1`, [T])).toHaveLength(0);
    expect(await coverage()).toMatchObject({ state: "partial", counts: { transcriptFilesProcessing: 1 } });

    // Still processing at the next retry: pushed back with a longer backoff, still partial.
    await elapse();
    await runDue("zoom.poll");
    const [again] = await retryRows();
    expect(again).toMatchObject({ state: "processing", attempts: 2 });
    expect(Date.parse(again!.next_attempt_at) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect((await coverage()).state).toBe("partial");

    fake.file("proc-1-vtt").ready = true;
    await elapse();
    const [r] = await runDue("zoom.poll");
    expect(r).toMatchObject({ retriedMeetings: 1, stored: 1 });
    expect(await retryRows()).toEqual([]);
    expect((await query(`SELECT meeting_uuid FROM zoom_meetings WHERE tenant_id = $1`, [T])).map((x) => x.meeting_uuid)).toEqual(["proc-1"]);
    expect((await coverage()).state).toBe("complete");
  });

  it("an expired download URL is retried with the fresh URL from a re-list (no stale URL is stored)", async () => {
    fake.add("exp-1", day(20), [{ id: "exp-1-vtt" }]);
    // The URL minted by the first listing that contained the meeting is refused (expired); later listings mint fresh ones.
    let firstGen: number | null = null;
    fake.hooks.push((url) => {
      if (url.hostname !== "zoom.us" || !url.pathname.endsWith("/exp-1-vtt")) return undefined;
      const gen = Number(url.searchParams.get("gen"));
      firstGen ??= gen;
      return gen === firstGen ? json({ code: 124, message: "Invalid access token." }, 401) : undefined;
    });
    await connect(T);
    await backfillToCompletion(T);
    expect(await retryRows()).toMatchObject([{ file_id: "exp-1-vtt", state: "failed", last_status: 401 }]);
    expect(JSON.stringify(await query(`SELECT * FROM zoom_transcript_files`))).not.toContain("/rec/download/");
    await elapse();
    await runDue("zoom.poll");
    expect(await retryRows()).toEqual([]);
    const downloads = fake.calls.filter((u) => u.pathname.endsWith("/exp-1-vtt")).map((u) => Number(u.searchParams.get("gen")));
    expect(new Set(downloads).size).toBeGreaterThan(1); // the retry used a newer URL than the first listing's
    expect((await coverage()).state).toBe("complete");
  });

  it("a 429 during a retry defers both lanes until Retry-After, without charging the file; then the retry succeeds", async () => {
    fake.add("rl-1", day(30), [{ id: "rl-1-vtt" }]);
    let fail = true;
    fake.hooks.push((url) => (fail && url.pathname.endsWith("/rl-1-vtt") ? new Response("bad gateway", { status: 502 }) : undefined));
    await connect(T);
    await backfillToCompletion(T);
    await runDue("zoom.poll");
    expect(await retryRows()).toMatchObject([{ state: "failed", attempts: 1, last_status: 502 }]);
    fail = false;

    let limited = 0;
    fake.hooks.push((url) => (url.pathname === "/v2/users/me/recordings" && url.searchParams.get("from")! <= day(30).slice(0, 10) && limited++ === 0 ? json({ code: 429, message: "rate limited" }, 429, { "retry-after": "600" }) : undefined));
    await elapse();
    const t0 = Date.now();
    const [r] = await runDue("zoom.poll");
    expect(r).toMatchObject({ status: "rate_limited" });
    const lanes = await query<{ lane: string; retry_at: string }>(`SELECT lane, retry_at::text FROM zoom_sync_state WHERE tenant_id = $1 ORDER BY lane`, [T]);
    expect(lanes.map((l) => l.lane)).toEqual(["backfill", "poll"]);
    for (const l of lanes) expect(Date.parse(l.retry_at) - t0).toBeGreaterThanOrEqual(595_000);
    expect(await retryRows()).toMatchObject([{ state: "failed", attempts: 1 }]); // a rate limit is not the file's failure

    // Both lanes honour the deferral; a backfill task re-enqueues itself no earlier than Retry-After.
    expect((await runDue("zoom.poll"))[0]).toMatchObject({ status: "skipped" });
    await pg.query(`UPDATE zoom_sync_state SET status = 'running' WHERE tenant_id = $1 AND lane = 'backfill'`, [T]);
    await pg.query(`INSERT INTO task_queue (queue, tenant_id, group_key, kind, payload) VALUES ('backfill', $1, $2, 'zoom.backfill', '{}'::jsonb)`, [T, `${T}:zoom`]);
    expect((await runDue("zoom.backfill"))[0]).toMatchObject({ status: "skipped" });
    const [next] = await query<{ run_at: string }>(`SELECT run_at::text FROM task_queue WHERE tenant_id = $1 AND kind = 'zoom.backfill' AND state = 'queued'`, [T]);
    expect(Date.parse(next!.run_at) - t0).toBeGreaterThanOrEqual(595_000);
    await pg.query(`UPDATE zoom_sync_state SET status = 'complete' WHERE tenant_id = $1 AND lane = 'backfill'`, [T]);

    // After the deadline the retry captures the file.
    await pg.query(`UPDATE zoom_sync_state SET retry_at = now() - interval '1 second' WHERE tenant_id = $1`, [T]);
    const [ok] = await runDue("zoom.poll");
    expect(ok).toMatchObject({ status: "complete", stored: 1 });
    expect(await retryRows()).toEqual([]);
    expect((await coverage()).state).toBe("complete");
  });

  it("a meeting deleted at Zoom before its retry is marked gone and reported, not retried forever", async () => {
    fake.add("del-1", day(50), [{ id: "del-1-vtt" }]);
    fake.hooks.push((url) => (url.pathname.endsWith("/del-1-vtt") ? new Response("cdn error", { status: 503 }) : undefined));
    await connect(T);
    await backfillToCompletion(T);
    await runDue("zoom.poll");
    expect((await coverage()).state).toBe("partial");
    fake.meetings = [];
    await elapse();
    const [r] = await runDue("zoom.poll");
    expect(r).toMatchObject({ retriedMeetings: 1, gone: 1 });
    expect(await retryRows()).toMatchObject([{ state: "gone" }]);
    const cov = await coverage();
    expect(cov.state).toBe("complete");
    expect(cov.reason).toMatch(/1 listed transcript file\(s\) were deleted at Zoom before they could be captured/);
    expect(cov.counts).toMatchObject({ transcriptFilesGone: 1, transcriptFilesFailed: 0 });
    await elapse();
    expect((await runDue("zoom.poll"))[0]).toMatchObject({ retriedMeetings: 0 });
  });
});
