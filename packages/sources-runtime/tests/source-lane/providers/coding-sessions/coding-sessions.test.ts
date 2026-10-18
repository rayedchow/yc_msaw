import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app, db, enroll, fakeAuthority, internal, mintKey, pg, ready, resetTenant, session, wire } from "./harness.js";
import { codingSessionsExport, codingSessionsCoverage } from "../../../../src/integrations/coding-sessions/lane.js";
import { defaultRegistry } from "../../../../src/source-lane/registry.js";

/** Coding-sessions device lane (coordinator port of gigabrain 5448774 coding-sessions ingest/commands). */
const T = "acme";
const T2 = "rival";
const q = async <R = Record<string, unknown>>(s: string, p: unknown[] = []) => (await pg.query<R>(s, p)).rows;

beforeAll(async () => {
  await ready;
});
beforeEach(async () => {
  for (const t of [T, T2]) await resetTenant(t);
  fakeAuthority.revoked.clear();
  fakeAuthority.down = false;
});

describe("coding sessions ingest", () => {
  it("stores sessions under the key's tenant, versions edits immutably, skips unchanged and never truncates text", async () => {
    const d = await enroll(T);
    const long = "x".repeat(30_000);
    const r1 = await wire(app, "POST", "", d.key, { userId: T2, sessions: [session({ agentResponses: [{ order: 1, text: long }] })] });
    expect(await r1.json()).toMatchObject({ stored: 1, updated: 0, skipped: 0 });
    expect(await (await wire(app, "POST", "", d.key, { sessions: [session({ agentResponses: [{ order: 1, text: long }] })] })).json()).toMatchObject({ skipped: 1 });
    await wire(app, "POST", "", d.key, { sessions: [session({ agentResponses: [{ order: 1, text: "edited answer" }] })] });
    const raw = await q<{ source_event_id: string; user_id: string }>(`SELECT source_event_id, user_id FROM activity_events WHERE source = 'sessions' ORDER BY created_at`);
    expect(raw.map((r) => r.user_id)).toEqual([T, T]);
    expect(raw[0]!.source_event_id).toBe("sessions:codex:sess-1");
    expect(raw[1]!.source_event_id).toMatch(/^sessions:codex:sess-1:v:[0-9a-f]{16}$/);
    const [row] = await q<{ version: number; payload: { agentResponses: Array<{ text: string }> } }>(`SELECT version, payload FROM coding_sessions`);
    expect(row!.version).toBe(2);
    const first = await q<{ raw_payload: { agentResponses: Array<{ text: string }> } }>(`SELECT raw_payload FROM activity_events WHERE source_event_id = 'sessions:codex:sess-1'`);
    expect(first[0]!.raw_payload.agentResponses[0]!.text).toHaveLength(30_000);
    expect(await q(`SELECT 1 FROM coding_sessions WHERE tenant_id = $1`, [T2])).toEqual([]);
    // Unknown providers / missing ids are skipped like the donor.
    expect(await (await wire(app, "POST", "", d.key, { sessions: [{ provider: "cursor", sessionId: "x" }, { provider: "claude" }] })).json()).toMatchObject({ skipped: 2 });
  });

  it("fails closed: bad or forged keys 401, authority down 503 with nothing stored, refusal revokes the device", async () => {
    const d = await enroll(T);
    expect((await wire(app, "POST", "", mintKey(T).key, { sessions: [session()] })).status).toBe(401);
    expect((await wire(app, "POST", "", `${d.key.slice(0, -2)}AA`, { sessions: [session()] })).status).toBe(401);
    expect((await wire(app, "POST", "", d.key.replace("gcs_acme", "gcs_rival"), { sessions: [session()] })).status).toBe(401);
    fakeAuthority.down = true;
    expect((await wire(app, "POST", "", d.key, { sessions: [session()] })).status).toBe(503);
    expect(await q(`SELECT 1 FROM coding_sessions`)).toEqual([]);
    fakeAuthority.down = false;
    fakeAuthority.revoked.add(d.bindingId);
    expect((await wire(app, "POST", "", d.key, { sessions: [session()] })).status).toBe(401);
    expect((await q<{ status: string }>(`SELECT status FROM coding_session_devices WHERE binding_id = $1`, [d.bindingId]))[0]!.status).toBe("revoked");
  });

  it("serves the durable command queue: oldest first, ack once, sanitized source_sync receipt drives coverage, revoke cancels", async () => {
    const d = await enroll(T);
    expect((await internal("POST", `/tenants/${T}/devices/coding-sessions/${d.bindingId}/commands`, T, { type: "launch_rockets" })).status).toBe(400);
    expect((await internal("POST", `/tenants/${T}/devices/coding-sessions/${d.bindingId}/commands`, T, { type: "force_rescan" }, ["memory:read"])).status).toBe(403);
    const sync = await (await internal("POST", `/tenants/${T}/devices/coding-sessions/${d.bindingId}/commands`, T, { type: "source_sync", coverageFrom: null })).json() as { id: string };
    await internal("POST", `/tenants/${T}/devices/coding-sessions/${d.bindingId}/commands`, T, { type: "force_rescan" });
    const c1 = (await (await wire(app, "GET", "/command", d.key)).json()) as { command: { id: string; type: string } };
    expect(c1.command).toMatchObject({ id: sync.id, type: "source_sync" });
    expect((await codingSessionsCoverage({ tenantId: T, executor: db as never }))[0]!.state).toBe("partial");
    await wire(app, "POST", "/command/ack", d.key, { id: sync.id, status: "completed", result: { fullInventory: true, exhausted: true, capHit: false, sessionsSeen: "12", pendingUploads: 0, injected: "<script>", agentVersion: "1.2.3" } });
    expect(await (await wire(app, "POST", "/command/ack", d.key, { id: sync.id })).json()).toMatchObject({ ignored: true });
    const [stored] = await q<{ result: Record<string, unknown> }>(`SELECT result FROM coding_session_commands WHERE id = $1`, [sync.id]);
    expect(stored!.result).toMatchObject({ provider: "coding_sessions", sessionsSeen: 12, fullInventory: true, agentVersion: "1.2.3" });
    expect(stored!.result).not.toHaveProperty("injected");
    expect((await codingSessionsCoverage({ tenantId: T, executor: db as never }))[0]!.state).toBe("complete");
    const c2 = (await (await wire(app, "GET", "/command", d.key)).json()) as { command: { type: string } };
    expect(c2.command.type).toBe("force_rescan");
    expect((await internal("DELETE", `/tenants/${T}/devices/coding-sessions/${d.bindingId}`, T)).status).toBe(200);
    expect((await q<{ status: string }>(`SELECT status FROM coding_session_commands WHERE command_type = 'force_rescan'`))[0]!.status).toBe("cancelled");
    expect((await wire(app, "GET", "/command", d.key)).status).toBe(401);
    expect((await codingSessionsCoverage({ tenantId: T, executor: db as never }))[0]!.state).toBe("blocked");
    // Another tenant's principal cannot touch this device.
    expect((await internal("POST", `/tenants/${T2}/devices/coding-sessions/${d.bindingId}/commands`, T2, { type: "force_rescan" })).status).toBe(404);
  });

  it("keeps coverage partial for the bundled Mac agent's capped source_sync receipt (gigabrain@5448774e caps at maxFiles)", async () => {
    const d = await enroll(T);
    const sync = await (await internal("POST", `/tenants/${T}/devices/coding-sessions/${d.bindingId}/commands`, T, { type: "source_sync", coverageFrom: null })).json() as { id: string };
    // Shape the agent actually sends when its source_sync scan hits maxFilesPerProvider (fullInventory = !capped).
    await wire(app, "POST", "/command/ack", d.key, { id: sync.id, status: "completed", result: { receiptVersion: 1, provider: "coding_sessions", fullInventory: false, exhausted: true, capHit: true, maxFilesPerProvider: 1, filesDiscovered: 1, sessionsSeen: 1, pendingUploads: 0, failedUploads: 0 } });
    const [cov] = await codingSessionsCoverage({ tenantId: T, executor: db as never });
    expect(cov!.state).toBe("partial");
  });

  it("exports JSON and a readable transcript per session, registered in the default registry", async () => {
    expect(defaultRegistry().extraTable("coding_sessions")?.provider.id).toBe("coding-sessions");
    const d = await enroll(T);
    await wire(app, "POST", "", d.key, { sessions: [session()] });
    const [{ id }] = await q<{ id: string }>(`SELECT id FROM coding_sessions`);
    const files = await codingSessionsExport.map({ tenantId: T, executor: db as never }, id!, { op: "INSERT", enqueuedAt: new Date().toISOString() }, []);
    expect(files.map((f) => f.path)).toEqual(["sources/coding-sessions/codex/2026-10/sess-1.json", "sources/coding-sessions/codex/2026-10/sess-1.md"]);
    const md = (files[1] as { content: Buffer }).content.toString();
    expect(md).toContain("please fix the flaky test");
    expect(md.indexOf("please fix")).toBeLessThan(md.indexOf("Fixed by awaiting"));
    expect(await codingSessionsExport.map({ tenantId: T2, executor: db as never }, id!, { op: "INSERT", enqueuedAt: new Date().toISOString() }, [])).toEqual([]);
  });
});
