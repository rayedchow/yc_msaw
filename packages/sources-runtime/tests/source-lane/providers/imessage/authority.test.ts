import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { setTenantBinding } from "../../../../src/source-lane/export/bindings.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { createBindingAuthority } from "../../../../src/source-lane/providers/imessage/authority.js";
import { db, enroll, events, message, mintBinding, providerWithBindingAuthority, query, ready, resetTenant, wire } from "./harness.js";

/**
 * The production device-key authority: yc_msaw at the tenant binding's publish URL, asked per
 * request with the device's own key. A loopback server stands in for yc_msaw's verify route.
 */

const T = "acme";
let yc: Server;
let ycBase: string;
let seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
let answer: (key: string) => { status: number; body?: unknown } = () => ({ status: 401 });

beforeAll(async () => {
  await ready;
  yc = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const a = answer(String(req.headers["x-api-key"] ?? ""));
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.body ?? {}));
  });
  await new Promise<void>((r) => yc.listen(0, "127.0.0.1", r));
  ycBase = `http://127.0.0.1:${(yc.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => yc?.close(r));
});

beforeEach(async () => {
  await resetTenant(T);
  seen = [];
});

async function bindTenant(): Promise<void> {
  const b = mintBinding(T);
  await setTenantBinding(db as never, { tenantId: T, bindingId: b.bindingId, token: b.bindingToken, publishUrl: ycBase, providers: ["*"] });
}

describe("createBindingAuthority", () => {
  const device = { tenantNs: T, bindingId: "sb-0123456789abcdef" };
  const key = `gimsg_${T}.sb-0123456789abcdef.${"A".repeat(43)}`;

  it("is unavailable (fail closed) when the tenant has no binding", async () => {
    expect(await createBindingAuthority(db as never).verify(key, device)).toMatchObject({ state: "unavailable" });
    expect(seen).toHaveLength(0);
  });

  it("asks yc_msaw at the binding's publish URL with the key only, and maps its answers", async () => {
    await bindTenant();
    const authority = createBindingAuthority(db as never);
    answer = () => ({ status: 200, body: { tenantNs: T, bindingId: device.bindingId, provider: "imessage" } });
    expect(await authority.verify(key, device)).toEqual({ state: "active" });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/v1/sources/devices/imessage/verify" });
    expect(seen[0]!.headers["x-api-key"]).toBe(key);
    // No JSON content type on the request (yc_msaw's HTTP layer would try to parse an empty body).
    expect(seen[0]!.headers["content-type"]).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBeUndefined();

    answer = () => ({ status: 200, body: { tenantNs: "rival", bindingId: device.bindingId, provider: "imessage" } });
    expect(await authority.verify(key, device)).toMatchObject({ state: "revoked" });
    for (const status of [401, 403, 404]) {
      answer = () => ({ status, body: { error: "Unauthorized" } });
      expect(await authority.verify(key, device)).toMatchObject({ state: "revoked" });
    }
    for (const status of [500, 502, 429]) {
      answer = () => ({ status });
      expect(await authority.verify(key, device)).toMatchObject({ state: "unavailable" });
    }
  });

  it("is unavailable when yc_msaw is unreachable or redirects", async () => {
    await bindTenant();
    const refused = createBindingAuthority(db as never, (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(await refused.verify(key, device)).toMatchObject({ state: "unavailable" });
    answer = () => ({ status: 302 });
    expect(await createBindingAuthority(db as never).verify(key, device)).toMatchObject({ state: "unavailable" });
  });
});

describe("default provider wiring", () => {
  it("authorizes uploads through yc_msaw and refuses them as soon as yc_msaw does", async () => {
    const registry = new SourceProviderRegistry([providerWithBindingAuthority]);
    const runtime = createRuntimeApp({ db: db as never, registry, exporter: new SourceExporter({ db: db as never, registry, log: () => {} }), integrations: [] });
    await bindTenant();
    const d = await enroll(T);
    let active = true;
    answer = (k) => (active && k === d.key ? { status: 200, body: { tenantNs: T, bindingId: d.bindingId, provider: "imessage" } } : { status: 401, body: { error: "Unauthorized" } });

    const ok = await wire("POST", "", d, { messages: [message()] }, { target: runtime });
    expect(ok.status).toBe(200);
    expect(await events(T)).toHaveLength(1);

    active = false;
    expect((await wire("POST", "", d, { messages: [message({ rowId: 2, messageId: "G-2" })] }, { target: runtime })).status).toBe(401);
    expect(await events(T)).toHaveLength(1);
    expect((await query(`SELECT status FROM imessage_devices WHERE binding_id = $1`, [d.bindingId]))[0]!.status).toBe("revoked");
  });
});
