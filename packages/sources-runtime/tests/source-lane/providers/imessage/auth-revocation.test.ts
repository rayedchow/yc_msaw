import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bindingTokenForDeviceKey,
  deviceKeyForBindingToken,
  parseDeviceKey,
  sha256Hex,
} from "../../../../src/source-lane/providers/imessage/device-auth.js";
import { app, enroll, events, fakeAuthority, ingest, internal, message, mintBinding, query, ready, resetTenant, SERVICE_TOKEN, wire } from "./harness.js";

/**
 * Device credentials: tenant binding, two-sided verification, cross-tenant denial,
 * no body tenant switch, and revocation that takes effect on the very next request.
 */

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  for (const t of ["acme", "rival"]) await resetTenant(t);
});

describe("device key family", () => {
  it("maps psb_ binding tokens to the uploader's gimsg_ family and back, and nothing else", () => {
    const b = mintBinding("acme");
    expect(b.key.startsWith(`gimsg_acme.${b.bindingId}.`)).toBe(true);
    expect(bindingTokenForDeviceKey(b.key)).toBe(b.bindingToken);
    expect(parseDeviceKey(b.key)).toEqual({ tenantNs: "acme", bindingId: b.bindingId });
    // Donor opaque gimsg_ tokens, other families and malformed shapes are not device keys.
    expect(parseDeviceKey("gimsg_0123456789abcdef0123456789abcdef")).toBeNull();
    expect(parseDeviceKey(b.bindingToken)).toBeNull();
    expect(parseDeviceKey(`${b.key}.extra`)).toBeNull();
    expect(parseDeviceKey(b.key.replace("acme", "ACME"))).toBeNull();
    expect(bindingTokenForDeviceKey("psk_acme.whatever")).toBeNull();
    expect(() => deviceKeyForBindingToken("gimsg_acme.sb-0123456789abcdef.x")).toThrow();
  });
});

describe("enrollment (admin, yc_msaw -> runtime)", () => {
  it("binds a device to the principal's tenant only, stores only the hash, and is idempotent", async () => {
    const b = mintBinding("acme");
    const body = { bindingId: b.bindingId, tokenSha256: sha256Hex(b.key), label: "Ada's Mac", handles: ["+1 (555) 000-2222"] };
    // Wrong tenant in the principal, missing principal, missing service token, missing scope.
    expect((await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "rival", body })).status).toBe(403);
    expect((await internal("POST", `/tenants/acme/devices/imessage`, { body })).status).toBe(403);
    expect((await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "acme", token: null, body })).status).toBe(401);
    // Self-service enrolment (owner-only sources) accepts memory:read; a principal without a source scope is refused.
    expect((await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "acme", scopes: ["integrations:read"], body })).status).toBe(403);

    const first = await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "acme", body });
    expect(first.status).toBe(201);
    const j = (await first.json()) as any;
    expect(j.device).toMatchObject({ tenantId: "acme", bindingId: b.bindingId, status: "active", label: "Ada's Mac", createdBy: { subject: "user_acme" } });
    expect(j.wire.endpoints).toHaveLength(5);
    expect((await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "acme", body })).status).toBe(200);
    // Re-pointing a binding at another credential is refused.
    expect((await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "acme", body: { ...body, tokenSha256: sha256Hex("other") } })).status).toBe(409);

    const stored = await query(`SELECT * FROM imessage_devices WHERE binding_id = $1`, [b.bindingId]);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(b.key.split(".")[2]);
    expect(stored[0]!.token_sha256).toBe(sha256Hex(b.key));
    // The same binding id cannot be enrolled under another tenant with the same credential hash.
    expect((await internal("POST", `/tenants/rival/devices/imessage`, { tenant: "rival", body })).status).toBe(409);
    expect((await (await internal("GET", `/tenants/rival/devices/imessage`, { tenant: "rival" })).json() as any).devices).toEqual([]);
  });

  it("rejects malformed enrollment input", async () => {
    for (const body of [{}, { bindingId: "sb-xyz", tokenSha256: "0".repeat(64) }, { bindingId: "sb-0123456789abcdef", tokenSha256: "ABC" }, "not json{"]) {
      const res = await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "acme", body });
      expect(res.status).toBe(400);
    }
  });
});

