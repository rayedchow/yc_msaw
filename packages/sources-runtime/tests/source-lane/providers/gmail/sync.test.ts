import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
const credentialMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/vault/google-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/vault/google-auth.js")>()),
  getGoogleApiCredential: credentialMock,
}));

import { connectMailbox, db, query, ready, resetAll } from "./harness.js";
import { FakeGmail } from "./fake-gmail.js";
import { googleQuotaUser } from "../../../../src/vault/google-auth.js";
import { GoogleOAuthReauthRequiredError } from "../../../../src/vault/google-oauth.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import { runGmailSourceBackfill, runGmailSourcePoll } from "../../../../src/integrations/gmail/source-sync.js";
import { runGmailBackfill, runGmailPoll } from "../../../../src/integrations/gmail/jobs.js";
import { getSyncState } from "../../../../src/integrations/gmail/source-store.js";
import { gmailQuotaKey } from "../../../../src/integrations/gmail/source-quota.js";
import { gmailCoverage } from "../../../../src/source-lane/providers/gmail/coverage.js";

const T = "tenant-gm";
const MB = "ada@corp.example";
let fake: FakeGmail;

function credentialFor(_tenant: string, mailbox: string) {
  return { kind: "access_token", accessToken: `tok:${mailbox}`, mode: "domain_wide_delegation", account: mailbox, quotaUser: googleQuotaUser(mailbox, "dwd:test-sa@example.iam") };
}

async function messages(tenant = T, mailbox = MB) {
  return query<{ message_id: string; label_ids: string[]; label_history_id: string | null; deleted_reason: string | null; rfc822_status: string; seen_generation: number }>(
    `SELECT message_id, label_ids, label_history_id::text AS label_history_id, deleted_reason, rfc822_status, seen_generation
     FROM gmail_source_messages WHERE tenant_id = $1 AND mailbox = $2 ORDER BY message_id`,
    [tenant, mailbox],
  );
}

async function state(tenant = T, mailbox = MB) {
  return (await getSyncState(db as never, tenant, mailbox))!;
}

