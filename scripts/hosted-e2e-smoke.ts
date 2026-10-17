/**
 * Hosted end-to-end smoke for a deployed procmem parent MCP.
 *
 *   PROCMEM_HOSTED_CLIENT_FILE=.context/hosted-demo-client.json npx tsx scripts/hosted-e2e-smoke.ts
 *
 * The client file (keep it git-ignored, chmod 600) is JSON:
 *   { "baseUrl": "https://<host>", "tenantNs": "<tenant>", "keys": { "trace": "pmk_…", "build": "pmk_…", "read": "pmk_…" } }
 * `baseUrl` may be the origin or the MCP URL (`…/mcp`). Each key is a scoped
 * static key for the same tenant: trace = traces:write, build = memory:build,
 * read = memory:read (+ integrations:read).
 *
 * Optional env:
 *   PROCMEM_SMOKE_REPORT            output path (default reports/hosted-e2e-smoke.json)
 *   PROCMEM_SMOKE_BUILD_TIMEOUT_MS  bound for the daily build (default 900000 = 15 min)
 *   PROCMEM_SMOKE_EXPECT_ROOT       expected root build profile (default kimi-k3)
 *   PROCMEM_SMOKE_EXPECT_BACKEND    expected build workspace backend (default modal)
 *
 *   PROCMEM_SMOKE_RESUME_BUILD_ID / PROCMEM_SMOKE_RESUME_SESSION_ID
 *                                   validate an existing smoke build instead of ingesting + building again
 *                                   (labeled "resumed" in the report)
 *
 * Each run writes the report path above and a per-attempt copy under
 * reports/hosted-e2e-smoke-attempts/ (failed attempts are kept).
 *
 * Flow, all against the live deployment over real HTTP and a real MCP client:
 *  1. auth: absent/invalid/wrong-scope keys are refused on ingest, build, catalog
 *     and MCP; a chunk carrying a customer-supplied tenant is rejected.
 *  2. ingest: a clearly labeled SYNTHETIC fixture session (pagination + idempotent
 *     retry; full model requests/responses, tool args/results, outcome) is sent with
 *     TraceRecorder + HttpTraceTransport; a chunk resend must be deduplicated.
 *  3. build: POST /v1/builds/daily {day: <server receipt day>} with the build key,
 *     then poll the real receipt (bounded). Only published/no_change pass.
 *  4. MCP: a fresh client with the read key checks the exact filesystem tool
 *     surface, open_memory, read/grep/ls/find over the published wiki, scratch
 *     write/read/edit, and shell in the hosted sandbox (knowledge write denied,
 *     no network, no secrets, stdin, cancel). Every call passes the workspaceId.
 *  5. HTTP integration catalog with the read key.
 *
 * Keys are never printed, put in argv, or written: every log line and the report
 * pass through a redactor that masks the configured key values, the tenant, and
 * any bearer/pmk/JWT-shaped strings. The report holds concise receipts only.
 * No mock builder, no direct object-store access, no fallback: any failure exits 1.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { Client, InsufficientScopeError, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import {
  HttpTraceTransport,
  TRACE_CHUNK_GZIP_CONTENT_TYPE,
  TraceRecorder,
  type ChunkAck,
  type TraceChunk,
  type TraceSession,
  type TraceTransport,
} from "../src/sdk/client.js";

export const FIXTURE_ID = "procmem.hosted-e2e-smoke/ledgerly-pagination-idempotent-retry/v1";
export const EXPECTED_MCP_TOOLS = ["cancel_command", "edit", "find", "grep", "ls", "open_memory", "poll_command", "read", "shell", "view_file", "write", "write_command"];
const FORBIDDEN_TOOL_RE = /research|build|evidence|trace|ingest|integration|publish|admin/i;
/** Storage/build artifacts that must never appear in the customer filesystem. */
const FORBIDDEN_SEGMENTS = new Set(["traces", "trace-index", "blobs", "blob-manifests", "sessions", "sources", "inputs", "builds", "daily", "manifest.json"]);
const SENSITIVE_ENV_RE = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|FIREWORKS|MODAL_|WORKOS|PROCMEM_|AWS_|OPENAI|ANTHROPIC|MANUFACT/i;
const STATIC_KEY_RE = /^pmk_[A-Za-z0-9_-]{32,128}$/;
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HTTP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------- credentials

export interface HostedClient {
  /** Origin (plus any base path) for HTTP routes, without trailing slash or /mcp. */
  baseUrl: string;
  mcpUrl: string;
  tenantNs: string;
  keys: { trace: string; build: string; read: string };
}

