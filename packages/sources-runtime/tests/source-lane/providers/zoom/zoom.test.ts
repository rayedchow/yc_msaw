import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("../stripe/harness.js");
  return { db: h.db, pgClient: null };
});

import { db, json, pg, query, ready } from "../stripe/harness.js";
import { setZoomFetchForTests } from "../../../../src/integrations/zoom/client.js";
import { connectZoom } from "../../../../src/integrations/zoom/connect.js";
import { zoomCallbackRoute } from "../../../../src/integrations/zoom/callback.js";
import { syncZoomLane, zoomWindows } from "../../../../src/integrations/zoom/poller.js";
import { zoomIntegration } from "../../../../src/integrations/zoom/index.js";
import { integrationById } from "../../../../src/integrations/registry.js";
import { zoomMeetingDirectory, zoomMeetingsExport, zoomProvider } from "../../../../src/source-lane/providers/zoom/index.js";
import { getTokenFull, storeToken } from "../../../../src/vault/tokens.js";

/**
 * Zoom transcripts (coordinator port of askshepherd/aqueduct c7e1415): single-use tenant-bound OAuth state,
 * rotating refresh tokens under the tenant lease, resumable 30-day windows with page tokens, Retry-After,
 * credential-safe transcript downloads, donor snapshot identity, export and truthful coverage.
 */
const T = "tenant-zoom";
const VTT = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAda: Hello team.\n\n2\n00:00:03.000 --> 00:00:04.000\nBo: Hi.";

class FakeZoom {
  meetings: Array<Record<string, unknown>> = [];
  calls: Array<{ url: URL; auth: string | null; method: string }> = [];
  refreshes = 0;
  hooks: Array<(url: URL) => Response | undefined> = [];
  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get("authorization");
    this.calls.push({ url, auth, method: (init?.method ?? "GET").toUpperCase() });
    for (const h of this.hooks) {
      const r = h(url);
      if (r) return r;
    }
    if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "refresh_token") {
        this.refreshes++;
        if (body.get("refresh_token") !== `rt-${this.refreshes - 1}`) return json({ reason: "Invalid Token!" }, 400);
        return json({ access_token: `at-${this.refreshes}`, refresh_token: `rt-${this.refreshes}`, expires_in: 3600 });
      }
      return json({ access_token: "at-0", refresh_token: "rt-0", expires_in: 3600, scope: "cloud_recording:read:list_user_recordings" });
    }
    if (url.pathname === "/v2/users/me/recordings") {
      const from = url.searchParams.get("from")!;
      const to = url.searchParams.get("to")!;
      const all = this.meetings.filter((m) => String(m.start_time).slice(0, 10) >= from && String(m.start_time).slice(0, 10) <= to);
      const start = Number(url.searchParams.get("next_page_token") ?? 0);
      return json({ meetings: all.slice(start, start + 2), ...(start + 2 < all.length ? { next_page_token: String(start + 2) } : {}) });
    }
    if (url.pathname.startsWith("/v2/past_meetings/")) return json({ participants: [{ name: "Ada", user_email: "ada@acme.test" }] });
    if (url.hostname === "zoom.us" && url.pathname.startsWith("/rec/download/")) return new Response(null, { status: 302, headers: { location: `https://cdn.zoomcdn.example/${url.pathname.split("/").pop()}?sig=abc` } });
    if (url.hostname === "cdn.zoomcdn.example") return new Response(VTT, { status: 200, headers: { "content-type": "text/vtt" } });
    return json({ code: 404 }, 404);
  };
  add(uuid: string, start: string, topic = `Meeting ${uuid}`) {
    this.meetings.push({ uuid, id: 123, topic, start_time: start, host_email: "host@acme.test", share_url: "https://zoom.us/rec/share/x", recording_files: [
      { id: `${uuid}-vtt`, file_type: "TRANSCRIPT", file_extension: "VTT", status: "completed", download_url: `https://zoom.us/rec/download/${uuid}-vtt`, recording_end: start },
      { id: `${uuid}-mp4`, file_type: "MP4", status: "completed", download_url: `https://zoom.us/rec/download/${uuid}-mp4` },
    ] });
  }
}

