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
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import { runGmailSourceBackfill } from "../../../../src/integrations/gmail/source-sync.js";
import {
  acquireMailboxLease,
  errorBackoffSeconds,
  gmailQuotaKey,
  rateLimitCooldownSeconds,
  releaseMailboxLease,
} from "../../../../src/integrations/gmail/source-quota.js";
import { decideMailboxCoverage } from "../../../../src/source-lane/providers/gmail/coverage.js";
import type { MailboxCounts, MailboxSyncState } from "../../../../src/integrations/gmail/source-store.js";

const MB = "shared@corp.example";
const MB2 = "solo@corp.example";
const T1 = "tenant-q1";
const T2 = "tenant-q2";
let fake: FakeGmail;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetGoogleRateLimitCooldownsForTests();
  fake = new FakeGmail();
  fake.token(`tok:${MB}`, MB);
  fake.token(`tok:${MB2}`, MB2);
  for (const id of ["a1", "a2", "a3"]) fake.addMessage(MB, { id });
  fake.addMessage(MB2, { id: "s1" });
  // Two tenants reach the same mailbox through different upstream credentials (e.g. DWD and OAuth):
  // their quota attribution headers differ, but Gmail charges the same mailbox.
  credentialMock.mockReset().mockImplementation(async (tenant: string, mailbox: string) => ({
    kind: "access_token", accessToken: `tok:${mailbox}`, mode: tenant === T1 ? "domain_wide_delegation" : "oauth_direct", account: mailbox,
    quotaUser: googleQuotaUser(mailbox, tenant === T1 ? "dwd:sa@example.iam" : "oauth:client-1"),
  }));
  vi.stubGlobal("fetch", fake.fetch);
  await connectMailbox(T1, MB);
  await connectMailbox(T1, MB2);
  await connectMailbox(T2, MB);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upstream quota identity", () => {
  it("keys cooldowns by the mailbox (opaque, tenant-independent), not by tenant, connection or credential", () => {
    const k = gmailQuotaKey(MB);
    expect(k).toMatch(/^gm[0-9a-f]{40}$/);
    expect(k).toBe(gmailQuotaKey(" Shared@Corp.Example "));
    expect(k).not.toBe(gmailQuotaKey(MB2));
    expect(k).not.toContain("@");
  });

  it("a 429 seen by one tenant cools the mailbox down for every tenant bound to it, but not other mailboxes", async () => {
    fake.fault(/^\/messages\/a2\?format=full/, 429, { retryAfter: "30" });
    const r1 = await runGmailSourceBackfill(T1, { config: { fetchConcurrency: 1 }, continueWork: false });
    const out = Object.fromEntries(r1.mailboxes.map((m) => [m.mailbox, m.outcome]));
    expect(out).toEqual({ [MB]: "cooldown", [MB2]: "ok" }); // MB2 keeps syncing while MB cools down
    const callsBefore = fake.calls.filter((c) => c.mailbox === MB).length;

    const r2 = await runGmailSourceBackfill(T2, { continueWork: false });
    expect(r2.mailboxes[0]).toMatchObject({ mailbox: MB, outcome: "cooldown" });
    expect(fake.calls.filter((c) => c.mailbox === MB).length).toBe(callsBefore); // zero upstream calls for T2
    expect(credentialMock.mock.calls.filter((c) => c[0] === T2)).toHaveLength(0); // not even a token mint

    // Durable: a fresh process (in-process cooldown map cleared) still honours it.
    resetGoogleRateLimitCooldownsForTests();
    expect((await runGmailSourceBackfill(T2, { continueWork: false })).mailboxes[0]!.outcome).toBe("cooldown");
  });

  it("repeated rate limits back off exponentially above Retry-After; 403 quota reasons count as rate limits", async () => {
    fake.fault(/^\/profile/, 429, { retryAfter: "10" });
    await runGmailSourceBackfill(T1, { mailbox: MB, continueWork: false });
    const [first] = await query<{ secs: number; streak: number }>(`SELECT EXTRACT(EPOCH FROM cooldown_until - now())::int AS secs, rate_limit_streak AS streak FROM gmail_source_quota WHERE quota_key = $1`, [gmailQuotaKey(MB)]);
    expect(first!.streak).toBe(1);
    expect(first!.secs).toBeGreaterThanOrEqual(8);
    expect(first!.secs).toBeLessThanOrEqual(10);

    await query(`UPDATE gmail_source_quota SET cooldown_until = now() - interval '1 second'`);
    resetGoogleRateLimitCooldownsForTests();
    fake.fault(/^\/profile/, 403, { body: { error: { code: 403, message: "User-rate limit exceeded", errors: [{ reason: "userRateLimitExceeded" }] } }, retryAfter: "10" });
    const r = await runGmailSourceBackfill(T1, { mailbox: MB, continueWork: false });
    expect(r.mailboxes[0]!.outcome).toBe("cooldown");
    const [second] = await query<{ secs: number; streak: number }>(`SELECT EXTRACT(EPOCH FROM cooldown_until - now())::int AS secs, rate_limit_streak AS streak FROM gmail_source_quota WHERE quota_key = $1`, [gmailQuotaKey(MB)]);
    expect(second!.streak).toBe(2);
    expect(second!.secs).toBeGreaterThanOrEqual(18); // 10s floor x 2^1

    expect(rateLimitCooldownSeconds(7, 0)).toBe(7);
    expect(rateLimitCooldownSeconds(7, 1)).toBe(14);
    expect(rateLimitCooldownSeconds(120, 5)).toBe(3_600);
    expect(rateLimitCooldownSeconds(900, 0)).toBe(900); // never shorter than Retry-After
    expect(errorBackoffSeconds(1)).toBe(30);
    expect(errorBackoffSeconds(2)).toBe(60);
    expect(errorBackoffSeconds(50)).toBe(1_800);
  });

  it("allows one active sync per mailbox across tenants and workers (lease), then the next tenant proceeds", async () => {
    expect(await acquireMailboxLease(db as never, gmailQuotaKey(MB), "other-worker:tenant-q1", 300)).toBe(true);
    const r = await runGmailSourceBackfill(T2, { continueWork: true });
    expect(r.mailboxes[0]!.outcome).toBe("busy");
    expect(fake.calls).toHaveLength(0);
    const [task] = await query<{ secs: number }>(`SELECT EXTRACT(EPOCH FROM run_at - now())::int AS secs FROM task_queue WHERE tenant_id = $1 AND kind = 'gmail.backfill' AND state = 'queued'`, [T2]);
    expect(task!.secs).toBeGreaterThanOrEqual(25); // retried later, not hot-looped

    await releaseMailboxLease(db as never, gmailQuotaKey(MB), "other-worker:tenant-q1");
    const r2 = await runGmailSourceBackfill(T2, { continueWork: false });
    expect(r2.mailboxes[0]!.outcome).toBe("ok");
    expect(await query(`SELECT lease_owner FROM gmail_source_quota WHERE quota_key = $1`, [gmailQuotaKey(MB)])).toEqual([{ lease_owner: null }]);
  });
});