/** Drive gmail.backfill continuations the way the worker would (until no queued gmail.backfill remains). */
async function runQueuedBackfills(config: Record<string, number | boolean> = {}, max = 30): Promise<number> {
  let runs = 0;
  for (; runs < max; runs++) {
    const [task] = await query<{ id: string; payload: { mailbox?: string } }>(
      `SELECT id, payload FROM task_queue WHERE tenant_id = $1 AND kind = 'gmail.backfill' AND state = 'queued' ORDER BY created_at LIMIT 1`,
      [T],
    );
    if (!task) break;
    await query(`UPDATE task_queue SET state = 'running' WHERE id = $1`, [task.id]);
    await runGmailSourceBackfill(T, { ...(task.payload.mailbox ? { mailbox: task.payload.mailbox } : {}), config });
    await query(`UPDATE task_queue SET state = 'succeeded' WHERE id = $1`, [task.id]);
  }
  return runs;
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetGoogleRateLimitCooldownsForTests();
  fake = new FakeGmail();
  fake.token(`tok:${MB}`, MB);
  credentialMock.mockReset().mockImplementation(async (tenant: string, mailbox: string) => credentialFor(tenant, mailbox));
  vi.stubGlobal("fetch", fake.fetch);
  await connectMailbox(T, MB);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seed(n: number, mailbox = MB) {
  for (let i = 1; i <= n; i++) {
    fake.addMessage(mailbox, { id: `m${String(i).padStart(2, "0")}`, date: new Date(Date.UTC(2026, 0, i, 9)), subject: `Hello ${i}` });
  }
}

describe("full mailbox capture (no bounded bootstrap)", () => {
  it("captures every message across many pages with bounded runs, durable page checkpoints and continuation tasks", async () => {
    seed(7);
    fake.pageSize = 2;
    const h0 = fake.mailbox(MB).historyId;

    // The legacy connect payload (30 days / 500 messages) no longer bounds anything.
    const first = await runGmailBackfill(T, { days: 30, maxMessages: 500 });
    expect(first.capHit).toBe(false);
    const s1 = await state();
    expect(s1.generation).toBe(1);
    expect(s1.generationStartHistoryId).toBe(String(h0)); // read BEFORE listing
    expect(s1.historyId).toBe(String(h0));
    expect(first.exhausted).toBe(true); // default budget covers 7 messages

    await resetAll();
    await connectMailbox(T, MB);
    fake.calls.length = 0;
    // Small per-run budget: 3 message fetches per run.
    const r1 = await runGmailSourceBackfill(T, { config: { backfillMaxMessages: 3, fetchConcurrency: 1 } });
    expect(r1.exhausted).toBe(false);
    expect(r1.stored).toBe(3);
    const mid = await state();
    expect(mid.listPagesDone).toBe(1); // page 2 was cut by the budget: its token is NOT advanced
    expect(mid.listPageToken).toBe("2");
    expect(mid.fullCompleteGeneration).toBeNull();
    const queued = await query<{ dedupe_key: string; payload: Record<string, unknown> }>(`SELECT dedupe_key, payload FROM task_queue WHERE kind = 'gmail.backfill' AND state = 'queued'`);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ mailbox: MB, mode: "full" });

    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]).toMatchObject({ scope: `mailbox:${MB}`, state: "partial" });
    expect(cov[0]!.reason).toContain("initial full capture in progress");

    const runs = await runQueuedBackfills({ backfillMaxMessages: 3, fetchConcurrency: 1 });
    expect(runs).toBeGreaterThanOrEqual(2);
    const done = await state();
    expect(done.fullCompleteGeneration).toBe(1);
    expect((await messages()).map((m) => m.message_id)).toEqual(["m01", "m02", "m03", "m04", "m05", "m06", "m07"]);
    // Each message fetched exactly once in full even though page 2 was replayed.
    for (const id of ["m01", "m04", "m07"]) expect(fake.callsTo(new RegExp(`^/messages/${id}\\?format=full`))).toBe(1);
    // Completed mailboxes stop the continuation chain.
    expect(await query(`SELECT 1 FROM task_queue WHERE kind = 'gmail.backfill' AND state = 'queued'`)).toHaveLength(0);
  });

  it("captures mail that arrives while the listing is in progress (history from the pre-listing historyId)", async () => {
    seed(4);
    fake.pageSize = 2;
    await runGmailSourceBackfill(T, { config: { backfillMaxMessages: 2, fetchConcurrency: 1 }, continueWork: false });
    // New mail lands on page 1, which the listing already passed.
    fake.addMessage(MB, { id: "m99", date: new Date(Date.UTC(2026, 5, 1)), subject: "late arrival" });
    await runGmailSourcePoll(T, { continueWork: false });
    expect((await messages()).map((m) => m.message_id)).toContain("m99");
    await runGmailSourceBackfill(T, { continueWork: false });
    expect((await messages()).map((m) => m.message_id)).toEqual(["m01", "m02", "m03", "m04", "m99"]);
    expect((await state()).fullCompleteGeneration).toBe(1);
    expect(fake.callsTo(/^\/messages\/m99\?format=full/)).toBe(1); // history + listing overlap fetched once
  });

  it("starts capture for a rostered mailbox that never had a cursor (poll bootstraps and arms the backfill chain)", async () => {
    seed(2);
    const r = await runGmailPoll(T);
    expect(r.mailboxes[0]).toMatchObject({ mailbox: MB, outcome: "ok", generation: 1 });
    const queued = await query<{ payload: Record<string, unknown> }>(`SELECT payload FROM task_queue WHERE kind = 'gmail.backfill' AND state = 'queued'`);
    expect(queued).toHaveLength(1);
    await runQueuedBackfills();
    expect((await state()).fullCompleteGeneration).toBe(1);
    // A poll while a chain is queued/running does not start a second chain.
    fake.addMessage(MB, { id: "m50" });
    await query(`INSERT INTO task_queue (queue, tenant_id, group_key, kind, payload, state) VALUES ('backfill', $1, $2, 'gmail.backfill', $3::jsonb, 'running')`, [T, `${T}:gmail`, JSON.stringify({ mailbox: MB })]);
    await runGmailPoll(T);
    expect(await query(`SELECT 1 FROM task_queue WHERE kind = 'gmail.backfill' AND state = 'queued'`)).toHaveLength(0);
  });
});

