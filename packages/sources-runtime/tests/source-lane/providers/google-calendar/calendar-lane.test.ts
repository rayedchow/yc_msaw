import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CALENDAR_FULL_SYNC_PAGES_PER_RUN = "2";
});
vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
// Donor run bookkeeping reads postgres.js array results (PGlite returns {rows}); recorded here instead.
const syncRuns = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>>, finished: [] as Array<Record<string, unknown>> }));
vi.mock("../../../../src/db/source-sync-runs.js", () => ({
  startSyncRun: vi.fn(async (input: Record<string, unknown>) => {
    syncRuns.started.push(input);
    return `run-${syncRuns.started.length}`;
  }),
  finishSyncRun: vi.fn(async (id: string, input: Record<string, unknown>) => {
    syncRuns.finished.push({ id, ...input });
  }),
}));
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => {
  const h = await import("./harness.js");
  return {
    ...await importOriginal<typeof import("../../../../src/vault/google-auth.js")>(),
    getGoogleApiCredential: vi.fn(async (tenant: string, account: string | undefined, scopes: readonly string[]) => h.syntheticCredential(tenant, account, scopes)),
    isDelegationConfigured: () => h.auth.delegationConfigured,
  };
});

import { FakeGoogle, auth, connectMailbox, db, fakePublish, inlineText, json, mintBindingToken, query, ready, resetTenant, seedDwdAdmin } from "./harness.js";
import { runGoogleCalendarDelta, runGoogleCalendarSetup } from "../../../../src/integrations/google/calendar/jobs.js";
import { googleIntegration } from "../../../../src/integrations/google/index.js";
import { disconnectAllGoogleAccounts } from "../../../../src/integrations/google/connect.js";
import { calendarProvider } from "../../../../src/source-lane/providers/calendar/index.js";
import { calendarEventPath, calendarMetaPath } from "../../../../src/source-lane/providers/calendar/export.js";
import { clearGoogleLaneDirectoryCacheForTests } from "../../../../src/source-lane/providers/calendar/google-lane.js";
import { stopCalendarWatches } from "../../../../src/source-lane/providers/calendar/watches.js";
import { googleContactsProvider } from "../../../../src/source-lane/providers/google-contacts/index.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { GoogleOAuthScopeError } from "../../../../src/vault/google-oauth.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import { env } from "../../../../src/env.js";

const T = "tenant-cal-a";
const T2 = "tenant-cal-b";
const MB = "ana@acme.test";
const MB2 = "bo@acme.test";
const PRIMARY = { id: MB, summary: "Ana", primary: true, accessRole: "owner", timeZone: "America/Los_Angeles" };

let fake: FakeGoogle;
let clock = Date.parse("2026-10-01T00:00:00Z");
const registry = new SourceProviderRegistry([calendarProvider, googleContactsProvider]);

function stamp(): string {
  clock += 60_000;
  return new Date(clock).toISOString();
}

function ev(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    status: "confirmed",
    eventType: "default",
    summary: `Meeting ${id}`,
    updated: stamp(),
    start: { dateTime: "2026-11-02T10:00:00-08:00" },
    end: { dateTime: "2026-11-02T11:00:00-08:00" },
    organizer: { email: "host@acme.test", displayName: "Host" },
    attendees: [{ email: "ana@acme.test", self: true, responseStatus: "accepted" }, { email: "guest@ext.test", responseStatus: "needsAction" }],
    ...over,
  };
}

const run = (tenant = T, input: Parameters<typeof runGoogleCalendarDelta>[1] = {}) => runGoogleCalendarDelta(tenant, input);

async function cursor(tenant: string, mailbox: string, calendarId: string) {
  const [row] = await query(
    `SELECT * FROM google_calendar_lane_cursors WHERE tenant_id = $1 AND mailbox = $2 AND resource_type = 'events' AND resource_key = $3`,
    [tenant, mailbox, calendarId],
  );
  return row;
}

async function snapshots(tenant: string, mailbox = MB) {
  return query<{ id: string; event_id: string; status: string; summary: string }>(
    `SELECT id::text, event_id, status, summary FROM google_calendar_event_snapshots WHERE user_id = $1 AND delegated_email = $2 ORDER BY event_id`,
    [tenant, mailbox],
  );
}

async function activityTypes(tenant: string): Promise<string[]> {
  return (await query<{ event_type: string }>(`SELECT event_type FROM activity_events WHERE user_id = $1 AND source = 'calendar' ORDER BY created_at, event_type`, [tenant])).map((r) => r.event_type);
}

async function coverage(tenant = T) {
  return calendarProvider.coverage!({ tenantId: tenant, executor: db as never });
}