describe("uploader wire authentication", () => {
  it("requires a key matching an active device row and yc_msaw's confirmation", async () => {
    const d = await enroll("acme");
    const batch = { messages: [message()] };
    expect((await wire("POST", "", d, batch, { key: null })).status).toBe(401);
    // Right shape, wrong secret.
    const forged = d.key.endsWith("AAAA") ? `${d.key.slice(0, -4)}BBBB` : `${d.key.slice(0, -4)}AAAA`;
    expect((await wire("POST", "", d, batch, { key: forged })).status).toBe(401);
    // The psb_ binding token itself, another tenant in the key, and an unenrolled binding.
    expect((await wire("POST", "", d, batch, { key: d.bindingToken })).status).toBe(401);
    expect((await wire("POST", "", d, batch, { key: d.key.replace("gimsg_acme.", "gimsg_rival.") })).status).toBe(401);
    const other = mintBinding("acme");
    expect((await wire("POST", "", other, batch)).status).toBe(401);
    for (const [method, route] of [["POST", "/sync-contacts"], ["POST", "/local-status"], ["GET", "/command"], ["POST", "/command/ack"]] as const) {
      expect((await wire(method, route, d, method === "GET" ? undefined : {}, { key: forged })).status).toBe(401);
    }
    const calls = fakeAuthority.calls;
    expect((await wire("POST", "", d, batch)).status).toBe(200);
    // yc_msaw is asked on every request (no caching that could outlive a revoke).
    expect((await wire("GET", "/command", d)).status).toBe(200);
    expect(fakeAuthority.calls).toBe(calls + 2);
  });

  it("answers a retryable 503 and stores nothing while yc_msaw cannot confirm the key", async () => {
    const d = await enroll("acme");
    fakeAuthority.down = true;
    try {
      const res = await wire("POST", "", d, { messages: [message()] });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toMatch(/503/u);
      expect((await wire("GET", "/command", d)).status).toBe(503);
    } finally {
      fakeAuthority.down = false;
    }
    expect(await events("acme")).toHaveLength(0);
    expect((await query(`SELECT status FROM imessage_devices WHERE binding_id = $1`, [d.bindingId]))[0]!.status).toBe("active");
  });

  it("serves the wire on the public host only, not under the internal API", async () => {
    const d = await enroll("acme");
    const res = await app.request("/internal/v1/imessage/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": d.key, authorization: `Bearer ${SERVICE_TOKEN}` },
      body: JSON.stringify({ messages: [message()] }),
    });
    expect(res.status).toBe(404);
    expect(await events("acme")).toHaveLength(0);
  });

  it("ignores the donor body userId: a device can only write its own tenant", async () => {
    const d = await enroll("acme");
    await enroll("rival");
    await ingest(d, [message({ rowId: 7 })], { userId: "rival" });
    expect(await events("acme")).toHaveLength(1);
    expect(await events("rival")).toHaveLength(0);
    // Contacts too.
    const res = await wire("POST", "/sync-contacts", d, { userId: "rival", contacts: [{ handle: "+15550001111", name: "Grace" }] });
    expect(res.status).toBe(200);
    expect(await query(`SELECT tenant_id FROM imessage_contacts`)).toEqual([{ tenant_id: "acme" }]);
  });

  it("keeps tenants apart even with identical GUIDs and chats", async () => {
    const a = await enroll("acme");
    const r = await enroll("rival");
    await ingest(a, [message({ text: "acme text" })]);
    await ingest(r, [message({ text: "rival text" })]);
    expect((await events("acme")).map((e) => e.raw_payload.text)).toEqual(["acme text"]);
    expect((await events("rival")).map((e) => e.raw_payload.text)).toEqual(["rival text"]);
    // A device of one tenant cannot read or ack the other's commands.
    const cmd = (await (await internal("POST", `/tenants/rival/devices/imessage/${r.bindingId}/commands`, { tenant: "rival", body: { type: "messages_backfill_reset" } })).json()) as any;
    expect(((await (await wire("GET", "/command", a)).json()) as any).command).toBeNull();
    expect(await (await wire("POST", "/command/ack", a, { id: cmd.command.id })).json()).toEqual({ ok: true, ignored: true });
    expect(((await (await wire("GET", "/command", r)).json()) as any).command.id).toBe(cmd.command.id);
    // Admin routes of one tenant cannot address another tenant's device.
    expect((await internal("DELETE", `/tenants/acme/devices/imessage/${r.bindingId}`, { tenant: "acme" })).status).toBe(404);
    expect((await internal("POST", `/tenants/acme/devices/imessage/${r.bindingId}/commands`, { tenant: "acme", body: {} })).status).toBe(404);
  });
});