describe("interruption, rate limits and errors", () => {
  it("stops at a 429 without advancing the page checkpoint, persists the Retry-After cooldown per mailbox, then resumes without duplicates", async () => {
    seed(5);
    fake.pageSize = 5;
    fake.fault(/^\/messages\/m03\?format=full/, 429, { retryAfter: "7" });
    const r1 = await runGmailSourceBackfill(T, { config: { fetchConcurrency: 1 } });
    expect(r1.mailboxes[0]!.outcome).toBe("cooldown");
    const s = await state();
    expect(s.listPagesDone).toBe(0);
    expect(s.listPageToken).toBeNull();
    const [q] = await query<{ cooldown_until: Date; last_retry_after_seconds: number; rate_limit_streak: number }>(
      `SELECT cooldown_until, last_retry_after_seconds, rate_limit_streak FROM gmail_source_quota WHERE quota_key = $1`,
      [gmailQuotaKey(MB)],
    );
    expect(q!.last_retry_after_seconds).toBe(7);
    expect(new Date(q!.cooldown_until).getTime() - Date.now()).toBeGreaterThan(5_000);
    // The continuation is scheduled at the cooldown end, not immediately.
    const [task] = await query<{ run_at: Date }>(`SELECT run_at FROM task_queue WHERE kind = 'gmail.backfill' AND state = 'queued'`);
    expect(new Date(task!.run_at).getTime()).toBeGreaterThanOrEqual(new Date(q!.cooldown_until).getTime() - 1);

    // During the cooldown nothing is sent upstream.
    const before = fake.calls.length;
    const r2 = await runGmailSourceBackfill(T, { continueWork: false });
    expect(r2.mailboxes[0]!.outcome).toBe("cooldown");
    expect(fake.calls.length).toBe(before);

    // Cooldown over (simulated): resume, and nothing is fetched twice.
    await query(`UPDATE gmail_source_quota SET cooldown_until = now() - interval '1 second'`);
    resetGoogleRateLimitCooldownsForTests();
    const r3 = await runGmailSourceBackfill(T, { continueWork: false });
    expect(r3.mailboxes[0]!.outcome).toBe("ok");
    expect((await messages()).map((m) => m.message_id)).toEqual(["m01", "m02", "m03", "m04", "m05"]);
    expect(fake.callsTo(/^\/messages\/m05\?format=full/)).toBe(1);
    expect(fake.callsTo(/^\/messages\/m03\?format=full/)).toBe(2); // the rate-limited attempt + the retry
    expect((await query<{ rate_limit_streak: number }>(`SELECT rate_limit_streak FROM gmail_source_quota`))[0]!.rate_limit_streak).toBe(0);
    // Quota attribution header is the opaque credential quotaUser, never the address.
    expect(fake.calls.every((c) => c.quotaUser && /^q[0-9a-f]{39}$/.test(c.quotaUser) && !c.quotaUser.includes("@"))).toBe(true);
  });

  it("backs off after a server error and resumes from the durable checkpoint; a permanently failing message never pins the history cursor", async () => {
    seed(3);
    fake.fault(/^\/messages\?/, 503, { times: 1 });
    const r1 = await runGmailSourceBackfill(T, { continueWork: false });
    expect(r1.mailboxes[0]!.outcome).toBe("error");
    const s1 = await state();
    expect(s1.errorStreak).toBe(1);
    expect(s1.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await runGmailSourceBackfill(T, { continueWork: false })).mailboxes[0]!.outcome).toBe("backoff");
    await query(`UPDATE gmail_source_sync_state SET next_attempt_at = now() - interval '1 second'`);

    // m02 keeps failing with 500: it is queued for retry, the listing and history keep moving.
    fake.fault(/^\/messages\/m02\?format=full/, 500, { times: 100 });
    await runGmailSourceBackfill(T, { continueWork: false });
    const s2 = await state();
    expect(s2.listExhaustedAt).not.toBeNull();
    expect(s2.fullCompleteGeneration).toBeNull(); // incomplete while a fetch is owed
    expect(await query(`SELECT message_id FROM gmail_source_pending`)).toEqual([{ message_id: "m02" }]);
    fake.addMessage(MB, { id: "m10", date: new Date(Date.UTC(2026, 3, 1)) });
    const h = fake.mailbox(MB).historyId;
    await runGmailSourcePoll(T, { continueWork: false });
    expect((await state()).historyId).toBe(String(h));
    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]!.state).toBe("partial");
    expect(cov[0]!.reason).toContain("1 message fetches failed");

    // Upstream recovers: the retry lands and the generation completes.
    fake.faults = [];
    await query(`UPDATE gmail_source_pending SET next_attempt_at = now()`);
    await runGmailSourcePoll(T, { continueWork: false });
    expect(await query(`SELECT 1 FROM gmail_source_pending`)).toHaveLength(0);
    expect((await state()).fullCompleteGeneration).toBe(1);
  });
});

