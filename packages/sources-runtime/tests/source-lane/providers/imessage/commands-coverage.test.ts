import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enroll, ingest, internal, message, query, ready, resetTenant, wire, type Enrolled } from "./harness.js";

/**
 * Durable device command queue (GET /command, POST /command/ack), source-sync receipts
 * validated with the donor rules, and the coverage they justify.
 */

const T = "acme";
let d: Enrolled;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetTenant(T);
  d = await enroll(T);
});

async function request(body: unknown, device = d) {
  const res = await internal("POST", `/tenants/${T}/devices/imessage/${device.bindingId}/commands`, { tenant: T, body });
  return { status: res.status, body: (await res.json()) as any };
}

async function next(device = d) {
  return ((await (await wire("GET", "/command", device)).json()) as any).command;
}

async function ack(body: unknown, device = d) {
  const res = await wire("POST", "/command/ack", device, body);
  return { status: res.status, body: (await res.json()) as any };
}

async function coverage() {
  return ((await (await internal("GET", `/tenants/${T}/devices/imessage`, { tenant: T })).json()) as any).coverage as any[];
}

/** The receipt the bundled Mac agent sends (shepherd-onboard messagesSourceSyncReceipt). */
function macReceipt(cmd: any, over: Record<string, unknown> = {}) {
  return {
    receiptVersion: 1,
    sourceSyncRunId: cmd.sourceSyncRunId,
    commandId: cmd.id,
    provider: "imessage",
    deviceId: "11111111-1111-4111-8111-111111111111",
    agentVersion: "0.9.0-test",
    agentChannel: "test",
    coverageFrom: cmd.coverageFrom ?? null,
    coverageTo: cmd.coverageTo,
    highWatermark: "sha256:" + "a".repeat(64),
    exhausted: true,
    capHit: false,
    scannedMessages: 3,
    sentMessages: 3,
    chatsSeen: 1,
    pendingMessages: 0,
    failedMessages: 0,
    queueDepth: 0,
    scopeKind: "selected_chats",
    scopeHash: "sha256:" + "b".repeat(64),
    ...over,
  };
}

describe("command queue", () => {
  it("delivers a backfill reset to its device only, acks exactly once, and supersedes older pending requests", async () => {
    const other = await enroll(T);
    expect((await request({ type: "nope" })).status).toBe(400);
    expect((await request({ backfillDays: 0 })).status).toBe(400);
    const first = await request({ backfillDays: 30 });
    expect(first.status).toBe(201);
    const second = await request({ backfillDays: "all" });
    expect(second.body.superseded).toEqual([first.body.command.id]);

    expect(await next(other)).toBeNull();
    const cmd = await next();
    expect(cmd).toMatchObject({ id: second.body.command.id, type: "messages_backfill_reset", status: "pending", backfillDays: null });

    // Another device of the same tenant cannot ack it; unknown / malformed ids are ignored.
    expect((await ack({ id: cmd.id }, other)).body).toEqual({ ok: true, ignored: true });
    expect((await ack({ id: "00000000-0000-4000-8000-000000000000" })).body).toEqual({ ok: true, ignored: true });
    expect((await ack({ id: "not-a-uuid" })).body).toEqual({ ok: true, ignored: true });
    expect((await ack({})).status).toBe(400);

    const done = await ack({ id: cmd.id, status: "completed", result: { backfillDays: null, resetAt: "2026-09-12T00:00:00Z", token: "secret-should-not-be-kept" } });
    expect(done.body).toMatchObject({ ok: true, command: { id: cmd.id, status: "completed" } });
    expect(JSON.stringify(done.body)).not.toContain("secret-should-not-be-kept");
    // Second ack (agent retry) changes nothing.
    const again = await ack({ id: cmd.id, status: "failed", error: "late" });
    expect(again.body).toMatchObject({ ok: true, ignored: true, command: { status: "completed" } });
    expect(await next()).toBeNull();

    const listed = ((await (await internal("GET", `/tenants/${T}/devices/imessage/${d.bindingId}/commands`, { tenant: T })).json()) as any).commands;
    expect(listed.map((c: any) => c.status)).toEqual(["completed", "superseded"]);
  });
});