let fake: FakeZoom;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
async function connected(expiresInMs = 3_600_000) {
  await storeToken(T, "zoom", "at-0", { connectedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString() }, "rt-0");
  await query(`INSERT INTO connections (tenant_id, provider, status) VALUES ($1, 'zoom', 'active')`, [T]);
}
const free = () => pg.exec(`UPDATE zoom_sync_state SET retry_at = NULL, lease_until = NULL, lease_owner = NULL`);

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  await pg.exec(`DELETE FROM zoom_meetings; DELETE FROM zoom_sync_state; DELETE FROM zoom_oauth_states; DELETE FROM activity_events WHERE source = 'zoom'; DELETE FROM integration_tokens; DELETE FROM connections; DELETE FROM task_queue; DELETE FROM task_schedules;`);
  fake = new FakeZoom();
  setZoomFetchForTests(fake.fetch);
  vi.stubEnv("ZOOM_CLIENT_ID", "zoom-client");
  vi.stubEnv("ZOOM_CLIENT_SECRET", "zoom-secret");
  vi.stubEnv("SOURCES_RUNTIME_PUBLIC_URL", "https://runtime.example.test");
});
afterEach(() => {
  setZoomFetchForTests(null);
  vi.unstubAllEnvs();
});

describe("zoom", () => {
  it("OAuth state is tenant-bound and single-use; the callback stores rotating tokens and schedules the lanes", async () => {
    expect((await connectZoom({ tenantId: T, body: { mode: "oauth", tenantId: "x" } }, db as never)).status).toBe(400);
    const r = await connectZoom({ tenantId: T, body: { mode: "oauth" } }, db as never);
    const url = new URL((r.body as { authorizeUrl: string }).authorizeUrl);
    expect(url.searchParams.get("redirect_uri")).toBe("https://runtime.example.test/auth/zoom/callback");
    const state = url.searchParams.get("state")!;
    expect((await zoomCallbackRoute.request(`/?code=c1&state=${encodeURIComponent(state.replace(/.$/, "x"))}`)).status).toBe(400);
    expect((await zoomCallbackRoute.request(`/?code=c1&state=${encodeURIComponent(state)}`)).status).toBe(200);
    expect((await zoomCallbackRoute.request(`/?code=c1&state=${encodeURIComponent(state)}`)).status).toBe(400);
    expect((await getTokenFull(T, "zoom"))).toMatchObject({ token: "at-0", refreshToken: "rt-0" });
    expect((await query(`SELECT kind FROM task_schedules WHERE tenant_id = $1`, [T])).map((x) => x.kind)).toEqual(["zoom.poll"]);
    expect((await query(`SELECT kind FROM task_queue WHERE tenant_id = $1`, [T])).map((x) => x.kind)).toEqual(["zoom.backfill"]);
  });

  it("backfills 30-day windows resumably with page tokens, keeps the donor identity, redacts and never leaks the bearer to the CDN", async () => {
    await connected();
    for (let i = 0; i < 5; i++) fake.add(`u${i}`, day(5 + i * 15));
    expect(zoomWindows(new Date(day(70)), new Date())).toHaveLength(3);
    const r1 = await syncZoomLane(T, "backfill", 70, { maxPages: 2 });
    expect(r1.status).toBe("running");
    for (let i = 0; i < 6; i++) {
      await free();
      if ((await syncZoomLane(T, "backfill", 70, { maxPages: 2 })).status === "complete") break;
    }
    const meetings = await query<{ meeting_uuid: string; source_event_id: string; payload: Record<string, unknown> }>(`SELECT meeting_uuid, source_event_id, payload FROM zoom_meetings ORDER BY meeting_uuid`);
    expect(meetings.map((m) => m.meeting_uuid)).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    expect(meetings[0]!.source_event_id).toMatch(/^zoom:u0:[0-9a-f]{64}$/);
    const raw = JSON.stringify(meetings[0]!.payload);
    expect(raw).not.toContain("/rec/download/");
    expect((meetings[0]!.payload.transcript as unknown[]).length).toBe(2);
    expect(fake.calls.filter((c) => c.url.hostname === "cdn.zoomcdn.example").every((c) => c.auth === null)).toBe(true);
    expect(fake.calls.filter((c) => c.url.hostname === "zoom.us" && c.url.pathname.startsWith("/rec/")).every((c) => c.auth === "Bearer at-0")).toBe(true);
    expect(fake.calls.some((c) => c.url.pathname.endsWith("-mp4"))).toBe(false); // no audio/video download
    const before = (await query(`SELECT count(*)::int AS n FROM activity_events WHERE source = 'zoom'`))[0]!.n;
    await pg.exec(`UPDATE zoom_sync_state SET status = 'pending', completed_at = NULL WHERE lane = 'backfill'`);
    await free();
    for (let i = 0; i < 6; i++) {
      await free();
      if ((await syncZoomLane(T, "backfill", 70, { maxPages: 5 })).status === "complete") break;
    }
    expect((await query(`SELECT count(*)::int AS n FROM activity_events WHERE source = 'zoom'`))[0]!.n).toBe(before);
  });

  it("rotates refresh tokens once under the tenant lease and blocks on a rejected refresh", async () => {
    await connected(-1);
    fake.add("u0", day(1));
    expect((await syncZoomLane(T, "poll", 7)).status).toBe("complete");
    expect(fake.refreshes).toBe(1);
    expect(await getTokenFull(T, "zoom")).toMatchObject({ token: "at-1", refreshToken: "rt-1" });
    // The other lane cannot run while one holds the tenant lease.
    await pg.exec(`UPDATE zoom_sync_state SET lease_owner = 'someone', lease_until = now() + interval '5 minutes' WHERE lane = 'poll'`);
    expect((await syncZoomLane(T, "backfill", 30)).status).toBe("skipped");
    await free();
    // A refresh Zoom rejects (rotated-away token) needs reconnecting: blocked, not retried forever.
    await storeToken(T, "zoom", "at-x", { expiresAt: new Date(Date.now() - 1).toISOString() }, "rt-stale");
    const r = await syncZoomLane(T, "backfill", 30);
    expect(r.status).toBe("blocked");
    expect((await zoomProvider.coverage!({ tenantId: T, executor: db as never }))[0]!.state).toBe("blocked");
  });

  it("persists Retry-After and resumes the same window page", async () => {
    await connected();
    for (let i = 0; i < 4; i++) fake.add(`r${i}`, day(2 + i));
    let limited = false;
    fake.hooks.push((url) => (!limited && url.pathname === "/v2/users/me/recordings" && url.searchParams.get("next_page_token") === "2" ? ((limited = true), json({ code: 429 }, 429, { "retry-after": "180" })) : undefined));
    const t0 = Date.now();
    const r = await syncZoomLane(T, "backfill", 10);
    expect(r.status).toBe("rate_limited");
    expect(Date.now() - t0).toBeLessThan(5_000);
    const [s] = await query<{ retry_at: string; next_page_token: string }>(`SELECT retry_at, next_page_token FROM zoom_sync_state WHERE lane = 'backfill'`);
    expect(s!.next_page_token).toBe("2");
    expect(Date.parse(s!.retry_at) - t0).toBeGreaterThanOrEqual(179_000);
    expect((await syncZoomLane(T, "backfill", 10)).status).toBe("skipped");
    await free();
    expect((await syncZoomLane(T, "backfill", 10)).status).toBe("complete");
    expect((await query(`SELECT count(*)::int AS n FROM zoom_meetings`))[0]!.n).toBe(4);
  });

  it("exports summary/transcript/meeting.json with the branch rendering, moves on rename, and reports truthful coverage", async () => {
    expect(integrationById("zoom")).toBe(zoomIntegration);
    await connected();
    fake.add("m1", day(1), "Weekly sync");
    await syncZoomLane(T, "backfill", 7);
    await free();
    await syncZoomLane(T, "poll", 7);
    const [{ id }] = await query<{ id: string }>(`SELECT id FROM zoom_meetings`);
    const j = { op: "INSERT" as const, enqueuedAt: new Date().toISOString() };
    const files = await zoomMeetingsExport.map({ tenantId: T, executor: db as never }, id!, j, []);
    const dir = zoomMeetingDirectory("m1", "Weekly sync");
    expect(dir).toMatch(/^sources\/zoom\/weekly-sync-meeting-[0-9a-f]{12}$/);
    expect(files.map((f) => f.path)).toEqual([`${dir}/summary.md`, `${dir}/transcript.md`, `${dir}/meeting.json`]);
    expect((files[1] as { content: Buffer }).content.toString()).toContain("**00:00:01.000 - 00:00:02.000** Ada: Hello team.");
    expect((files[0] as { content: Buffer }).content.toString()).toContain("- Ada — ada@acme.test");
    const cov = await zoomProvider.coverage!({ tenantId: T, executor: db as never });
    expect(cov[0]).toMatchObject({ state: "complete" });
    expect(cov[0]!.reason).toMatch(/no audio, no meeting chat, no Zoom AI summaries/);
    // Rename: the meeting moves directory and the old paths are deleted.
    fake.meetings[0]!.topic = "Weekly sync (renamed)";
    await free();
    await pg.exec(`UPDATE zoom_sync_state SET status = 'pending' WHERE lane = 'poll'`);
    await syncZoomLane(T, "poll", 7);
    const moved = await zoomMeetingsExport.map({ tenantId: T, executor: db as never }, id!, j, files.map((f) => f.path));
    expect(moved.filter((c) => c.op === "delete").map((c) => c.path).sort()).toEqual(files.map((f) => f.path).sort());
  });
});