describe("owed bytes", () => {
  it("retries a failed attachment from gmail.poll with backoff (fresh attachment ids), without a looping backfill chain", async () => {
    fake.addMessage(MB, { id: "a1", attachments: [{ filename: "deck.pdf", mimeType: "application/pdf", bytes: Buffer.from([0, 1, 2, 255]) }] });
    fake.fault(/^\/messages\/a1\/attachments\//, 500, { times: 1 });
    await runGmailSourceBackfill(T);
    const [att] = await query<{ status: string; attempts: number; secs: number }>(`SELECT status, attempts, EXTRACT(EPOCH FROM next_attempt_at - now())::int AS secs FROM gmail_source_attachments`);
    expect(att).toMatchObject({ status: "failed", attempts: 1 });
    expect(att!.secs).toBeGreaterThan(200);
    expect((await state()).fullCompleteGeneration).toBe(1);
    expect(await query(`SELECT 1 FROM task_queue WHERE kind = 'gmail.backfill' AND state = 'queued'`)).toHaveLength(0);
    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]!.state).toBe("partial");
    expect(cov[0]!.reason).toContain("1 attachment byte captures pending/failed");

    await runGmailSourcePoll(T); // not due yet: no attachment call
    expect(fake.callsTo(/\/attachments\//)).toBe(1);
    await query(`UPDATE gmail_source_attachments SET next_attempt_at = now()`);
    await runGmailSourcePoll(T);
    const [after] = await query<{ status: string; size: string }>(`SELECT status, size::text AS size FROM gmail_source_attachments`);
    expect(after).toEqual({ status: "stored", size: "4" });
    expect(fake.callsTo(/^\/messages\/a1\?format=full/)).toBe(2); // re-fetched for current attachment ids
    expect((await gmailCoverage({ tenantId: T, executor: db as never }))[0]!.state).toBe("complete");
  });
});

describe("history deltas", () => {
  it("applies labels and deletions, ignores replayed records, and tombstones unknown deletions against stale fetches", async () => {
    seed(3);
    await runGmailSourceBackfill(T, { continueWork: false });
    const m1 = (await messages()).find((m) => m.message_id === "m01")!;
    const fetchedAt = BigInt(m1.label_history_id!);

    fake.removeLabels(MB, "m01", ["UNREAD"]);
    fake.addLabels(MB, "m02", ["STARRED"]);
    fake.removeLabels(MB, "m02", ["INBOX"]); // archive
    fake.deleteMessage(MB, "m03");
    // A deletion for a message we never captured.
    fake.injectHistory(MB, { id: String(fake.mailbox(MB).historyId + 1), messagesDeleted: [{ message: { id: "ghost", threadId: "t-ghost" } }] });
    fake.mailbox(MB).historyId += 1;

    const r = await runGmailSourcePoll(T, { continueWork: false });
    expect(r.mailboxes[0]).toMatchObject({ outcome: "ok", deletions: 1 });
    const rows = await messages();
    expect(rows.find((m) => m.message_id === "m01")!.label_ids).toEqual(["INBOX"]);
    expect(rows.find((m) => m.message_id === "m02")!.label_ids).toEqual(["STARRED", "UNREAD"]);
    expect(rows.find((m) => m.message_id === "m03")!.deleted_reason).toBe("provider_deleted");
    expect(rows.find((m) => m.message_id === "ghost")!.deleted_reason).toBe("provider_deleted");
    expect((await state()).historyId).toBe(String(fake.mailbox(MB).historyId));
    expect(await query(`SELECT count(*)::int AS n FROM gmail_source_history_pages`)).toEqual([{ n: 1 }]);

    // Replaying the same history (cursor rewound) changes nothing.
    const snapshot = JSON.stringify(await messages());
    await query(`UPDATE gmail_source_sync_state SET history_id = $1::numeric`, [String(fetchedAt - 2n)]);
    await runGmailSourcePoll(T, { continueWork: false });
    expect(JSON.stringify(await messages())).toBe(snapshot);

    // A stale observation of the deleted ghost (lower historyId) cannot resurrect it.
    const { upsertFetchedMessage } = await import("../../../../src/integrations/gmail/source-store.js");
    const res = await upsertFetchedMessage(db as never, T, MB, {
      messageId: "ghost", threadId: "t-ghost", internalDate: null, sizeEstimate: 1, historyId: "1", rawJson: "{}", redactionApplied: false, labelIds: ["INBOX"], rfc822Status: "pending", seenGeneration: 1,
    });
    expect(res).toEqual({ capturedRaw: false, deleted: true });
  });

  it("never regresses labels when history older than an already-fetched message state arrives (page by page)", async () => {
    seed(2);
    await runGmailSourceBackfill(T, { continueWork: false });
    // Two label changes after the cursor; a later observation (e.g. a re-sync refresh) already saw the final state.
    fake.addLabels(MB, "m01", ["STARRED"]);
    const final = fake.removeLabels(MB, "m01", ["STARRED"]);
    const { refreshFromMinimal } = await import("../../../../src/integrations/gmail/source-store.js");
    await refreshFromMinimal(db as never, T, MB, { messageId: "m01", historyId: String(final), labelIds: ["INBOX", "UNREAD"], generation: 1 });
    // History is delivered one record per page, one page per run: the older "STARRED added" record arrives alone.
    fake.historyPageSize = 1;
    await runGmailSourcePoll(T, { config: { historyMaxPages: 1 }, continueWork: false });
    const after1 = (await messages()).find((m) => m.message_id === "m01")!;
    expect(after1.label_ids).toEqual(["INBOX", "UNREAD"]); // not ["INBOX", "STARRED", "UNREAD"]
    expect(after1.label_history_id).toBe(String(final));
    await runGmailSourcePoll(T, { config: { historyMaxPages: 1 }, continueWork: false });
    expect((await messages()).find((m) => m.message_id === "m01")!.label_ids).toEqual(["INBOX", "UNREAD"]);
    expect((await state()).historyId).toBe(String(final));
  });

  it("fetches unknown messages named by label records (e.g. restored from Trash when Trash is not listed)", async () => {
    seed(1);
    fake.addMessage(MB, { id: "trashed", labels: ["TRASH"], date: new Date(Date.UTC(2026, 0, 5)) });
    await runGmailSourceBackfill(T, { config: { includeSpamTrash: false }, continueWork: false });
    expect((await messages()).map((m) => m.message_id)).toEqual(["m01"]);
    fake.removeLabels(MB, "trashed", ["TRASH"]);
    await runGmailSourcePoll(T, { config: { includeSpamTrash: false }, continueWork: false });
    expect((await messages()).map((m) => m.message_id)).toEqual(["m01", "trashed"]);
    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]!.state).toBe("partial"); // this generation listed without Spam/Trash: never complete
    expect(cov[0]!.reason).toContain("without SPAM and TRASH");
  });

  it("history 404 starts a full re-sync generation: no cursor jump, gap labels re-verified, gap deletions swept, new mail captured", async () => {
    seed(4);
    await runGmailSourceBackfill(T, { continueWork: false });
    await runGmailSourcePoll(T, { continueWork: false });
    expect((await state()).fullCompleteGeneration).toBe(1);
    expect((await gmailCoverage({ tenantId: T, executor: db as never }))[0]!.state).toBe("complete");

    // Changes inside a gap whose history records are gone.
    fake.addLabels(MB, "m01", ["STARRED"]);
    fake.deleteMessage(MB, "m02");
    fake.addMessage(MB, { id: "m77", date: new Date(Date.UTC(2026, 2, 1)) });
    fake.expireHistory(MB);
    const newH0 = fake.mailbox(MB).historyId;

    const poll = await runGmailSourcePoll(T, { continueWork: false });
    expect(poll.mailboxes[0]).toMatchObject({ historyReset: true, generation: 2, complete: false });
    const s = await state();
    expect(s.generationReason).toBe("history_expired");
    expect(s.generationStartHistoryId).toBe(String(newH0));
    expect(s.historyId).toBe(String(newH0));
    expect(s.fullCompleteGeneration).toBe(1); // generation 2 is NOT complete
    expect(s.historyResets).toBe(1);
    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]!.state).toBe("partial");
    expect(cov[0]!.reason).toContain("history cursor expired");

    await runGmailSourceBackfill(T, { continueWork: false });
    const rows = await messages();
    expect(rows.find((m) => m.message_id === "m01")!.label_ids).toContain("STARRED"); // re-verified (format=minimal)
    expect(rows.find((m) => m.message_id === "m02")!.deleted_reason).toBe("absent_from_listing");
    expect(rows.find((m) => m.message_id === "m77")).toBeTruthy();
    expect(fake.callsTo(/^\/messages\/m01\?format=minimal/)).toBe(1);
    expect(fake.callsTo(/^\/messages\/m03\?format=full/)).toBe(1); // not re-downloaded
    const done = await state();
    expect(done.fullCompleteGeneration).toBe(2);
  });
});