/** Validate the client file. Error messages name fields only, never values. */
export function parseHostedClient(raw: unknown): HostedClient {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("client file must be a JSON object {baseUrl, tenantNs, keys:{trace,build,read}}");
  const o = raw as Record<string, unknown>;
  if (typeof o.baseUrl !== "string") throw new Error("client file: baseUrl must be a string");
  let url: URL;
  try {
    url = new URL(o.baseUrl);
  } catch {
    throw new Error("client file: baseUrl is not an absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("client file: baseUrl must use https");
  if (url.username || url.password || url.search || url.hash) throw new Error("client file: baseUrl must not contain credentials, query or fragment");
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  const baseUrl = `${url.origin}${basePath}`;
  if (typeof o.tenantNs !== "string" || !TENANT_RE.test(o.tenantNs)) throw new Error("client file: tenantNs must match the tenant namespace grammar");
  const keys = o.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys !== "object") throw new Error("client file: keys must be an object {trace, build, read}");
  for (const k of ["trace", "build", "read"] as const) {
    if (typeof keys[k] !== "string" || !STATIC_KEY_RE.test(keys[k] as string)) throw new Error(`client file: keys.${k} must be a pmk_ static key`);
  }
  const { trace, build, read } = keys as { trace: string; build: string; read: string };
  if (new Set([trace, build, read]).size !== 3) throw new Error("client file: keys.trace, keys.build and keys.read must be three distinct keys");
  return { baseUrl, mcpUrl: `${baseUrl}/mcp`, tenantNs: o.tenantNs, keys: { trace, build, read } };
}

// ---------------------------------------------------------------- redaction

/** Masks registered secret values plus bearer/pmk/JWT-shaped strings in any text or JSON. */
export class Redactor {
  #values: Array<{ value: string; label: string }> = [];

  add(value: string, label: string): void {
    if (value.length < 6 || this.#values.some((v) => v.value === value)) return;
    this.#values.push({ value, label });
    this.#values.sort((a, b) => b.value.length - a.value.length);
  }

  contains(text: string): boolean {
    return this.#values.some((v) => text.includes(v.value));
  }

  text(input: string): string {
    let out = input;
    for (const { value, label } of this.#values) out = out.split(value).join(`[redacted:${label}]`);
    return out
      .replace(/Bearer\s+(?!(?:error|realm|scope|resource_metadata|error_description)=)[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]")
      .replace(/pmk_[A-Za-z0-9_-]{8,}/g, "pmk_[redacted]")
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted:jwt]");
  }

  json<T>(value: T): T {
    if (value === undefined) return value;
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }
}

// ---------------------------------------------------------------- shell probe parsing

/** KEY=VALUE lines emitted by the sandbox probe script (later duplicates win). */
export function parseProbeLines(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

// ---------------------------------------------------------------- run bookkeeping

interface Check {
  name: string;
  ok: boolean;
  detail?: unknown;
}

class SmokeFailure extends Error {
  override name = "SmokeFailure";
}

const redactor = new Redactor();
const checks: Check[] = [];

function log(message: string): void {
  console.log(redactor.text(message));
}

function check(name: string, ok: boolean, detail?: unknown): boolean {
  const safe = redactor.json(detail);
  checks.push({ name, ok, ...(safe !== undefined ? { detail: safe } : {}) });
  log(`${ok ? "PASS" : "FAIL"} ${name}${safe !== undefined ? ` ${JSON.stringify(safe)}` : ""}`);
  return ok;
}

/** Fail the run now (downstream steps depend on this one). */
function must(name: string, ok: boolean, detail?: unknown): void {
  if (!check(name, ok, detail)) throw new SmokeFailure(`${name} failed`);
}

/** Fail after a group of independent checks if any of them failed. */
function gate(prefix: string): void {
  const failed = checks.filter((c) => c.name.startsWith(prefix) && !c.ok).map((c) => c.name);
  if (failed.length) throw new SmokeFailure(`${failed.length} ${prefix}* check(s) failed: ${failed.join(", ")}`);
}

function errorText(error: unknown): string {
  return redactor.text(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP

interface HttpResult {
  status: number;
  body: unknown;
  code?: string;
}

async function http(base: string, method: string, route: string, opts: { token?: string; body?: string; contentType?: string } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.contentType) headers["content-type"] = opts.contentType;
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (kept as clipped text)
    body = text.slice(0, 500);
  }
  const err = (body as { error?: unknown } | null)?.error;
  const code = typeof err === "string" ? err : typeof (err as { code?: unknown } | undefined)?.code === "string" ? (err as { code: string }).code : undefined;
  return { status: res.status, body, ...(code ? { code } : {}) };
}

/** One auth probe: the route must answer with one of `expected` statuses. */
async function probe(name: string, base: string, method: string, route: string, expected: number[], opts: Parameters<typeof http>[3] = {}): Promise<HttpResult | undefined> {
  try {
    const r = await http(base, method, route, opts);
    check(name, expected.includes(r.status), { method, route, expected, status: r.status, ...(r.code ? { code: r.code } : {}) });
    return r;
  } catch (error) {
    check(name, false, { method, route, expected, error: errorText(error) });
    return undefined;
  }
}

/** Same wire format as HttpTraceTransport's default (base64 of the gzip bytes, which is ASCII text). */
function gzipChunkBody(chunk: unknown): { body: string; contentType: string } {
  const gz = gzipSync(Buffer.from(JSON.stringify(chunk), "utf8"));
  return { body: gz.toString("base64"), contentType: `${TRACE_CHUNK_GZIP_CONTENT_TYPE}; encoding=base64` };
}

// ---------------------------------------------------------------- MCP

interface ToolOutcome {
  isError: boolean;
  body: Record<string, unknown>;
  text: string;
}

class Mcp {
  private constructor(readonly client: Client, readonly label: string) {}

  static async connect(url: string, token: string, label: string, open: Set<Mcp>): Promise<Mcp> {
    const client = new Client({ name: `procmem-hosted-e2e-smoke-${label}`, version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const mcp = new Mcp(client, label);
    open.add(mcp);
    await client.connect(transport);
    return mcp;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const result = (await this.client.callTool({ name, arguments: args })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = { text: text.slice(0, 500) };
    }
    return { isError: result.isError === true, body, text };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

// ---------------------------------------------------------------- synthetic fixture

class RecordingTransport implements TraceTransport {
  readonly acks: ChunkAck[] = [];
  readonly sent: TraceChunk[] = [];
  constructor(readonly inner: HttpTraceTransport) {}

  async sendChunk(chunk: TraceChunk): Promise<ChunkAck> {
    const ack = await this.inner.sendChunk(chunk);
    this.sent.push(structuredClone(chunk));
    this.acks.push(ack);
    return ack;
  }

  putBlob(sha256: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    return this.inner.putBlob(sha256, bytes, mediaType);
  }
}

const FIXTURE_MODEL = "synthetic-fixture-no-llm";
const LEDGERLY = "https://api.ledgerly.example";

/**
 * Records one coherent, fully synthetic agent session against a FICTIONAL API
 * (api.ledgerly.example; nothing is called): a page-size cap and cursor
 * pagination, then a 503 on a payment retried safely with the same
 * Idempotency-Key, confirmed by an idempotent replay. Full model requests and
 * responses, tool arguments and results, and the outcome are recorded.
 */
export function recordSyntheticFixture(session: TraceSession, runId: string, objective: string): void {
  const tools = [
    {
      name: "list_invoices",
      description: "GET /v1/invoices on the Ledgerly API (fictional). Cursor pagination via next_cursor.",
      parameters: { type: "object", properties: { status: { type: "string" }, limit: { type: "integer" }, cursor: { type: "string" } }, required: ["status"] },
    },
    {
      name: "post_payment",
      description: "POST /v1/payments on the Ledgerly API (fictional). Accepts an Idempotency-Key header.",
      parameters: {
        type: "object",
        properties: { invoice_id: { type: "string" }, amount_cents: { type: "integer" }, idempotency_key: { type: "string" } },
        required: ["invoice_id", "amount_cents", "idempotency_key"],
      },
    },
  ];
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: "You are a billing operations agent working against the Ledgerly invoices API. Use the provided tools. Never charge an invoice twice.",
    },
    { role: "user", content: objective },
  ];
  let turn = 0;
  const modelTurn = (assistant: { content: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } }) => {
    turn += 1;
    session.modelInput({ model: FIXTURE_MODEL, temperature: 0, max_tokens: 1024, messages: structuredClone(messages), tools });
    const message = {
      role: "assistant",
      content: assistant.content,
      ...(assistant.toolCall ? { tool_calls: [{ id: assistant.toolCall.id, type: "function", function: { name: assistant.toolCall.name, arguments: assistant.toolCall.arguments } }] } : {}),
    };
    session.modelOutput(
      { model: FIXTURE_MODEL, message, stop_reason: assistant.toolCall ? "tool_use" : "end_turn" },
      { usage: { inputTokens: 600 + 180 * turn, outputTokens: 60, totalTokens: 660 + 180 * turn } },
    );
    messages.push(message);
  };
  const tool = (id: string, name: string, args: Record<string, unknown>, result: Record<string, unknown>, isError = false) => {
    session.toolCall(name, args, id);
    session.toolResult(name, id, result, isError);
    messages.push({ role: "tool", tool_call_id: id, name, content: JSON.stringify(result) });
  };

  const idemKey = `pay-inv_1042-${runId}`;

  modelTurn({ content: "I will list all open invoices first.", toolCall: { id: "call_1", name: "list_invoices", arguments: { status: "open", limit: 100 } } });
  tool("call_1", "list_invoices", { status: "open", limit: 100 }, {
    http_status: 400,
    request: { method: "GET", url: `${LEDGERLY}/v1/invoices?status=open&limit=100` },
    body: { error: { code: "invalid_limit", message: "limit must be between 1 and 50" } },
  }, true);

  modelTurn({ content: "The API caps limit at 50. Retrying with limit=50.", toolCall: { id: "call_2", name: "list_invoices", arguments: { status: "open", limit: 50 } } });
  tool("call_2", "list_invoices", { status: "open", limit: 50 }, {
    http_status: 200,
    request: { method: "GET", url: `${LEDGERLY}/v1/invoices?status=open&limit=50` },
    body: {
      data: [
        { id: "inv_1040", amount_cents: 12000, status: "open" },
        { id: "inv_1041", amount_cents: 4500, status: "open" },
        { id: "inv_1042", amount_cents: 9900, status: "open" },
      ],
      has_more: true,
      next_cursor: "cur_7f3a",
    },
  });

  modelTurn({
    content: "has_more is true, so I must follow next_cursor (keeping the same status filter) to see every open invoice.",
    toolCall: { id: "call_3", name: "list_invoices", arguments: { status: "open", limit: 50, cursor: "cur_7f3a" } },
  });
  tool("call_3", "list_invoices", { status: "open", limit: 50, cursor: "cur_7f3a" }, {
    http_status: 200,
    request: { method: "GET", url: `${LEDGERLY}/v1/invoices?status=open&limit=50&cursor=cur_7f3a` },
    body: { data: [{ id: "inv_1043", amount_cents: 2500, status: "open" }], has_more: false, next_cursor: null },
  });

  const payArgs = { invoice_id: "inv_1042", amount_cents: 9900, idempotency_key: idemKey };
  modelTurn({ content: "All 4 open invoices seen. Paying inv_1042 with a stable Idempotency-Key.", toolCall: { id: "call_4", name: "post_payment", arguments: payArgs } });
  tool("call_4", "post_payment", payArgs, {
    http_status: 503,
    request: { method: "POST", url: `${LEDGERLY}/v1/payments`, headers: { "Idempotency-Key": idemKey } },
    headers: { "retry-after": "2" },
    body: { error: { code: "upstream_timeout", message: "Payment processor timed out; the charge may or may not have been applied" } },
  }, true);
  session.error({ name: "LedgerlyHttpError", message: "503 upstream_timeout on POST /v1/payments (charge state unknown)" }, { call_id: "call_4", invoice_id: "inv_1042" });
  session.note({ decision: "Retry after Retry-After (2s) with the SAME Idempotency-Key; a new key could double-charge when the first attempt actually succeeded." });

  modelTurn({ content: "Retrying the payment with the same Idempotency-Key after waiting 2s.", toolCall: { id: "call_5", name: "post_payment", arguments: payArgs } });
  tool("call_5", "post_payment", payArgs, {
    http_status: 201,
    request: { method: "POST", url: `${LEDGERLY}/v1/payments`, headers: { "Idempotency-Key": idemKey } },
    body: { id: "pay_9001", invoice_id: "inv_1042", amount_cents: 9900, status: "succeeded" },
  });

  modelTurn({ content: "Verifying that a replay of the same key does not create a second charge.", toolCall: { id: "call_6", name: "post_payment", arguments: payArgs } });
  tool("call_6", "post_payment", payArgs, {
    http_status: 200,
    request: { method: "POST", url: `${LEDGERLY}/v1/payments`, headers: { "Idempotency-Key": idemKey } },
    headers: { "idempotent-replayed": "true" },
    body: { id: "pay_9001", invoice_id: "inv_1042", amount_cents: 9900, status: "succeeded" },
  });

  modelTurn({
    content:
      "Done. Paged both pages (limit max 50, follow next_cursor until has_more=false) and paid inv_1042 exactly once: the 503 was retried with the same Idempotency-Key, and the replay returned the same payment pay_9001 (Idempotent-Replayed: true).",
  });
}

// ---------------------------------------------------------------- main flow

interface Report {
  schema: "procmem.hosted-e2e-smoke/v1";
  executed: true;
  ok: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  target: { baseUrl: string; mcpUrl: string };
  labels: { traceSource: string; builder: string; tenant: string; resumed?: string };
  checks: Check[];
  ingest?: Record<string, unknown>;
  build?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  integrations?: Record<string, unknown>;
  error?: string;
}

async function loadClient(): Promise<HostedClient> {
  const file = process.env.PROCMEM_HOSTED_CLIENT_FILE?.trim();
  if (!file) throw new SmokeFailure("PROCMEM_HOSTED_CLIENT_FILE is not set (path to the ignored hosted client JSON)");
  const st = await stat(file);
  if ((st.mode & 0o077) !== 0) log(`WARN client file is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new SmokeFailure("client file is not valid JSON");
  }
  return parseHostedClient(raw);
}

async function authChecks(c: HostedClient, open: Set<Mcp>): Promise<void> {
  const b = c.baseUrl;
  const bogus = `pmk_${randomBytes(32).toString("base64url")}`; // random, never registered
  const json = { contentType: "application/json", body: "{}" };
  await probe("auth.ingest_without_key_401", b, "POST", "/v1/traces/chunks", [401], json);
  await probe("auth.ingest_invalid_static_key_401", b, "POST", "/v1/traces/chunks", [401], { ...json, token: bogus });
  await probe("auth.ingest_garbage_bearer_401", b, "POST", "/v1/traces/chunks", [401], { ...json, token: "not-a-real-token" });
  await probe("auth.blob_without_key_401", b, "PUT", `/v1/traces/blobs/${"0".repeat(64)}`, [401], { body: "x", contentType: "text/plain" });
  await probe("auth.build_without_key_401", b, "POST", "/v1/builds/daily", [401], json);
  await probe("auth.build_invalid_static_key_401", b, "POST", "/v1/builds/daily", [401], { ...json, token: bogus });
  await probe("auth.build_status_without_key_401", b, "GET", "/v1/builds/bld-smoke-probe", [401]);
  await probe("auth.read_key_cannot_ingest_403", b, "POST", "/v1/traces/chunks", [403], { ...json, token: c.keys.read });
  await probe("auth.read_key_cannot_build_403", b, "POST", "/v1/builds/daily", [403], { ...json, token: c.keys.read });
  await probe("auth.trace_key_cannot_build_403", b, "POST", "/v1/builds/daily", [403], { ...json, token: c.keys.trace });
  await probe("auth.trace_key_cannot_read_build_status_403", b, "GET", "/v1/builds/bld-smoke-probe", [403], { token: c.keys.trace });
  await probe("auth.trace_key_cannot_read_catalog_403", b, "GET", "/v1/integrations", [403], { token: c.keys.trace });
  await probe("auth.catalog_without_key_401", b, "GET", "/v1/integrations", [401]);
  await probe("auth.build_rejects_malformed_day_400", b, "POST", "/v1/builds/daily", [400], { token: c.keys.build, contentType: "application/json", body: JSON.stringify({ day: "yesterday" }) });

  // Tenant is derived from the verified key only: a chunk naming its own tenant is rejected (strict schema).
  const now = new Date().toISOString();
  const probeSession = `smoke-tenant-probe-${randomBytes(4).toString("hex")}`;
  const tenantChunk = {
    sessionId: probeSession,
    chunkSeq: 1,
    tenantNs: "t-00000000000000000000",
    events: [{ sessionId: probeSession, seq: 1, ts: now, type: "note", agent: { id: "procmem-hosted-e2e-smoke" }, data: { synthetic: true, probe: "customer-supplied tenant" } }],
  };
  const tc = gzipChunkBody(tenantChunk);
  await probe("auth.customer_supplied_tenant_rejected_400", b, "POST", "/v1/traces/chunks", [400], { token: c.keys.trace, ...tc });

  // MCP: no key / invalid key must not connect; the build key must not read memory.
  try {
    const m = await Mcp.connect(c.mcpUrl, bogus, "invalid-key", open);
    const r = await m.call("open_memory", {});
    check("auth.mcp_invalid_static_key_refused", r.isError && r.body.workspaceId === undefined, { connected: true, isError: r.isError, code: r.body.code });
  } catch (error) {
    check("auth.mcp_invalid_static_key_refused", error instanceof UnauthorizedError || /\b401\b|unauthori|invalid_token/i.test(errorText(error)), { connected: false, error: errorText(error).slice(0, 300) });
  }
  try {
    const m = await Mcp.connect(c.mcpUrl, c.keys.build, "build-key", open);
    const r = await m.call("open_memory", {});
    check("auth.build_key_cannot_read_mcp", r.isError && r.body.workspaceId === undefined && /scope|forbidden|unauthori/i.test(r.text), {
      via: "tool result",
      isError: r.isError,
      code: r.body.code,
      error: String(r.body.error ?? "").slice(0, 200),
    });
  } catch (error) {
    // The MCP client surfaces the server's 403 insufficient_scope challenge as a typed InsufficientScopeError.
    const refused = error instanceof InsufficientScopeError || /\b403\b|insufficient[_ ]scope|forbidden/i.test(errorText(error));
    check("auth.build_key_cannot_read_mcp", refused, { via: "transport", error: errorText(error).slice(0, 300) });
  }
  gate("auth.");
}

async function ingestFixture(c: HostedClient, runId: string, report: Report): Promise<{ sessionId: string; day: string }> {
  const transport = new RecordingTransport(new HttpTraceTransport({ baseUrl: c.baseUrl, token: c.keys.trace, timeoutMs: HTTP_TIMEOUT_MS }));
  const recorder = new TraceRecorder({
    transport,
    agent: { id: "procmem-hosted-e2e-smoke", name: "Hosted E2E smoke (SYNTHETIC fixture)", model: FIXTURE_MODEL, harness: "scripts/hosted-e2e-smoke.ts" },
    flushIntervalMs: 0,
    maxRetries: 4,
  });
  const sessionId = `smoke-e2e-${runId}`;
  const objective =
    "[SYNTHETIC SMOKE FIXTURE] Reconcile open invoices on the Ledgerly API (fictional): page through every open invoice and pay invoice inv_1042 exactly once.";
  const session = recorder.begin({
    objective,
    sessionId,
    metadata: { synthetic: true, fixture: FIXTURE_ID, runId, note: "Generated by scripts/hosted-e2e-smoke.ts. Not customer data; no real API or model was called." },
  });
  recordSyntheticFixture(session, runId, objective);
  const finished = await session.finish({
    status: "succeeded",
    summary:
      "[SYNTHETIC] Listed all open invoices (limit is capped at 50; follow next_cursor until has_more=false) and paid inv_1042 exactly once: a 503 upstream_timeout was retried after Retry-After with the same Idempotency-Key; the replay returned the same payment pay_9001.",
    evidence: { source: "client-reported", details: { synthetic: true, fixture: FIXTURE_ID, pages: 2, invoicesSeen: 4, paymentId: "pay_9001", duplicateCharges: 0 } },
  });
  must("ingest.sdk_delivered_all_chunks", finished.errors.length === 0 && recorder.errors.length === 0 && transport.acks.length === finished.chunks, {
    sessionId,
    events: finished.events,
    chunks: finished.chunks,
    acks: transport.acks.map((a) => a.status),
    errors: finished.errors.map((e) => errorText(e)),
  });
  must("ingest.chunks_created", transport.acks.every((a) => a.status === "created" && a.sessionId === sessionId), { acks: transport.acks.map((a) => ({ status: a.status, chunkSeq: a.chunkSeq })) });
  const days = [...new Set(transport.acks.map((a) => a.day).filter((d): d is string => typeof d === "string"))];
  must("ingest.single_receipt_day", days.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(days[0]!), { days });
  const day = days[0]!;

  // Idempotent delivery: resending an already-acknowledged chunk is deduplicated server-side.
  const first = transport.sent[0]!;
  const firstAck = transport.acks[0]!;
  try {
    const again = await transport.inner.sendChunk(first);
    must("ingest.resend_is_duplicate", again.status === "duplicate" && again.day === firstAck.day && again.key === firstAck.key, {
      status: again.status,
      sameDay: again.day === firstAck.day,
      sameKey: again.key === firstAck.key,
    });
  } catch (error) {
    must("ingest.resend_is_duplicate", false, { error: errorText(error) });
  }
  report.ingest = {
    traceSource: "synthetic fixture (scripts/hosted-e2e-smoke.ts); not customer data; no LLM or external API was called to produce it",
    fixture: FIXTURE_ID,
    sessionId,
    events: finished.events,
    chunks: finished.chunks,
    receiptDay: day,
    utcToday: new Date().toISOString().slice(0, 10),
    acks: transport.acks.map((a) => ({ status: a.status, chunkSeq: a.chunkSeq, day: a.day, key: a.key })),
  };
  return { sessionId, day };
}

type Receipt = Record<string, unknown>;

async function pollBuild(c: HostedClient, buildId: string, deadline: number): Promise<Receipt> {
  let notFound = 0;
  for (;;) {
    if (Date.now() > deadline) throw new SmokeFailure(`build ${buildId} did not finish before the smoke timeout (PROCMEM_SMOKE_BUILD_TIMEOUT_MS)`);
    let r: HttpResult | undefined;
    try {
      r = await http(c.baseUrl, "GET", `/v1/builds/${buildId}`, { token: c.keys.build });
    } catch (error) {
      log(`poll ${buildId}: transient error ${errorText(error)}`);
    }
    if (r) {
      if (r.status === 401 || r.status === 403) throw new SmokeFailure(`build status for ${buildId} refused with ${r.status} (${r.code ?? "no code"})`);
      if (r.status === 200) {
        const receipt = r.body as Receipt;
        const status = String(receipt.status ?? "");
        log(`poll ${buildId}: ${status}${receipt.revisionId ? ` ${String(receipt.revisionId)}` : ""}`);
        if (status && status !== "running") return receipt;
      } else if (r.status === 404) {
        notFound += 1;
        log(`poll ${buildId}: 404 (no receipt yet, ${notFound})`);
      } else {
        log(`poll ${buildId}: HTTP ${r.status}${r.code ? ` ${r.code}` : ""}`);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runBuild(c: HostedClient, day: string, sessionId: string, report: Report): Promise<Receipt> {
  const timeoutMs = Number(process.env.PROCMEM_SMOKE_BUILD_TIMEOUT_MS ?? 15 * 60_000);
  const startedAt = Date.now();
  const deadline = startedAt + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15 * 60_000);
  const triggers: unknown[] = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (Date.now() > deadline) break;
    const t = await http(c.baseUrl, "POST", "/v1/builds/daily", { token: c.keys.build, contentType: "application/json", body: JSON.stringify({ day }) });
    const tb = (t.body ?? {}) as Receipt;
    const summary = { attempt, httpStatus: t.status, status: tb.status, buildId: tb.buildId, reason: tb.reason, day: tb.day, manifest: tb.manifest, ...(t.code ? { code: t.code } : {}) };
    triggers.push(redactor.json(summary));
    log(`trigger #${attempt}: ${JSON.stringify(redactor.json(summary))}`);
    if (t.status !== 200 && t.status !== 202) {
      report.build = { triggers };
      throw new SmokeFailure(`build trigger refused: HTTP ${t.status} ${t.code ?? ""} ${redactor.text(JSON.stringify(t.body)).slice(0, 400)}`);
    }
    if (tb.day !== undefined && tb.day !== day) throw new SmokeFailure(`build trigger answered for day ${String(tb.day)}, expected ${day}`);
    const buildId = typeof tb.buildId === "string" ? tb.buildId : undefined;
    if ((tb.status === "running" || tb.status === "build_in_progress" || tb.status === "not_claimed") && buildId) {
      const receipt = await pollBuild(c, buildId, deadline);
      const sessions = Array.isArray(receipt.sessions) ? (receipt.sessions as unknown[]) : [];
      if (sessions.includes(sessionId)) {
        report.build = { triggers, waitedMs: Date.now() - startedAt };
        return receipt;
      }
      // An earlier build (pinned before our chunks) finished; trigger again so our cohort is built.
      log(`build ${buildId} finished as ${String(receipt.status)} without the smoke session; re-triggering day ${day}`);
      continue;
    }
    if (tb.status === "not_claimed") {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    report.build = { triggers };
    throw new SmokeFailure(
      `build trigger returned ${String(tb.status)} (${String(tb.reason ?? "")}) for day ${day} right after the smoke chunks were ingested; ` +
        "another build may have consumed them or the day is in an unexpected state. Not treated as success.",
    );
  }
  report.build = { triggers };
  throw new SmokeFailure(`no build including session ${sessionId} completed within the bound`);
}

function validateReceipt(c: HostedClient, receipt: Receipt, day: string, sessionId: string, report: Report): void {
  const status = String(receipt.status ?? "");
  const profiles = (receipt.profiles ?? {}) as { root?: string; selectable?: string[]; defaultChild?: string };
  const attempts = Array.isArray(receipt.attempts) ? (receipt.attempts as Array<Record<string, unknown>>) : [];
  const sessions = Array.isArray(receipt.sessions) ? (receipt.sessions as unknown[]) : [];
  const started = Date.parse(String(receipt.startedAt ?? ""));
  const finished = Date.parse(String(receipt.finishedAt ?? ""));
  report.build = {
    ...(report.build ?? {}),
    receipt: {
      schema: receipt.schema,
      buildId: receipt.buildId,
      status,
      revisionId: receipt.revisionId,
      initialHead: receipt.initialHead,
      day: receipt.day,
      tenantMatches: receipt.ns === c.tenantNs,
      manifestKey: receipt.manifestKey,
      chunks: receipt.chunks,
      sessionsInCohort: sessions.length,
      includesSmokeSession: sessions.includes(sessionId),
      inputs: receipt.inputs,
      workspaceBackend: receipt.workspaceBackend,
      profiles,
      attempts: attempts.map((a) => ({ attempt: a.attempt, status: a.status, agents: a.agents, revisionId: a.revisionId })),
      providerClose: receipt.providerClose,
      summary: typeof receipt.summary === "string" ? receipt.summary.slice(0, 400) : undefined,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      buildDurationMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : undefined,
      ...(receipt.error ? { error: String(receipt.error).slice(0, 600) } : {}),
    },
  };
  if (status === "failed") throw new SmokeFailure(`daily build failed: ${redactor.text(String(receipt.error ?? (receipt.failure as { message?: string } | undefined)?.message ?? "no error recorded")).slice(0, 600)}`);
  const expectRoot = process.env.PROCMEM_SMOKE_EXPECT_ROOT ?? "kimi-k3";
  const expectBackend = process.env.PROCMEM_SMOKE_EXPECT_BACKEND ?? "modal";
  // DailyBuildService writes {schema: "procmem.daily-build/v1", ...builderReceipt}; the harness receipt's own
  // schema ("procmem.build-receipt/v1") currently wins the spread. Either is a real persisted receipt; the
  // daily-level fields (day, ns, manifestKey, sessions) are validated separately below.
  check("build.receipt_schema", receipt.schema === "procmem.daily-build/v1" || receipt.schema === "procmem.build-receipt/v1", {
    schema: receipt.schema,
    manifestKey: typeof receipt.manifestKey === "string",
  });
  check("build.daily_receipt_fields", typeof receipt.manifestKey === "string" && typeof receipt.ns === "string" && Array.isArray(receipt.sessions), {});
  check("build.status_published_or_no_change", status === "published" || status === "no_change", { status });
  check("build.revision_id", typeof receipt.revisionId === "string" && /^rev-/.test(receipt.revisionId), { revisionId: receipt.revisionId });
  check("build.day_matches_receipt_day", receipt.day === day, { day: receipt.day, expected: day });
  check("build.tenant_is_key_tenant", receipt.ns === c.tenantNs, { tenantMatches: receipt.ns === c.tenantNs });
  check("build.cohort_includes_smoke_session", sessions.includes(sessionId), { sessionsInCohort: sessions.length });
  check("build.real_root_profile", profiles.root === expectRoot, { root: profiles.root, expected: expectRoot });
  check("build.real_workspace_backend", receipt.workspaceBackend === expectBackend, { workspaceBackend: receipt.workspaceBackend, expected: expectBackend });
  check("build.agents_ran", attempts.length > 0 && attempts.some((a) => Number(a.agents) > 0), { attempts: attempts.length });
  gate("build.");
}

async function mcpChecks(c: HostedClient, receipt: Receipt, open: Set<Mcp>, runId: string, report: Report): Promise<void> {
  const m = await Mcp.connect(c.mcpUrl, c.keys.read, "read-key", open);
  const out: Record<string, unknown> = {};
  report.mcp = out;

  const names = (await m.client.listTools()).tools.map((t) => t.name).sort();
  out.tools = names;
  check("mcp.tools_exact_filesystem_surface", JSON.stringify(names) === JSON.stringify(EXPECTED_MCP_TOOLS), { tools: names, expected: EXPECTED_MCP_TOOLS });
  check("mcp.no_builder_or_trace_tools", !names.some((n) => FORBIDDEN_TOOL_RE.test(n)), { offending: names.filter((n) => FORBIDDEN_TOOL_RE.test(n)) });

  const opened = await m.call("open_memory", {});
  const workspaceId = String(opened.body.workspaceId ?? "");
  const revision = (opened.body.revision ?? {}) as { id?: string; pages?: number; publishedAt?: string };
  must("mcp.open_memory", !opened.isError && /^[0-9a-f-]{36}$/.test(workspaceId), { isError: opened.isError, code: opened.body.code, hasWorkspaceId: workspaceId.length > 0 });
  check("mcp.open_memory_pins_built_revision", revision.id === receipt.revisionId, { revision: revision.id, built: receipt.revisionId });
  check("mcp.open_memory_root_index", typeof opened.body.rootIndex === "string" && opened.body.rootIndex.length > 0, { rootIndexChars: String(opened.body.rootIndex ?? "").length });
  out.revision = { id: revision.id, pages: revision.pages, publishedAt: revision.publishedAt };
  out.workspaceIdExplicit = true;

  /** Every call names the workspace explicitly and must be answered for that workspace. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await m.call(name, { ...args, workspaceId });
    if (!r.isError && r.body.workspaceId !== workspaceId) check(`mcp.${name}_honors_workspace_id`, false, { returned: r.body.workspaceId });
    return r;
  };

  // ---- published knowledge
  const index = await call("read", { path: "$KNOWLEDGE/index.md" });
  check("mcp.read_index", !index.isError && typeof index.body.content === "string" && index.body.content.length > 0, { isError: index.isError, totalBytes: index.body.totalBytes });

  const ls = await call("ls", { path: "$KNOWLEDGE" });
  const entries = ((ls.body.entries ?? []) as Array<{ name: string; type: string }>).map((e) => `${e.name.replace(/\/+$/, "")}${e.type === "dir" ? "/" : ""}`);
  check("mcp.ls_knowledge", !ls.isError && entries.includes("index.md"), { entries });
  check("mcp.ls_knowledge_no_storage_dirs", !entries.some((e) => FORBIDDEN_SEGMENTS.has(e.replace(/\/+$/, ""))), { entries });

  const found = await call("find", { pattern: "*", path: "$KNOWLEDGE", limit: 2000 });
  const paths = (found.body.matches ?? []) as string[];
  const files = paths.filter((p) => !p.endsWith("/"));
  const badSegments = paths.filter((p) => p.replace(/^\$KNOWLEDGE\/?/, "").split("/").some((s) => FORBIDDEN_SEGMENTS.has(s)));
  const nonMarkdown = files.filter((p) => !p.endsWith(".md"));
  check("mcp.find_knowledge", !found.isError && files.length > 0, { files: files.length, truncated: found.body.truncated });
  check("mcp.knowledge_has_no_trace_or_source_paths", badSegments.length === 0 && nonMarkdown.length === 0, { badSegments: badSegments.slice(0, 10), nonMarkdown: nonMarkdown.slice(0, 10) });
  out.knowledge = { files: files.length, sample: files.slice(0, 25) };

  const grep = await call("grep", { pattern: "idempoten|paginat|next_cursor|cursor", path: "$KNOWLEDGE", ignoreCase: true, limit: 50 });
  const matches = (grep.body.matches ?? []) as Array<{ path: string; line: number; text: string }>;
  const mustReflect = receipt.status === "published";
  check("mcp.grep_knowledge_reflects_fixture", !grep.isError && (matches.length > 0 || !mustReflect), {
    buildStatus: receipt.status,
    required: mustReflect,
    matches: matches.length,
    sample: matches.slice(0, 5).map((x) => ({ path: x.path, line: x.line, text: String(x.text).slice(0, 160) })),
  });
  if (matches[0]) {
    const page = await call("read", { path: matches[0].path, limit: 40 });
    check("mcp.read_matched_page", !page.isError && String(page.body.content ?? "").length > 0, { path: matches[0].path, totalLines: page.body.totalLines });
  }

  // ---- isolation of $KNOWLEDGE and storage
  const traversal = await call("read", { path: "$WORK/../traces" });
  check("mcp.read_traversal_refused", traversal.isError, { code: traversal.body.code });
  const absTraces = await call("ls", { path: "/memory/traces" });
  check("mcp.ls_outside_roots_refused", absTraces.isError, { code: absTraces.body.code });
  const knowledgeWrite = await call("write", { path: "$KNOWLEDGE/index.md", content: "smoke must not write here" });
  check("mcp.write_knowledge_refused", knowledgeWrite.isError && ["read_only", "invalid_path"].includes(String(knowledgeWrite.body.code)), { code: knowledgeWrite.body.code });
  const knowledgeEdit = await call("edit", { path: "$KNOWLEDGE/index.md", edits: [{ oldText: "#", newText: "##" }] });
  check("mcp.edit_knowledge_refused", knowledgeEdit.isError, { code: knowledgeEdit.body.code });

  // ---- private scratch
  const notePath = "$WORK/scratch/hosted-smoke/notes.md";
  const marker = `hosted-smoke-${runId}`;
  const w = await call("write", { path: notePath, content: `# smoke\nmarker: ${marker}\nstate: draft\n` });
  check("mcp.scratch_write", !w.isError && w.body.ok === true, { path: w.body.path, bytes: w.body.bytes, created: w.body.created, code: w.body.code });
  const r1 = await call("read", { path: notePath });
  check("mcp.scratch_read", !r1.isError && String(r1.body.content ?? "").includes(marker), { totalBytes: r1.body.totalBytes });
  const e = await call("edit", { path: notePath, edits: [{ oldText: "state: draft", newText: "state: edited" }] });
  check("mcp.scratch_edit", !e.isError && e.body.replacements === 1, { replacements: e.body.replacements, code: e.body.code });
  const r2 = await call("read", { path: notePath });
  check("mcp.scratch_read_after_edit", !r2.isError && String(r2.body.content ?? "").includes("state: edited"), {});
  const lsScratch = await call("ls", { path: "$WORK/scratch/hosted-smoke" });
  check("mcp.scratch_ls", !lsScratch.isError && JSON.stringify(lsScratch.body.entries ?? []).includes("notes.md"), {});

  // ---- shell in the hosted sandbox (bounded)
  const probeScript = [
    "set +e",
    `echo SCRATCH_MARKER=$(grep -c '${marker}' hosted-smoke/notes.md 2>/dev/null)`,
    "echo UID=$(id -u)",
    'if touch "$KNOWLEDGE/__smoke_probe" 2>/dev/null; then echo KNOWLEDGE_CREATE=allowed; else echo KNOWLEDGE_CREATE=denied; fi',
    'if ( echo x >> "$KNOWLEDGE/index.md" ) 2>/dev/null; then echo KNOWLEDGE_APPEND=allowed; else echo KNOWLEDGE_APPEND=denied; fi',
    "if timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then echo NET_TCP_IP=open; else echo NET_TCP_IP=blocked; fi",
    "if timeout 8 bash -c 'exec 3<>/dev/tcp/example.com/80' 2>/dev/null; then echo NET_TCP_DNS=open; else echo NET_TCP_DNS=blocked; fi",
    "if command -v curl >/dev/null 2>&1; then if curl -sS -m 8 -o /dev/null https://example.com 2>/dev/null; then echo NET_CURL=open; else echo NET_CURL=blocked; fi; else echo NET_CURL=absent; fi",
    "echo MEMORY_ENTRIES=$(ls -1A /memory 2>/dev/null | tr '\\n' ',')",
    "echo STORAGE_DIRS=$(find /memory /work -maxdepth 4 -type d \\( -name traces -o -name trace-index -o -name blobs -o -name sessions -o -name inputs -o -name sources \\) 2>/dev/null | head -5 | tr '\\n' ',')",
    "echo ENV_NAMES=$(env | cut -d= -f1 | sort | tr '\\n' ',')",
    "echo PROBE_DONE=1",
  ].join("\n");
  // poll_command returns only output produced since the previous receipt, so accumulate it.
  let sh = await call("shell", { script: probeScript, timeout_ms: 60_000, yield_time_ms: 30_000 });
  let stdout = String(sh.body.stdout ?? "");
  let stderr = String(sh.body.stderr ?? "");
  for (let i = 0; i < 6 && !sh.isError && sh.body.running === true; i++) {
    sh = await call("poll_command", { commandId: sh.body.commandId, yield_time_ms: 15_000 });
    stdout += String(sh.body.stdout ?? "");
    stderr += String(sh.body.stderr ?? "");
  }
  const kv = parseProbeLines(stdout);
  const envNames = (kv.ENV_NAMES ?? "").split(",").filter(Boolean);
  const sensitiveEnv = envNames.filter((n) => SENSITIVE_ENV_RE.test(n));
  must("mcp.shell_ran_in_sandbox", !sh.isError && sh.body.exitCode === 0 && kv.PROBE_DONE === "1", {
    isError: sh.isError,
    code: sh.body.code,
    error: sh.isError ? String(sh.body.error ?? "").slice(0, 300) : undefined,
    exitCode: sh.body.exitCode,
    timedOut: sh.body.timedOut,
  });
  check("mcp.shell_sees_same_scratch", kv.SCRATCH_MARKER === "1", { scratchMarker: kv.SCRATCH_MARKER });
  check("mcp.shell_unprivileged", kv.UID !== undefined && kv.UID !== "0", { uid: kv.UID });
  check("mcp.shell_knowledge_write_denied", kv.KNOWLEDGE_CREATE === "denied" && kv.KNOWLEDGE_APPEND === "denied", { create: kv.KNOWLEDGE_CREATE, append: kv.KNOWLEDGE_APPEND });
  check("mcp.shell_no_network", kv.NET_TCP_IP === "blocked" && kv.NET_TCP_DNS === "blocked" && kv.NET_CURL !== "open", { tcpIp: kv.NET_TCP_IP, tcpDns: kv.NET_TCP_DNS, curl: kv.NET_CURL });
  check("mcp.shell_no_storage_dirs", (kv.STORAGE_DIRS ?? "") === "" && (kv.MEMORY_ENTRIES ?? "").split(",").filter(Boolean).every((e) => e === "knowledge"), {
    memoryEntries: kv.MEMORY_ENTRIES,
    storageDirs: kv.STORAGE_DIRS,
  });
  check("mcp.shell_no_secret_env", sensitiveEnv.length === 0 && !redactor.contains(stdout + stderr), { envNames: envNames.length, sensitiveEnv });

  // stdin round trip through a resumable command
  const stdinCmd = await call("shell", { script: 'IFS= read -r line; echo "got:$line"', timeout_ms: 60_000, yield_time_ms: 1_000 });
  let stdinOk = false;
  if (!stdinCmd.isError && stdinCmd.body.running === true && typeof stdinCmd.body.commandId === "string") {
    let wr = await call("write_command", { commandId: stdinCmd.body.commandId, text: "smoke-stdin\n", close: true, yield_time_ms: 5_000 });
    let seen = String(wr.body.stdout ?? "");
    for (let i = 0; i < 4 && !wr.isError && wr.body.running === true; i++) {
      wr = await call("poll_command", { commandId: stdinCmd.body.commandId, yield_time_ms: 5_000 });
      seen += String(wr.body.stdout ?? "");
    }
    stdinOk = !wr.isError && wr.body.running === false && seen.includes("got:smoke-stdin");
  }
  check("mcp.shell_stdin_roundtrip", stdinOk, { firstRunning: stdinCmd.body.running, code: stdinCmd.body.code });

  // cancel a long-running command
  const sleepCmd = await call("shell", { script: "sleep 300", timeout_ms: 600_000, yield_time_ms: 500 });
  if (!sleepCmd.isError && sleepCmd.body.running === true && typeof sleepCmd.body.commandId === "string") {
    const cancelled = await call("cancel_command", { commandId: sleepCmd.body.commandId });
    check("mcp.shell_cancel", !cancelled.isError && cancelled.body.cancelled === true && cancelled.body.running === false, {
      cancelled: cancelled.body.cancelled,
      running: cancelled.body.running,
    });
  } else {
    check("mcp.shell_cancel", false, { firstRunning: sleepCmd.body.running, code: sleepCmd.body.code });
  }
  out.shell = { uid: kv.UID, network: { tcpIp: kv.NET_TCP_IP, tcpDns: kv.NET_TCP_DNS, curl: kv.NET_CURL }, envNameCount: envNames.length, memoryEntries: kv.MEMORY_ENTRIES };
  gate("mcp.");
}

async function catalogCheck(c: HostedClient, report: Report): Promise<void> {
  const r = await http(c.baseUrl, "GET", "/v1/integrations", { token: c.keys.read });
  const body = (r.body ?? {}) as { integrations?: unknown; childAuthConfigured?: unknown; note?: unknown };
  const list = Array.isArray(body.integrations) ? (body.integrations as Array<Record<string, unknown>>) : null;
  report.integrations = {
    status: r.status,
    configured: body.note === undefined,
    childAuthConfigured: body.childAuthConfigured,
    count: list?.length,
    slugs: list?.map((i) => i.slug).slice(0, 20),
    ...(body.note ? { note: body.note } : {}),
  };
  check("integrations.catalog_read_key_200", r.status === 200 && list !== null, { status: r.status, code: r.code, count: list?.length });
  check("integrations.catalog_configured", body.note === undefined, { note: body.note });
  gate("integrations.");
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const reportPath = process.env.PROCMEM_SMOKE_REPORT ?? path.join("reports", "hosted-e2e-smoke.json");
  const runId = `${startedAt.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
  const open = new Set<Mcp>();
  const report: Report = {
    schema: "procmem.hosted-e2e-smoke/v1",
    executed: true,
    ok: false,
    startedAt: startedAt.toISOString(),
    target: { baseUrl: "", mcpUrl: "" },
    labels: {
      traceSource: "SYNTHETIC fixture recorded by this script (fictional Ledgerly API; no customer data, no model call)",
      builder: "hosted DailyBuildService with the deployment's configured builder (real; no mock, no override); identity read from the receipt",
      tenant: "derived server-side from the static keys; the configured tenant value is redacted in this report",
    },
    checks,
  };
  try {
    const client = await loadClient();
    redactor.add(client.keys.trace, "trace-key");
    redactor.add(client.keys.build, "build-key");
    redactor.add(client.keys.read, "read-key");
    redactor.add(client.tenantNs, "tenant");
    report.target = { baseUrl: client.baseUrl, mcpUrl: client.mcpUrl };
    log(`hosted e2e smoke ${runId} -> ${client.mcpUrl}`);

    // The Manufact gateway answers /health itself ({status:"healthy"}); /healthz reaches the app.
    const health = await http(client.baseUrl, "GET", "/healthz");
    const hb = (health.body ?? {}) as { ok?: unknown; auth?: unknown; version?: unknown };
    must("health.app_healthz", health.status === 200 && hb.ok === true && (hb.auth === "workos" || hb.auth === "oidc"), { status: health.status, body: health.body });

    await authChecks(client, open);
    const resumeBuild = process.env.PROCMEM_SMOKE_RESUME_BUILD_ID?.trim();
    const resumeSession = process.env.PROCMEM_SMOKE_RESUME_SESSION_ID?.trim();
    let sessionId: string;
    let day: string;
    let receipt: Receipt;
    if (resumeBuild || resumeSession) {
      // Resume: validate an existing real build (one this script started) instead of ingesting and building again.
      if (!resumeBuild || !/^bld-[a-z0-9-]{1,60}$/.test(resumeBuild) || !resumeSession || !/^smoke-e2e-[a-z0-9-]+$/.test(resumeSession)) {
        throw new SmokeFailure("resume needs both PROCMEM_SMOKE_RESUME_BUILD_ID (bld-…) and PROCMEM_SMOKE_RESUME_SESSION_ID (smoke-e2e-…)");
      }
      receipt = await pollBuild(client, resumeBuild, Date.now() + Number(process.env.PROCMEM_SMOKE_BUILD_TIMEOUT_MS ?? 15 * 60_000));
      sessionId = resumeSession;
      day = String(receipt.day ?? "");
      report.labels.resumed = `validated existing build ${resumeBuild} for smoke session ${resumeSession}; no new ingest or build in this run`;
      report.ingest = { resumed: true, sessionId, receiptDay: day };
      report.build = { resumed: true, buildId: resumeBuild };
    } else {
      ({ sessionId, day } = await ingestFixture(client, runId, report));
      receipt = await runBuild(client, day, sessionId, report);
    }
    validateReceipt(client, receipt, day, sessionId, report);
    await mcpChecks(client, receipt, open, runId, report);
    await catalogCheck(client, report);
    report.ok = checks.every((c) => c.ok);
  } catch (error) {
    report.ok = false;
    report.error = errorText(error);
    log(`ERROR ${report.error}`);
  } finally {
    for (const m of open) {
      try {
        await m.close();
      } catch (error) {
        log(`close ${m.label}: ${errorText(error)}`);
      }
    }
    const finishedAt = new Date();
    report.finishedAt = finishedAt.toISOString();
    report.durationMs = finishedAt.getTime() - startedAt.getTime();
    if (report.ok && checks.some((c) => !c.ok)) report.ok = false;
    await mkdir(path.dirname(reportPath), { recursive: true });
    const serialized = `${redactor.text(JSON.stringify(report, null, 2))}\n`;
    await writeFile(reportPath, serialized);
    // Every attempt (pass or fail) is also kept on its own, so failed runs are never overwritten.
    const attemptPath = path.join(path.dirname(reportPath), "hosted-e2e-smoke-attempts", `${report.startedAt.replace(/[:.]/g, "-")}-${runId}.json`);
    await mkdir(path.dirname(attemptPath), { recursive: true });
    await writeFile(attemptPath, serialized);
    log(`${report.ok ? "OK" : "FAILED"} ${checks.filter((c) => c.ok).length}/${checks.length} checks -> ${reportPath}`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(redactor.text(String((error as Error)?.stack ?? error)));
    process.exitCode = 1;
  });
}