describe("revocation", () => {
  it("cuts the device off on the next request after the forwarded revoke, cancels its commands, and keeps what it uploaded", async () => {
    const d = await enroll("acme");
    await ingest(d, [message()]);
    const cmd = (await (await internal("POST", `/tenants/acme/devices/imessage/${d.bindingId}/commands`, { tenant: "acme", body: { type: "messages_source_sync", coverageFrom: null } })).json()) as any;
    expect(cmd.command.sourceSyncRunId).toBeTruthy();

    // Requires a collection-scoped principal of the tenant.
    // Owners revoke their own device (yc_msaw checks ownership); a principal without a source scope may not.
    expect((await internal("DELETE", `/tenants/acme/devices/imessage/${d.bindingId}`, { tenant: "acme", scopes: ["integrations:read"] })).status).toBe(403);
    expect((await internal("DELETE", `/tenants/acme/devices/imessage/${d.bindingId}`, { tenant: "rival" })).status).toBe(403);
    const revoked = await internal("DELETE", `/tenants/acme/devices/imessage/${d.bindingId}`, { tenant: "acme" });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as any).device.status).toBe("revoked");

    // Every wire endpoint refuses the revoked key immediately, although yc_msaw (fake) would still confirm it.
    expect((await wire("POST", "", d, { messages: [message({ rowId: 2, messageId: "GUID-2" })] })).status).toBe(401);
    expect((await wire("POST", "/sync-contacts", d, { contacts: [] })).status).toBe(401);
    expect((await wire("POST", "/local-status", d, { status: {} })).status).toBe(401);
    expect((await wire("GET", "/command", d)).status).toBe(401);
    expect((await wire("POST", "/command/ack", d, { id: cmd.command.id, status: "completed" })).status).toBe(401);
    expect(await events("acme")).toHaveLength(1);

    const [c] = await query(`SELECT status FROM imessage_device_commands WHERE id = $1`, [cmd.command.id]);
    expect(c!.status).toBe("cancelled");
    const [run] = await query(`SELECT status, phase FROM source_sync_runs WHERE id = $1`, [cmd.command.sourceSyncRunId]);
    expect(run).toEqual({ status: "failed", phase: "device_revoked" });

    // Revocation is permanent: re-enrolling the same binding and credential is refused; new commands are refused.
    expect((await internal("POST", `/tenants/acme/devices/imessage`, { tenant: "acme", body: { bindingId: d.bindingId, tokenSha256: sha256Hex(d.key) } })).status).toBe(409);
    expect((await internal("POST", `/tenants/acme/devices/imessage/${d.bindingId}/commands`, { tenant: "acme", body: {} })).status).toBe(409);
    // Idempotent revoke; unknown binding is 404.
    expect((await internal("DELETE", `/tenants/acme/devices/imessage/${d.bindingId}`, { tenant: "acme" })).status).toBe(200);
    expect((await internal("DELETE", `/tenants/acme/devices/imessage/sb-0000000000000000`, { tenant: "acme" })).status).toBe(404);

    const status = (await (await internal("GET", `/tenants/acme/devices/imessage`, { tenant: "acme" })).json()) as any;
    expect(status.coverage.find((r: any) => r.scope === `device:${d.bindingId}:messages`)).toMatchObject({ state: "blocked", counts: { messages: 1 } });
  });

  it("refuses the device as soon as yc_msaw revokes the binding, even if the forwarded revoke was lost, and converges", async () => {
    const d = await enroll("acme");
    await ingest(d, [message()]);
    fakeAuthority.revoked.add(d.bindingId);
    expect((await wire("POST", "", d, { messages: [message({ rowId: 3, messageId: "GUID-3" })] })).status).toBe(401);
    expect(await events("acme")).toHaveLength(1);
    // The runtime revoked its own credential on the refusal; later requests fail at check 1 without asking.
    const [dev] = await query<any>(`SELECT status, revoked_reason FROM imessage_devices WHERE binding_id = $1`, [d.bindingId]);
    expect(dev.status).toBe("revoked");
    expect(dev.revoked_reason).toMatch(/revoked in yc_msaw/u);
    const calls = fakeAuthority.calls;
    expect((await wire("GET", "/command", d)).status).toBe(401);
    expect(fakeAuthority.calls).toBe(calls);
  });
});