describe("mailbox isolation", () => {
  it("a blocked mailbox does not stop other mailboxes and is reported blocked; identity mismatches store nothing", async () => {
    const other = "bob@corp.example";
    const wrong = "eve@corp.example";
    await connectMailbox(T, other);
    await connectMailbox(T, wrong);
    fake.token(`tok:${other}`, other);
    fake.token(`tok:${wrong}`, "mallory@corp.example"); // credential reaches a different mailbox
    seed(2);
    fake.addMessage(other, { id: "b1" });
    fake.addMessage("mallory@corp.example", { id: "x1" });
    credentialMock.mockImplementation(async (tenant: string, mailbox: string) => {
      if (mailbox === other) throw new GoogleOAuthReauthRequiredError(other, "invalid_grant");
      return credentialFor(tenant, mailbox);
    });
    const r = await runGmailSourceBackfill(T, { continueWork: false });
    const byMailbox = Object.fromEntries(r.mailboxes.map((m) => [m.mailbox, m.outcome]));
    expect(byMailbox).toEqual({ [MB]: "ok", [other]: "blocked", [wrong]: "blocked" });
    expect(await query(`SELECT DISTINCT mailbox FROM gmail_source_messages`)).toEqual([{ mailbox: MB }]);
    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    const scopes = Object.fromEntries(cov.map((c) => [c.scope, c]));
    expect(scopes[`mailbox:${other}`]!.state).toBe("blocked");
    expect(scopes[`mailbox:${other}`]!.reason).toContain("reauth_required");
    expect(scopes[`mailbox:${wrong}`]!.reason).toContain("mailbox_identity_mismatch");
    // Blocked mailboxes are retried only after the blocked backoff.
    const calls = credentialMock.mock.calls.length;
    await runGmailSourcePoll(T, { continueWork: false });
    expect(credentialMock.mock.calls.filter((c) => c[1] === other)).toHaveLength(1);
    expect(credentialMock.mock.calls.length).toBe(calls + 1);
  });

  it("reports a non-quota 403 from Gmail as blocked (not a transient error) and recovers when access returns", async () => {
    seed(1);
    fake.fault(/^\/profile/, 403, { body: { error: { code: 403, message: "Gmail API has not been used in project 1 before or it is disabled.", errors: [{ reason: "accessNotConfigured" }] } } });
    const r = await runGmailSourceBackfill(T, { continueWork: false });
    expect(r.mailboxes[0]!.outcome).toBe("blocked");
    const cov = await gmailCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]).toMatchObject({ state: "blocked" });
    expect(cov[0]!.reason).toContain("gmail_forbidden:accessNotConfigured");
    await query(`UPDATE gmail_source_sync_state SET next_attempt_at = now() - interval '1 second'`);
    await runGmailSourceBackfill(T, { continueWork: false });
    expect((await state()).blockedCode).toBeNull();
    expect((await state()).fullCompleteGeneration).toBe(1);
  });

  it("only the tenant's own roster is synced; a task payload naming another mailbox is ignored", async () => {
    fake.token("tok:intruder@corp.example", "intruder@corp.example");
    fake.addMessage("intruder@corp.example", { id: "i1" });
    seed(1);
    const r = await runGmailBackfill(T, { mailbox: "intruder@corp.example" });
    expect(r.mailboxes).toEqual([]);
    expect(credentialMock).not.toHaveBeenCalled();
    expect(await query(`SELECT 1 FROM gmail_source_messages`)).toHaveLength(0);
  });
});