describe("coverage decisions", () => {
  const counts: MailboxCounts = {
    messages: 10, deleted: 0, pendingFetches: 0, attachmentsStored: 1, attachmentsPending: 0, attachmentsFailed: 0, attachmentsOversize: 0,
    attachmentsUnavailable: 0, rfc822Captured: 10, rfc822Pending: 0, rfc822Failed: 0, rfc822Withheld: 0, rfc822Oversize: 0, rfc822Disabled: 0, historyPages: 2,
  };
  const now = new Date("2026-10-17T12:00:00Z");
  const base: MailboxSyncState = {
    tenantId: "t", mailbox: MB, quotaKey: "k", authMode: "oauth_direct", generation: 2, generationReason: "history_expired",
    generationStartedAt: now, generationStartHistoryId: "500", listIncludeSpamTrash: true, listPageToken: null, listPagesDone: 3, listMessagesSeen: 250,
    listExhaustedAt: now, lastListProgressAt: now, fullCompleteAt: now, fullCompleteGeneration: 2, historyId: "640",
    historyCheckedAt: new Date(now.getTime() - 60_000), historyResets: 1, continuationSeq: 4, blockedCode: null, blockedReason: null,
    lastError: null, lastErrorAt: null, errorStreak: 0, nextAttemptAt: null, lastSuccessAt: now,
  };
  const noQuota = { cooldownUntil: null, rateLimitStreak: 0 };

  it("is complete only for a finished current generation with fresh history and nothing owed", () => {
    expect(decideMailboxCoverage(base, counts, noQuota, { now }).state).toBe("complete");
    expect(decideMailboxCoverage({ ...base, fullCompleteGeneration: 1 }, counts, noQuota, { now })).toMatchObject({ state: "partial" });
    expect(decideMailboxCoverage({ ...base, historyCheckedAt: new Date(now.getTime() - 3_600_000) }, counts, noQuota, { now }).reason).toContain("lagging");
    expect(decideMailboxCoverage(base, { ...counts, pendingFetches: 2 }, noQuota, { now }).state).toBe("partial");
    expect(decideMailboxCoverage(base, { ...counts, attachmentsFailed: 1 }, noQuota, { now }).state).toBe("partial");
    expect(decideMailboxCoverage(base, counts, { cooldownUntil: new Date(now.getTime() + 60_000), rateLimitStreak: 1 }, { now }).reason).toContain("rate limited");
    expect(decideMailboxCoverage({ ...base, errorStreak: 2, lastError: "GmailHttpError: 503" }, counts, noQuota, { now }).state).toBe("partial");
    expect(decideMailboxCoverage({ ...base, blockedCode: "insufficient_scope", blockedReason: "x" }, counts, noQuota, { now }).state).toBe("blocked");
    expect(decideMailboxCoverage(null, counts, noQuota, { now }).state).toBe("pending");
    expect(decideMailboxCoverage(base, { ...counts, rfc822Withheld: 1 }, noQuota, { now })).toMatchObject({ state: "complete" });
  });
});