/** Real exporter: journal (written by the 9000/9175 triggers) -> calendar module mapping -> publish. */
async function exportAll(tenant = T): Promise<Array<Record<string, any>>> {
  const published: Array<Record<string, any>> = [];
  const binding = mintBindingToken(tenant);
  await setTenantBinding(db as never, { tenantId: tenant, bindingId: binding.bindingId, token: binding.token, publishUrl: "http://127.0.0.1:9", providers: ["*"] });
  const exporter = new SourceExporter({ db: db as never, registry, fetchImpl: fakePublish(published), log: () => {} });
  for (let i = 0; i < 30; i++) {
    const r = await exporter.runOnce();
    expect(r.deadLettered).toBe(0);
    if (r.claimed === 0) return published;
  }
  throw new Error("exporter did not drain");
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetTenant(T, T2);
  resetGoogleRateLimitCooldownsForTests();
  clearGoogleLaneDirectoryCacheForTests();
  auth.failures.clear();
  auth.delegationConfigured = false;
  env.WEBHOOK_BASE_URL = undefined;
  fake = new FakeGoogle();
  vi.stubGlobal("fetch", fake.fetch);
  await connectMailbox(T, MB);
  fake.putCalendar(T, MB, PRIMARY);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("resumable initial full sync", () => {
  it("checkpoints pages, survives a failed page, resumes from the checkpoint and commits the sync token last", async () => {
    for (const id of ["e1", "e2", "e3", "e4", "e5"]) fake.putEvent(T, MB, MB, ev(id));

    // Run 1: page budget is 2 pages (of 2 events each): bounded, not complete.
    const r1 = await run();
    expect(r1.capHit).toBe(true);
    let c = await cursor(T, MB, MB);
    expect(c.sync_token).toBeNull();
    expect(c.full_sync_page_token).toBe("evp:4");
    expect(c.first_full_sync_completed_at).toBeNull();
    expect((await snapshots(T)).map((s) => s.event_id)).toEqual(["e1", "e2", "e3", "e4"]);
    let mailbox = (await coverage()).find((r) => r.scope === `mailbox:${MB}`)!;
    expect(mailbox.state).toBe("partial");
    expect(mailbox.reason).toMatch(/initial full sync in progress/);

    // Run 2: the resumed page fails (5xx): checkpoint and sync token untouched, backoff recorded.
    let failNext = true;
    fake.hooks.push(({ url }) => {
      if (failNext && url.searchParams.get("pageToken") === "evp:4") {
        failNext = false;
        return json({ error: { code: 503, message: "backend error" } }, 503);
      }
      return undefined;
    });
    const r2 = await run();
    expect(r2.calendarsFailed).toBe(1);
    c = await cursor(T, MB, MB);
    expect(c.full_sync_page_token).toBe("evp:4");
    expect(c.sync_token).toBeNull();
    expect(c.last_error_code).toBe("http_503");
    expect(new Date(c.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // While backing off the calendar is not retried.
    const before = fake.calls.length;
    await run();
    expect(fake.calls.slice(before).some((x) => x.url.pathname.endsWith("/events"))).toBe(false);

    // Backoff elapsed: resumes exactly at the checkpoint, completes, then (and only then) stores the sync token.
    await query(`UPDATE google_calendar_lane_cursors SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1`, [T]);
    const mark = fake.calls.length;
    const r3 = await run();
    expect(r3.fullSyncsCompleted).toBe(1);
    const eventCalls = fake.calls.slice(mark).filter((x) => x.url.pathname.endsWith("/events"));
    expect(eventCalls[0]!.url.searchParams.get("pageToken")).toBe("evp:4");
    expect(eventCalls[0]!.url.searchParams.get("syncToken")).toBeNull();
    c = await cursor(T, MB, MB);
    expect(c.sync_token).toMatch(/^ev:\d+$/);
    expect(c.full_sync_page_token).toBeNull();
    expect(c.first_full_sync_completed_at).not.toBeNull();
    expect((await snapshots(T)).map((s) => s.event_id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    // Donor full-sync semantics: one raw row per new event, no semantic rows.
    expect(await activityTypes(T)).toEqual(Array(5).fill("calendar_event_default"));

    mailbox = (await coverage()).find((r) => r.scope === `mailbox:${MB}`)!;
    expect(mailbox.state).toBe("complete");
    expect(mailbox.reason).toMatch(/edit history only from first capture/);
    expect(mailbox.counts).toMatchObject({ calendars: 1, events: 5 });

    // Next poll is incremental (sync token, no page token, nothing re-listed).
    const mark2 = fake.calls.length;
    await run();
    const inc = fake.calls.slice(mark2).filter((x) => x.url.pathname.endsWith("/events"));
    expect(inc).toHaveLength(1);
    expect(inc[0]!.url.searchParams.get("syncToken")).toBe(c.sync_token);
    expect(inc[0]!.url.searchParams.getAll("eventTypes")).toEqual(["birthday", "default", "focusTime", "fromGmail", "outOfOffice", "workingLocation"]);
    expect(inc[0]!.url.searchParams.get("singleEvents")).toBe("true");
    expect(inc[0]!.url.searchParams.get("showDeleted")).toBe("true");
  });

  it("leases the calendar cursor so concurrent polls (schedule + webhook) never list the same calendar twice", async () => {
    for (const id of ["e1", "e2", "e3"]) fake.putEvent(T, MB, MB, ev(id));
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.calendarsSynced + b.calendarsSynced).toBe(1);
    expect(a.calendarsPartial + b.calendarsPartial).toBe(1);
    const firstPages = fake.calls.filter((c) => c.url.pathname.endsWith("/events") && !c.url.searchParams.get("pageToken"));
    expect(firstPages).toHaveLength(1);
    expect((await cursor(T, MB, MB)).lease_owner).toBeNull();
  });

  it("restarts a full listing whose checkpointed page token expired between runs", async () => {
    for (const id of ["e1", "e2", "e3", "e4", "e5"]) fake.putEvent(T, MB, MB, ev(id));
    await run();
    fake.invalidPageTokens = true;
    fake.hooks.push(({ url }) => {
      if (url.pathname.endsWith("/events") && url.searchParams.get("pageToken") === null) fake.invalidPageTokens = false;
      return undefined;
    });
    const r = await run();
    expect(r.resets).toBe(1);
    const c = await cursor(T, MB, MB);
    expect(c.full_sync_reason).toBe("page_token_invalid");
    expect(c.full_sync_page_token).toBe("evp:4");
    await run();
    expect((await cursor(T, MB, MB)).sync_token).toMatch(/^ev:/);
    // Restarting never removed anything that the listing still returns.
    expect((await snapshots(T)).length).toBe(5);
    expect(await query(`SELECT 1 FROM google_calendar_event_revisions WHERE tenant_id = $1 AND op = 'removed'`, [T])).toHaveLength(0);
  });
});

describe("incremental changes, cancellations and recurrence", () => {
  beforeEach(async () => {
    fake.pageSize = 50;
  });

  it("emits the donor semantic diffs, keeps raw revisions with diffs and tombstones cancellations in the export", async () => {
    fake.putEvent(T, MB, MB, ev("e1"));
    fake.putEvent(T, MB, MB, ev("e2"));
    await run();
    await exportAll();

    fake.putEvent(T, MB, MB, ev("e1", {
      start: { dateTime: "2026-11-02T12:00:00-08:00" },
      end: { dateTime: "2026-11-02T13:00:00-08:00" },
      location: "Room 4",
      attendees: [{ email: "ana@acme.test", self: true, responseStatus: "accepted" }, { email: "guest@ext.test", responseStatus: "declined" }, { email: "new@ext.test", responseStatus: "needsAction" }],
    }));
    fake.putEvent(T, MB, MB, { id: "e2", status: "cancelled", updated: stamp() });
    fake.putEvent(T, MB, MB, ev("e6", { summary: "Brand new" }));
    await run();

    const types = await activityTypes(T);
    expect(types.slice(2).sort()).toEqual([
      "calendar_attendee_added",
      "calendar_attendee_response_changed",
      "calendar_event_cancelled",
      "calendar_event_default",
      "calendar_event_rescheduled",
      "calendar_location_changed",
    ]);
    const [cancelled] = await query<{ raw: any }>(`SELECT raw_payload AS raw FROM activity_events WHERE user_id = $1 AND event_type = 'calendar_event_cancelled'`, [T]);
    expect(cancelled!.raw.title).toBe("Calendar event cancelled: Meeting e2");

    const published = await exportAll();
    const e1Path = calendarEventPath(MB, MB, "e1");
    const e1 = published.find((c) => c.op === "put" && c.path === e1Path)!;
    const doc = JSON.parse(inlineText(e1));
    expect(doc.schema).toBe("procmem.google-calendar.event-snapshot/v1");
    expect(doc.raw_payload.rawEvent.start.dateTime).toBe("2026-11-02T12:00:00-08:00");
    expect(doc.raw_payload.attendees.map((a: any) => a.responseStatus)).toEqual(["accepted", "declined", "needsAction"]);
    expect(e1.sourceVersion?.ordinal).toBe(Date.parse(doc.raw_payload.updated));

    const e2Delete = published.find((c) => c.op === "delete" && c.path === calendarEventPath(MB, MB, "e2"))!;
    expect(e2Delete.reason).toBe("cancelled");

    const revision = published.find((c) => c.op === "put" && /\/changes\/2\d{3}-\d{2}\/.*--e1--r\d+\.json$/.test(c.path) && JSON.parse(inlineText(c)).op === "updated")!;
    const rev = JSON.parse(inlineText(revision));
    const diffPaths = rev.diff.map((d: any) => d.path);
    expect(diffPaths).toEqual(expect.arrayContaining(["/start/dateTime", "/attendees/1/responseStatus", "/attendees/2", "/location"]));
    expect(rev.raw_payload.eventId).toBe("e1");

    // Shared readable projection: e2's mirror file is gone, e1's moved with the reschedule.
    const mirror = await query<{ path: string }>(`SELECT path FROM mirror_files WHERE user_id = $1 AND path LIKE 'sources/calendar/2%' ORDER BY path`, [T]);
    expect(mirror.some((m) => m.path.includes("meeting-e2"))).toBe(false);
    expect(mirror.some((m) => m.path.includes("meeting-e1"))).toBe(true);
    expect(published.some((c) => c.op === "delete" && c.path.startsWith("sources/calendar/2") && c.path.includes("meeting-e2"))).toBe(true);

    // A restored (un-cancelled) event comes back as a put.
    fake.putEvent(T, MB, MB, ev("e2", { summary: "Meeting e2" }));
    await run();
    const e2Types = (await query<{ event_type: string }>(
      `SELECT event_type FROM activity_events WHERE user_id = $1 AND raw_payload ->> 'eventId' = 'e2' ORDER BY event_type`, [T],
    )).map((r) => r.event_type);
    // Donor deriveCalendarSemanticChanges: Google's minimal cancelled payload has no time or
    // attendees, so a restore also reports them as rescheduled / added (donor behaviour, kept).
    expect(e2Types).toEqual([
      "calendar_attendee_added", "calendar_attendee_added", "calendar_event_cancelled", "calendar_event_default",
      "calendar_event_details_changed", "calendar_event_rescheduled", "calendar_event_restored",
    ]);
    const again = await exportAll();
    expect(again.some((c) => c.op === "put" && c.path === calendarEventPath(MB, MB, "e2"))).toBe(true);
  });

  it("keeps conference credentials, bearers, channel tokens and sync cursors out of every exported file", async () => {
    env.WEBHOOK_BASE_URL = "https://hooks.example.test";
    fake.putEvent(T, MB, MB, ev("conf", {
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.example.test/join?pwd=s3cr3t-uri", passcode: "s3cr3t-pass" }] },
    }));
    await run();
    await run();
    const published = await exportAll();
    const everything = published.map((c) => `${c.path}\n${c.inline ? inlineText(c) : ""}\n${JSON.stringify(c.provenance ?? {})}`).join("\n");
    expect(everything).toContain("[redacted: google-calendar conference credential]");
    expect(everything).not.toContain("s3cr3t");
    expect(everything).not.toContain(`tok:${T}`);
    const [cur] = await query<{ sync_token: string }>(`SELECT sync_token FROM google_calendar_lane_cursors WHERE tenant_id = $1 AND resource_type = 'events'`, [T]);
    expect(cur!.sync_token).toBeTruthy();
    expect(everything).not.toContain(cur!.sync_token);
    for (const w of fake.calls.filter((c) => c.url.pathname.endsWith("/watch"))) expect(everything).not.toContain(String(w.body!.token));
  });

  it("tracks recurring instances individually (cancelled occurrence, moved occurrence, all-day in the calendar time zone)", async () => {
    const instance = (date: string, over: Record<string, unknown> = {}) => ev(`series1_${date.replace(/-/g, "")}T180000Z`, {
      summary: "Weekly 1:1",
      recurringEventId: "series1",
      originalStartTime: { dateTime: `${date}T10:00:00-08:00`, timeZone: "America/Los_Angeles" },
      start: { dateTime: `${date}T10:00:00-08:00`, timeZone: "America/Los_Angeles" },
      end: { dateTime: `${date}T10:30:00-08:00`, timeZone: "America/Los_Angeles" },
      ...over,
    });
    for (const d of ["2026-11-02", "2026-11-09", "2026-11-16"]) fake.putEvent(T, MB, MB, instance(d));
    fake.putEvent(T, MB, MB, ev("offsite", { summary: "Offsite", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } }));
    await run();

    const [allDay] = await query<{ ts: string }>(`SELECT timestamp AS ts FROM activity_events WHERE user_id = $1 AND raw_payload ->> 'eventId' = 'offsite'`, [T]);
    expect(new Date(allDay!.ts).toISOString()).toBe("2026-11-20T08:00:00.000Z"); // midnight America/Los_Angeles (PST)

    // Cancel one occurrence (Google's minimal cancelled-instance shape), move another.
    fake.putEvent(T, MB, MB, { id: "series1_20261109T180000Z", status: "cancelled", recurringEventId: "series1", originalStartTime: { dateTime: "2026-11-09T10:00:00-08:00" }, updated: stamp() });
    fake.putEvent(T, MB, MB, instance("2026-11-16", { start: { dateTime: "2026-11-17T10:00:00-08:00" }, end: { dateTime: "2026-11-17T10:30:00-08:00" } }));
    await run();

    const semantic = await query<{ event_type: string; event_id: string }>(
      `SELECT event_type, raw_payload ->> 'eventId' AS event_id FROM activity_events WHERE user_id = $1 AND raw_payload ->> 'kind' = 'calendar_semantic_change' ORDER BY event_type`,
      [T],
    );
    expect(semantic).toEqual([
      { event_type: "calendar_event_cancelled", event_id: "series1_20261109T180000Z" },
      { event_type: "calendar_event_rescheduled", event_id: "series1_20261116T180000Z" },
    ]);
    const published = await exportAll();
    const deletes = published.filter((c) => c.op === "delete" && c.path.includes("/events/")).map((c) => c.path);
    expect(deletes).toEqual([calendarEventPath(MB, MB, "series1_20261109T180000Z")]);
    expect(published.some((c) => c.op === "put" && c.path === calendarEventPath(MB, MB, "series1_20261102T180000Z"))).toBe(true);
    const snap = (await snapshots(T)).find((s) => s.event_id === "series1_20261109T180000Z")!;
    expect(snap.status).toBe("cancelled");
  });
});

describe("expired sync token (410) and removal tombstones", () => {
  beforeEach(async () => {
    fake.pageSize = 50;
  });

  it("re-lists against the kept snapshots and removes only what the full listing no longer returns", async () => {
    for (const id of ["e1", "e2", "e3"]) fake.putEvent(T, MB, MB, ev(id));
    await run();
    await exportAll();
    const before = await snapshots(T);

    fake.purgeEvent(T, MB, MB, "e3"); // deleted and purged while the token was invalid
    fake.putEvent(T, MB, MB, ev("e2", { summary: "Renamed during the gap" }));
    fake.expireEventSyncTokens(T, MB, MB);
    const r = await run();
    expect(r.resets).toBe(1);
    expect(r.eventsRemoved).toBe(1);

    const after = await snapshots(T);
    expect(after.map((s) => s.event_id)).toEqual(["e1", "e2"]);
    // Snapshots were not wiped and rebuilt: identities survive, e1 gained no new revision.
    expect(after.find((s) => s.event_id === "e1")!.id).toBe(before.find((s) => s.event_id === "e1")!.id);
    const revs = await query<{ event_id: string; op: string; reason: string | null }>(
      `SELECT event_id, op, reason FROM google_calendar_event_revisions WHERE tenant_id = $1 ORDER BY id`, [T],
    );
    expect(revs.filter((x) => x.event_id === "e1").map((x) => x.op)).toEqual(["created"]);
    expect(revs.filter((x) => x.event_id === "e2").map((x) => x.op)).toEqual(["created", "updated"]);
    expect(revs.filter((x) => x.event_id === "e3")).toEqual([
      { event_id: "e3", op: "created", reason: null },
      { event_id: "e3", op: "removed", reason: "not_in_full_listing" },
    ]);
    expect((await cursor(T, MB, MB)).sync_token).toMatch(/^ev:/);

    const published = await exportAll();
    const del = published.find((c) => c.op === "delete" && c.path === calendarEventPath(MB, MB, "e3"))!;
    expect(del.reason).toBe("not_in_full_listing");
    expect(published.some((c) => c.op === "delete" && c.path.startsWith("sources/calendar/2") && c.path.includes("meeting-e3"))).toBe(true);
    const removal = published.find((c) => c.op === "put" && c.path.includes("--e3--r") && JSON.parse(inlineText(c)).op === "removed")!;
    expect(JSON.parse(inlineText(removal))).toMatchObject({ reason: "not_in_full_listing", raw_payload: null });
  });

  it("removes a deleted calendar's snapshots but keeps the shared projection while another mailbox still holds the event", async () => {
    const team = { id: "team@group.calendar.google.com", summary: "Team", accessRole: "reader" };
    await connectMailbox(T, MB2);
    fake.putCalendar(T, MB, team);
    fake.putCalendar(T, MB2, team);
    fake.putEvent(T, MB, team.id, ev("standup", { summary: "Standup" }));
    fake.putEvent(T, MB2, team.id, ev("standup", { summary: "Standup" }));
    await run();
    expect((await snapshots(T, MB)).map((s) => s.event_id)).toEqual(["standup"]);
    expect((await snapshots(T, MB2)).map((s) => s.event_id)).toEqual(["standup"]);

    fake.putCalendar(T, MB, { ...team, deleted: true }); // MB unsubscribes
    await run();
    expect(await snapshots(T, MB)).toEqual([]);
    expect((await snapshots(T, MB2)).map((s) => s.event_id)).toEqual(["standup"]);
    expect((await cursor(T, MB, team.id)).calendar_state).toBe("deleted");
    const [mirror] = await query(`SELECT path FROM mirror_files WHERE user_id = $1 AND path LIKE '%standup%'`, [T]);
    expect(mirror).toBeTruthy();
    const [rev] = await query<{ reason: string }>(`SELECT reason FROM google_calendar_event_revisions WHERE tenant_id = $1 AND mailbox = $2 AND op = 'removed'`, [T, MB]);
    expect(rev!.reason).toBe("calendar_deleted");

    const published = await exportAll();
    expect(published.find((c) => c.op === "delete" && c.path === calendarMetaPath(MB, team.id))?.reason).toBe("calendar_deleted");
    expect(published.some((c) => c.op === "put" && c.path === calendarEventPath(MB2, team.id, "standup"))).toBe(true);
    expect(published.some((c) => c.op === "put" && c.path === calendarMetaPath(MB2, team.id))).toBe(true);

    // Downgrading the other mailbox to free/busy removes the last live copy, and with it the projection.
    fake.putCalendar(T, MB2, { ...team, accessRole: "freeBusyReader" });
    await run();
    expect(await snapshots(T, MB2)).toEqual([]);
    expect(await query(`SELECT path FROM mirror_files WHERE user_id = $1 AND path LIKE '%standup%'`, [T])).toEqual([]);
  });
});

describe("per-mailbox auth, quota and retry", () => {
  beforeEach(async () => {
    fake.pageSize = 50;
    await connectMailbox(T, MB2);
    await connectMailbox(T, "cy@acme.test");
    fake.putCalendar(T, MB2, { id: MB2, primary: true, accessRole: "owner" });
    fake.putCalendar(T, "cy@acme.test", { id: "cy@acme.test", primary: true, accessRole: "owner" });
    fake.putEvent(T, MB, MB, ev("a1"));
    fake.putEvent(T, MB2, MB2, ev("b1"));
    fake.putEvent(T, "cy@acme.test", "cy@acme.test", ev("c1"));
  });

  it("isolates a 429 to the mailbox's quota identity, honours Retry-After and keeps the other mailboxes current", async () => {
    let throttled = 0;
    fake.hooks.push(({ account }) => {
      if (account === `${T}:${MB}`) {
        throttled++;
        return json({ error: { code: 429, message: "Rate Limit Exceeded", errors: [{ reason: "rateLimitExceeded" }] } }, 429, { "Retry-After": "120" });
      }
      return undefined;
    });
    const r = await run();
    expect(r.mailboxesRateLimited).toBe(1);
    expect((await snapshots(T, MB2)).map((s) => s.event_id)).toEqual(["b1"]);
    expect((await snapshots(T, "cy@acme.test")).map((s) => s.event_id)).toEqual(["c1"]);
    const [status] = await query(`SELECT * FROM google_source_mailbox_status WHERE tenant_id = $1 AND lane = 'calendar' AND mailbox = $2`, [T, MB]);
    expect(status.state).toBe("rate_limited");
    expect(new Date(status.next_attempt_at).getTime() - Date.now()).toBeGreaterThanOrEqual(119_000);

    // Within the Retry-After window: no request at all for that mailbox; the others still poll.
    const hits = throttled;
    const mark = fake.calls.length;
    await run();
    expect(throttled).toBe(hits);
    expect(fake.calls.slice(mark).some((c) => c.account === `${T}:${MB2}`)).toBe(true);
    // Requests carry the account's quota identity (never the tenant).
    const quotaUsers = new Set(fake.calls.map((c) => c.headers.get("x-goog-quota-user")));
    expect(quotaUsers.size).toBe(3);
    for (const q of quotaUsers) expect(q).toMatch(/^q[0-9a-f]{39}$/);

    const report = (await coverage()).find((x) => x.scope === `mailbox:${MB}`)!;
    expect(report.state).toBe("partial");
    expect(report.reason).toMatch(/rate limited/);
  });

  it("records auth failures per mailbox (never tenant-wide) and the task handler still succeeds", async () => {
    auth.failures.set(`${T}:cy@acme.test`, new GoogleOAuthScopeError("cy@acme.test", ["https://www.googleapis.com/auth/calendar.readonly"]));
    const handler = googleIntegration.taskHandlers!()["calendar.poll"]!;
    const out = await handler({ tenantId: T }, { task: { id: "t1", queue: "sync", tenantId: T } } as never) as Record<string, number>;
    expect(out.mailboxesBlocked).toBe(1);
    expect(syncRuns.finished.at(-1)).toMatchObject({ status: "completed" });
    expect((await snapshots(T, MB)).length).toBe(1);
    expect((await snapshots(T, MB2)).length).toBe(1);
    const reports = await coverage();
    expect(reports.find((x) => x.scope === "mailbox:cy@acme.test")).toMatchObject({ state: "blocked" });
    expect(reports.find((x) => x.scope === "mailbox:cy@acme.test")!.reason).toMatch(/insufficient_scope/);
    expect(reports.find((x) => x.scope === `mailbox:${MB}`)!.state).toBe("complete");
    // OAuth-only tenant: no Workspace directory, so the tenant-wide roster is blocked, not complete.
    expect(reports.find((x) => x.scope === "roster")).toMatchObject({ state: "blocked" });
  });

  it("uses the Workspace directory for DWD tenants and reports a directory failure as partial", async () => {
    auth.delegationConfigured = true;
    await seedDwdAdmin(T, "admin@acme.test");
    fake.directory.set(T, [{ primaryEmail: "dee@acme.test" }, { primaryEmail: "gone@acme.test", suspended: true }]);
    fake.putCalendar(T, "dee@acme.test", { id: "dee@acme.test", primary: true, accessRole: "owner" });
    fake.putCalendar(T, "admin@acme.test", { id: "admin@acme.test", primary: true, accessRole: "owner" });
    const r = await runGoogleCalendarSetup(T);
    expect(r.delegatedUsers).toBe(4); // three connected mailboxes + one active directory user
    expect(auth.scopesSeen.some((s) => s.account === "admin@acme.test" && s.scopes.includes("https://www.googleapis.com/auth/admin.directory.user.readonly"))).toBe(true);
    expect((await coverage()).find((x) => x.scope === "roster")!.state).toBe("complete");

    clearGoogleLaneDirectoryCacheForTests();
    fake.hooks.push(({ url }) => (url.host === "admin.googleapis.com" ? json({ error: { code: 403, message: "Not Authorized" } }, 403) : undefined));
    await run();
    expect((await coverage()).find((x) => x.scope === "roster")!.state).toBe("partial");
  });
});

describe("DWD roster and per-mailbox disconnect (final-audit M1)", () => {
  it("does not re-add a disconnected mailbox from the Workspace directory", async () => {
    auth.delegationConfigured = true;
    await seedDwdAdmin(T, "admin@acme.test");
    fake.directory.set(T, [{ primaryEmail: "dee@acme.test" }, { primaryEmail: "eve@acme.test" }]);
    for (const m of ["dee@acme.test", "eve@acme.test", "admin@acme.test"]) fake.putCalendar(T, m, { id: m, primary: true, accessRole: "owner" });
    await query(`INSERT INTO connections (tenant_id, provider, external_account_id, status, metadata) VALUES ($1, 'google', 'dee@acme.test', 'revoked', '{}'::jsonb)`, [T]);
    auth.scopesSeen.length = 0;
    const r = await runGoogleCalendarSetup(T);
    const scoped = auth.scopesSeen.filter((x) => x.scopes.some((sc) => sc.includes("calendar"))).map((x) => x.account);
    expect(scoped).toContain("eve@acme.test");
    expect(scoped).not.toContain("dee@acme.test");
    expect(r.delegatedUsers).toBe(2); // the DWD admin + eve from the directory, never the disconnected dee
  });
});

describe("tenant isolation", () => {
  it("keeps same-named mailboxes and calendars of two tenants apart (sync, sweep, channels, export)", async () => {
    fake.pageSize = 50;
    await connectMailbox(T2, MB);
    fake.putCalendar(T2, MB, PRIMARY);
    fake.putEvent(T, MB, MB, ev("shared-id", { summary: "Tenant A meeting" }));
    fake.putEvent(T2, MB, MB, ev("shared-id", { summary: "Tenant B meeting" }));
    await run(T);
    await run(T2);

    fake.purgeEvent(T2, MB, MB, "shared-id");
    fake.expireEventSyncTokens(T2, MB, MB);
    await run(T2);
    expect(await snapshots(T2)).toEqual([]);
    expect((await snapshots(T)).map((s) => s.summary)).toEqual(["Tenant A meeting"]);

    const [snapA] = await query<{ id: string }>(`SELECT id::text FROM google_calendar_event_snapshots WHERE user_id = $1`, [T]);
    // The mapper only reads rows of the export context's tenant.
    const mapped = await calendarProvider.extraTables![0]!.map({ tenantId: T2, executor: db as never }, snapA!.id, { op: "UPDATE", enqueuedAt: new Date().toISOString() }, []);
    expect(mapped).toEqual([]);

    const a = await exportAll(T);
    expect(a.some((c) => c.op === "put" && JSON.stringify(c).includes("Tenant B"))).toBe(false);
    expect(a.some((c) => c.op === "put" && c.path === calendarEventPath(MB, MB, "shared-id"))).toBe(true);

    // A push channel of tenant B is never followed by a tenant A run.
    env.WEBHOOK_BASE_URL = "https://hooks.example.test";
    fake.putEvent(T2, MB, MB, ev("b2"));
    await run(T2, { forceFull: true });
    const [channel] = await query<{ channel_id: string }>(`SELECT channel_id FROM google_calendar_watch_channels WHERE user_id = $1 AND resource_type = 'events' AND status = 'active'`, [T2]);
    await expect(run(T, { channelId: channel!.channel_id })).rejects.toThrow(/not found for this tenant/);
  });
});

describe("push channels", () => {
  it("is polling-only without an https WEBHOOK_BASE_URL", async () => {
    fake.putEvent(T, MB, MB, ev("e1"));
    env.WEBHOOK_BASE_URL = "http://insecure.example.test";
    const r = await run();
    expect(r.watchesEnsured).toBe(0);
    expect(fake.calls.some((c) => c.url.pathname.endsWith("/watch"))).toBe(false);
    expect((await coverage()).find((x) => x.scope === "push")).toMatchObject({ state: "partial" });
  });

  it("creates channels, renews inside the 24h window, stops the replaced channel and serves targeted polls", async () => {
    fake.pageSize = 50;
    env.WEBHOOK_BASE_URL = "https://hooks.example.test";
    fake.putEvent(T, MB, MB, ev("e1"));
    const r1 = await run();
    expect(r1.watchesEnsured).toBe(2); // calendar list + primary calendar events
    const watchCall = fake.calls.find((c) => c.url.pathname.endsWith("/events/watch"))!;
    expect(watchCall.body).toMatchObject({ type: "web_hook", address: "https://hooks.example.test/webhooks/google/calendar" });
    const channels = await query(`SELECT * FROM google_calendar_watch_channels WHERE user_id = $1 ORDER BY resource_type`, [T]);
    expect(channels.map((c) => c.status)).toEqual(["active", "active"]);
    expect(channels.every((c) => c.token_hash.length === 64 && c.token_hash !== watchCall.body!.token)).toBe(true);

    // No renewal while far from expiry.
    expect((await run()).watchesEnsured).toBe(0);

    // Expiring within 24h: renewed, and the old channel is stopped at Google.
    const old = channels.find((c) => c.resource_type === "events")!;
    await query(`UPDATE google_calendar_watch_channels SET expiration = now() + interval '2 hours' WHERE channel_id = $1`, [old.channel_id]);
    expect((await run()).watchesEnsured).toBe(1);
    expect(fake.stopped).toEqual([{ id: old.channel_id, resourceId: old.resource_id }]);
    const [oldNow] = await query(`SELECT status FROM google_calendar_watch_channels WHERE channel_id = $1`, [old.channel_id]);
    expect(oldNow!.status).toBe("stopped");

    // A webhook ping triggers a targeted poll of exactly that calendar.
    const [active] = await query<{ channel_id: string }>(`SELECT channel_id FROM google_calendar_watch_channels WHERE user_id = $1 AND resource_type = 'events' AND status = 'active'`, [T]);
    fake.putEvent(T, MB, MB, ev("e2"));
    const mark = fake.calls.length;
    await run(T, { channelId: active!.channel_id });
    const calls = fake.calls.slice(mark);
    expect(calls.some((c) => c.url.pathname.endsWith("/calendarList"))).toBe(false);
    expect(calls.filter((c) => c.url.pathname.endsWith("/events"))).toHaveLength(1);
    expect((await snapshots(T)).map((s) => s.event_id)).toEqual(["e1", "e2"]);

    // Disconnect: every channel stopped at Google.
    const stop = await stopCalendarWatches(T);
    expect(stop.stopped).toBe(2);
    expect((await query(`SELECT status FROM google_calendar_watch_channels WHERE user_id = $1 AND status = 'active'`, [T]))).toEqual([]);
  });

  it("routes a webhook-enqueued calendar.poll to the channel's calendar only (coordinator: patch request 2)", async () => {
    fake.pageSize = 50;
    env.WEBHOOK_BASE_URL = "https://hooks.example.test";
    fake.putEvent(T, MB, MB, ev("e1"));
    await run();
    const [ch] = await query<{ channel_id: string }>(`SELECT channel_id FROM google_calendar_watch_channels WHERE user_id = $1 AND resource_type = 'events' AND status = 'active'`, [T]);
    const handler = googleIntegration.taskHandlers!()["calendar.poll"]!;
    const mark = fake.calls.length;
    await handler({ userId: T, channelId: ch!.channel_id }, { task: { id: "t2", queue: "sync", tenantId: T } } as never);
    expect(fake.calls.slice(mark).some((c) => c.url.pathname.endsWith("/calendarList"))).toBe(false);
    expect(fake.calls.slice(mark).filter((c) => c.url.pathname.endsWith("/events"))).toHaveLength(1);
  });

  it("tenant disconnect stops every push channel at Google (coordinator: patch request 3)", async () => {
    fake.pageSize = 50;
    env.WEBHOOK_BASE_URL = "https://hooks.example.test";
    fake.putEvent(T, MB, MB, ev("e1"));
    await run();
    const active = await query<{ channel_id: string }>(`SELECT channel_id FROM google_calendar_watch_channels WHERE user_id = $1 AND status = 'active'`, [T]);
    expect(active).toHaveLength(2);
    await disconnectAllGoogleAccounts({ tenantId: T });
    expect(fake.stopped.map((x) => x.id).sort()).toEqual(active.map((c) => c.channel_id).sort());
    expect(await query(`SELECT channel_id FROM google_calendar_watch_channels WHERE user_id = $1 AND status = 'active'`, [T])).toEqual([]);
  });

  it("remembers 'push not supported' and keeps syncing by polling", async () => {
    env.WEBHOOK_BASE_URL = "https://hooks.example.test";
    fake.hooks.push(({ url }) => (url.pathname.endsWith("/watch") ? json({ error: { code: 400, message: "Push notifications are not supported by this resource." } }, 400) : undefined));
    fake.putEvent(T, MB, MB, ev("e1"));
    const r = await run();
    expect(r.calendarsSynced).toBe(1);
    const watchAttempts = fake.calls.filter((c) => c.url.pathname.endsWith("/watch")).length;
    await run();
    expect(fake.calls.filter((c) => c.url.pathname.endsWith("/watch")).length).toBe(watchAttempts);
  });
});