describe("source sync receipts and coverage", () => {
  it("is pending before the Mac connects and partial while only uploads exist", async () => {
    expect((await coverage()).find((c) => c.scope === `device:${d.bindingId}:messages`).state).toBe("pending");
    await ingest(d, [message()]);
    const c = await coverage();
    expect(c.find((x) => x.scope === `device:${d.bindingId}:messages`)).toMatchObject({ state: "partial", counts: { messages: 1 } });
    expect(c.find((x) => x.scope === "attachments")).toMatchObject({ state: "partial" });
  });

  it("completes an all-history run only for a valid Mac receipt, and reports complete coverage", async () => {
    await ingest(d, [message()]);
    const req = await request({ type: "messages_source_sync", coverageFrom: null, coverageTo: "2026-09-12T00:00:00.000Z" });
    expect(req.status).toBe(201);
    const cmd = await next();
    expect(cmd).toMatchObject({ type: "messages_source_sync", coverageFrom: null, coverageTo: "2026-09-12T00:00:00.000Z" });
    expect(cmd.sourceSyncRunId).toMatch(/^[0-9a-f-]{36}$/);
    const r = await ack({ id: cmd.id, status: "completed", result: macReceipt(cmd) });
    expect(r.body.run).toMatchObject({ status: "completed", phase: "local_receipt" });
    const [run] = await query<any>(`SELECT status, exhausted, result FROM source_sync_runs WHERE id = $1`, [cmd.sourceSyncRunId]);
    expect(run).toMatchObject({ status: "completed", exhausted: true });
    expect(run.result).toMatchObject({ provider: "imessage", coverageFrom: null, pendingCount: 0, failedCount: 0 });

    await wire("POST", "/local-status", d, { status: { status: "idle", queuedMessages: 0 } });
    expect((await coverage()).find((x) => x.scope === `device:${d.bindingId}:messages`)).toMatchObject({ state: "complete", cursor: "2026-09-12T00:00:00.000Z" });
    // A device that later reports a backlog is no longer complete.
    await wire("POST", "/local-status", d, { status: { status: "running", queuedMessages: 4 } });
    expect((await coverage()).find((x) => x.scope === `device:${d.bindingId}:messages`).state).toBe("partial");
    // The uploader does not await its status posts: a run's "running" arriving after its final "complete" is older
    // (by the uploader's updatedAt) and is not applied, so coverage does not stay partial.
    await wire("POST", "/local-status", d, { status: { status: "complete", queuedMessages: 0, updatedAt: "2026-09-12T00:00:02.000Z" } });
    await wire("POST", "/local-status", d, { status: { status: "running", queuedMessages: 2, updatedAt: "2026-09-12T00:00:01.000Z" } });
    expect((await coverage()).find((x) => x.scope === `device:${d.bindingId}:messages`).state).toBe("complete");
    await wire("POST", "/local-status", d, { status: { status: "running", queuedMessages: 3, updatedAt: "2026-09-12T00:00:03.000Z" } });
    expect((await coverage()).find((x) => x.scope === `device:${d.bindingId}:messages`).state).toBe("partial");
  });

  it("fails the run for receipts that do not prove coverage", async () => {
    await ingest(d, [message()]);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ pendingMessages: 2, exhausted: false }, "local source did not report exhausted=true"],
      [{ failedMessages: 1 }, "local source has 1 failed item(s)"],
      [{ coverageFrom: "2026-01-01T00:00:00.000Z" }, "receipt coverageFrom is bounded but the run requested all history"],
      [{ coverageTo: "2026-09-01T00:00:00.000Z" }, "receipt coverageTo does not cover requested cutoff"],
      [{ sourceSyncRunId: "00000000-0000-4000-8000-000000000000" }, "receipt sourceSyncRunId does not match source sync run"],
    ];
    for (const [over, reason] of cases) {
      await request({ type: "messages_source_sync", coverageFrom: null, coverageTo: "2026-09-12T00:00:00.000Z" });
      const cmd = await next();
      const r = await ack({ id: cmd.id, status: "completed", result: macReceipt(cmd, over) });
      expect(r.body.run).toMatchObject({ status: "failed", phase: "invalid_local_receipt", reason });
    }
    // A failed ack from the Mac fails the run with its (sanitized) error.
    await request({ type: "messages_source_sync", coverageFrom: null });
    const cmd = await next();
    const r = await ack({ id: cmd.id, status: "failed", error: "Full Disk Access denied for /Users/someone/Library/Messages/chat.db" });
    expect(r.body.run).toMatchObject({ status: "failed", phase: "observer_failed" });
    const cov = (await coverage()).find((x) => x.scope === `device:${d.bindingId}:messages`);
    expect(cov.state).toBe("partial");
    expect(cov.reason).toContain("latest all-history source sync failed");
  });

  it("treats a bounded receipt as partial coverage", async () => {
    await ingest(d, [message()]);
    await request({ type: "messages_source_sync", coverageFrom: "2026-09-01T00:00:00.000Z", coverageTo: "2026-09-12T00:00:00.000Z" });
    const cmd = await next();
    expect((await ack({ id: cmd.id, status: "completed", result: macReceipt(cmd) })).body.run.status).toBe("completed");
    const cov = (await coverage()).find((x) => x.scope === `device:${d.bindingId}:messages`);
    expect(cov.state).toBe("partial");
    expect(cov.reason).toContain("only a bounded source sync receipt");
  });
});
