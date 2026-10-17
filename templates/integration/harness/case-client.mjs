// Host-owned MCP client for smoke / held-out cases. Runs as the harness uid
// (separate from the child server's agent uid). Input JSON on stdin, one JSON
// result object on stdout. Uses the official MCP TypeScript client over
// Streamable HTTP: real initialize -> tools/list -> tools/call.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const input = JSON.parse(
  await new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
  }),
);

const out = { protocol: {}, steps: [], fixture: null, failures: [] };
const fail = (where, message) => out.failures.push({ where, message });

function select(obj, path) {
  // Dotted path with numeric indexes and a single "[*]" fan-out, e.g. "structuredContent.items[*].id".
  const parts = path.split(".").filter(Boolean);
  let cur = [obj];
  let fanned = false;
  for (const raw of parts) {
    const star = raw.endsWith("[*]");
    const key = star ? raw.slice(0, -3) : raw;
    cur = cur.map((v) => (v == null ? undefined : key === "" ? v : v[key]));
    if (star) {
      fanned = true;
      cur = cur.flatMap((v) => (Array.isArray(v) ? v : []));
    }
  }
  return fanned ? cur : cur[0];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function check(target, expect, where) {
  for (const e of expect ?? []) {
    const v = select(target, e.path);
    let ok;
    switch (e.op) {
      case "equals": ok = same(v, e.value); break;
      case "notEquals": ok = !same(v, e.value); break;
      case "gte": ok = typeof v === "number" && v >= e.value; break;
      case "lte": ok = typeof v === "number" && v <= e.value; break;
      case "exists": ok = v !== undefined && v !== null; break;
      case "absent": ok = v === undefined || v === null; break;
      case "contains": ok = typeof v === "string" ? v.includes(e.value) : Array.isArray(v) && v.some((x) => same(x, e.value)); break;
      case "lengthEquals": ok = (Array.isArray(v) || typeof v === "string") && v.length === e.value; break;
      case "unique": ok = Array.isArray(v) && new Set(v.map((x) => JSON.stringify(x))).size === v.length; break;
      default: ok = false; fail(where, `unknown assertion op ${e.op}`);
    }
    if (!ok) fail(where, `expected ${e.path} ${e.op}${e.value === undefined ? "" : " " + JSON.stringify(e.value)}; got ${JSON.stringify(v)?.slice(0, 300)}`);
  }
}

function substitute(value, ctx) {
  if (typeof value === "string") {
    const m = value.match(/^\{\{([a-zA-Z0-9_.[\]*]+)\}\}$/);
    return m ? select(ctx, m[1]) : value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ctx)]));
  return value;
}

const url = new URL(input.url);
let client;
try {
  if (input.checkAuth) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "procmem-harness-unauth", version: "1" } } }),
      signal: AbortSignal.timeout(10_000),
    });
    out.protocol.unauthenticatedStatus = r.status;
    if (r.status !== 401) fail("auth", `unauthenticated initialize returned HTTP ${r.status}, expected 401`);
    out.protocol.invalidTokenStatus = {};
    for (const [label, bad] of Object.entries(input.invalidTokens ?? {})) {
      const rb = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bad}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "procmem-harness-badtoken", version: "1" } } }),
        signal: AbortSignal.timeout(10_000),
      });
      out.protocol.invalidTokenStatus[label] = rb.status;
      if (rb.status !== 401) fail("auth", `${label} token returned HTTP ${rb.status}, expected 401`);
    }
  }
  client = new Client({ name: "procmem-integration-harness", version: "0.1.0" });
  const headers = input.token ? { authorization: `Bearer ${input.token}` } : {};
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  out.protocol.serverVersion = client.getServerVersion() ?? null;
  out.protocol.protocolVersion = client.getNegotiatedProtocolVersion?.() ?? null;
  const listed = await client.listTools();
  out.protocol.tools = listed.tools.map((t) => ({ name: t.name, readOnlyHint: t.annotations?.readOnlyHint ?? null, destructiveHint: t.annotations?.destructiveHint ?? null }));
  const names = listed.tools.map((t) => t.name).sort();
  if (Array.isArray(input.declaredTools) && !same(names, [...input.declaredTools].sort())) {
    fail("tools/list", `listed tools ${JSON.stringify(names)} differ from integration.json tools ${JSON.stringify([...input.declaredTools].sort())}`);
  }
  for (const t of listed.tools) if (t.inputSchema?.type !== "object") fail("tools/list", `tool ${t.name} has no object inputSchema`);
  const ctx = { steps: [] };
  for (const [i, step] of (input.steps ?? []).entries()) {
    const args = substitute(step.arguments ?? {}, ctx);
    const started = Date.now();
    let result;
    try {
      result = await client.callTool({ name: step.tool, arguments: args }, undefined, { timeout: step.timeoutMs ?? 30_000 });
    } catch (error) {
      result = { transportError: String(error?.message ?? error) };
    }
    const rec = { index: i, tool: step.tool, durationMs: Date.now() - started, isError: result.isError === true, transportError: result.transportError ?? null, structuredContent: result.structuredContent ?? null, text: (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").slice(0, 2000) };
    out.steps.push(rec);
    ctx.steps.push(result);
    const where = `step ${i} ${step.tool}`;
    if (result.transportError) fail(where, `call failed: ${result.transportError}`);
    const expectsError = (step.expect ?? []).some((e) => e.path === "isError");
    if (!expectsError && result.isError) fail(where, `tool returned isError: ${rec.text.slice(0, 300)}`);
    check(result, step.expect, where);
  }
  if (input.fixture && input.fixtureExpect?.length) {
    const r = await fetch(new URL("/__state", input.fixture.url), { headers: { "x-fixture-admin": input.fixture.adminToken }, signal: AbortSignal.timeout(5_000) });
    const state = await r.json();
    out.fixture = { notificationCount: Array.isArray(state.notifications) ? state.notifications.length : null, postAttempts: state.postAttempts, idempotentReplays: state.idempotentReplays, rateLimited: state.rateLimited, listCalls: state.listCalls };
    check(state, input.fixtureExpect, "fixture state");
  }
} catch (error) {
  fail("client", String(error?.stack ?? error).slice(0, 1500));
} finally {
  await client?.close().catch(() => undefined);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
