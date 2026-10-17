/**
 * Read-only live trace viewer for the real end-to-end demo.
 *
 *   npx tsx scripts/serve-demo-trace.ts [--port 4318] [--data-dir .context]
 *
 * Serves the static UI in demo-ui/ (fixed allowlist) and a GET-only JSON API
 * over exactly two sanitized files written by the demo orchestrator:
 *
 *   <data-dir>/real-demo-events.jsonl   append-only, one event per line
 *   <data-dir>/real-demo-state.json     atomically replaced run state
 *
 * plus an optional fixed report (reports/real-integration-e2e.json). Nothing
 * else on disk is reachable: no path parameters, no proxying, no writes. It
 * binds to 127.0.0.1 only and rejects foreign Host headers.
 */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(repoRoot, "demo-ui");

interface Options {
  port: number;
  dataDir: string;
  customDataDir: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let port = Number(process.env.TRACE_UI_PORT ?? 4318);
  let dataDir: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const next = inline ?? argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--port") port = Number(value());
    else if (flag === "--data-dir") dataDir = path.resolve(value());
    else if (flag === "--help" || flag === "-h") {
      console.log("Usage: npx tsx scripts/serve-demo-trace.ts [--port 4318] [--data-dir <dir>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  return { port, dataDir: dataDir ?? path.join(repoRoot, ".context"), customDataDir: dataDir !== null };
}

const options = parseArgs(process.argv.slice(2));
const EVENTS_FILE = path.join(options.dataDir, "real-demo-events.jsonl");
const STATE_FILE = path.join(options.dataDir, "real-demo-state.json");
const REPORT_FILE = options.customDataDir
  ? path.join(options.dataDir, "real-integration-e2e.json")
  : path.join(repoRoot, "reports", "real-integration-e2e.json");

/** The only static files served, by URL path. */
const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/trace.css": { file: "trace.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

/* ------------------------------------------------------------------ */
/* Redaction: defense in depth over files that are already sanitized. */
/* ------------------------------------------------------------------ */

const SECRET_KEY = /^(?:.*[_-])?(?:api[_-]?key|secret|client[_-]?secret|password|passwd|authorization|cookie|set[_-]?cookie|credentials?|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|bearer|token)$/iu;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{16,}|fw_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|(?:ak|as|wk|ws)-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})|Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gu;

interface Redaction { count: number }

function redactString(value: string, redaction: Redaction): string {
  return value.replace(SECRET_VALUE, () => {
    redaction.count++;
    return "[redacted]";
  });
}

function redact(value: unknown, redaction: Redaction, depth = 0): unknown {
  if (typeof value === "string") return redactString(value, redaction);
  if (value === null || typeof value !== "object") return value;
  if (depth > 40) return "[nested too deeply]";
  if (Array.isArray(value)) return value.map((item) => redact(item, redaction, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && typeof item === "string" && item.length > 0) {
      redaction.count++;
      out[key] = "[redacted]";
    } else out[key] = redact(item, redaction, depth + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Events: incremental, complete lines only.                           */
/* ------------------------------------------------------------------ */

const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_DATA = 400_000;
const STATUSES = new Set(["running", "succeeded", "failed", "partial", "waiting"]);

interface TraceEvent {
  id: string;
  seq: number;
  at: string | null;
  agentId: string;
  parentId: string | null;
  kind: string;
  title: string;
  status?: string;
  text?: string;
  textTruncated?: number;
  data?: unknown;
  dataTruncated?: number;
}

function normalizeEvent(raw: unknown, seq: number, line: string, redaction: Redaction): TraceEvent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { id: `line@${seq}`, seq, at: null, agentId: "unknown", parentId: null, kind: "invalid_line", title: "Event line is not a JSON object", text: redactString(line.slice(0, 2_000), redaction) };
  }
  const record = raw as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const event: TraceEvent = {
    id: str(record.id) ?? `line@${seq}`,
    seq,
    at: str(record.at),
    agentId: str(record.agentId) ?? "unknown",
    parentId: str(record.parentId),
    kind: str(record.kind) ?? "unknown",
    title: redactString(str(record.title) ?? "", redaction),
  };
  if (typeof record.status === "string") event.status = STATUSES.has(record.status) ? record.status : record.status.slice(0, 40);
  if (typeof record.text === "string") {
    const text = redactString(record.text, redaction);
    if (text.length > MAX_TEXT) {
      event.text = text.slice(0, MAX_TEXT);
      event.textTruncated = text.length;
    } else event.text = text;
  }
  if (record.data !== undefined) {
    const data = redact(record.data, redaction);
    const json = JSON.stringify(data) ?? "null";
    if (json.length > MAX_DATA) {
      event.data = { preview: json.slice(0, 60_000) };
      event.dataTruncated = json.length;
    } else event.data = data;
  }
  return event;
}

async function fileKey(handle: Awaited<ReturnType<typeof open>>, ino: number, size: number): Promise<string> {
  const head = Buffer.alloc(Math.min(4096, size));
  if (head.length > 0) await handle.read(head, 0, head.length, 0);
  const newline = head.indexOf(0x0a);
  if (newline === -1 && size < 4096) return `${ino}:pending`;
  const first = newline === -1 ? head : head.subarray(0, newline);
  return `${ino}:${createHash("sha256").update(first).digest("hex").slice(0, 16)}`;
}

interface EventsPage {
  exists: boolean;
  key: string | null;
  reset: boolean;
  offset: number;
  size: number;
  more: boolean;
  events: TraceEvent[];
  redacted: number;
}

async function readEvents(offset: number, key: string | null, maxBytes = MAX_CHUNK): Promise<EventsPage> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(EVENTS_FILE, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, key: null, reset: offset > 0 || key !== null, offset: 0, size: 0, more: false, events: [], redacted: 0 };
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    const currentKey = await fileKey(handle, stats.ino, stats.size);
    let start = offset;
    let reset = false;
    if ((key !== null && key !== currentKey && !(key.endsWith(":pending") && offset === 0)) || offset > stats.size || offset < 0) {
      reset = true;
      start = 0;
    }
    const length = Math.min(stats.size - start, maxBytes);
    const buffer = Buffer.alloc(Math.max(0, length));
    if (length > 0) await handle.read(buffer, 0, length, start);
    let end = buffer.lastIndexOf(0x0a);
    const redaction: Redaction = { count: 0 };
    const events: TraceEvent[] = [];
    if (end === -1 && length === maxBytes) {
      // One line larger than a whole chunk: skip it honestly rather than stall.
      events.push({ id: `line@${start}`, seq: start, at: null, agentId: "unknown", parentId: null, kind: "invalid_line", title: `Event line larger than ${maxBytes} bytes was skipped` });
      end = length - 1;
    } else if (end !== -1) {
      let lineStart = 0;
      while (lineStart <= end) {
        const lineEnd = buffer.indexOf(0x0a, lineStart);
        const line = buffer.subarray(lineStart, lineEnd).toString("utf8").trim();
        const seq = start + lineStart;
        if (line.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            events.push({ id: `line@${seq}`, seq, at: null, agentId: "unknown", parentId: null, kind: "invalid_line", title: "Event line is not valid JSON", text: redactString(line.slice(0, 2_000), redaction) });
            lineStart = lineEnd + 1;
            continue;
          }
          events.push(normalizeEvent(parsed, seq, line, redaction));
        }
        lineStart = lineEnd + 1;
      }
    }
    const next = end === -1 ? start : start + end + 1;
    return {
      exists: true,
      key: currentKey,
      reset,
      offset: next,
      size: stats.size,
      more: length === maxBytes && next < stats.size,
      events,
      redacted: redaction.count,
    };
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* State and report.                                                   */
/* ------------------------------------------------------------------ */

let lastGoodState: unknown = null;
let lastGoodHash: string | null = null;

async function readJson(file: string, maxBytes: number): Promise<{ value: unknown; exists: boolean; error: string | null; hash: string | null }> {
  let text: string;
  try {
    const handle = await open(file, "r");
    try {
      const stats = await handle.stat();
      if (stats.size > maxBytes) return { value: null, exists: true, error: `File is larger than ${maxBytes} bytes`, hash: null };
      text = (await handle.readFile()).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: null, exists: false, error: null, hash: null };
    return { value: null, exists: true, error: "File could not be read", hash: null };
  }
  try {
    return { value: JSON.parse(text), exists: true, error: null, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
  } catch {
    return { value: null, exists: true, error: "File is not valid JSON", hash: null };
  }
}

async function readState(): Promise<{ state: unknown; stateHash: string | null; stateError: string | null; redacted: number }> {
  const result = await readJson(STATE_FILE, 8 * 1024 * 1024);
  if (!result.exists) {
    lastGoodState = null;
    lastGoodHash = null;
    return { state: null, stateHash: null, stateError: null, redacted: 0 };
  }
  if (result.error !== null) return { state: lastGoodState, stateHash: lastGoodHash, stateError: `${result.error}; showing the last state that could be read.`, redacted: 0 };
  const redaction: Redaction = { count: 0 };
  lastGoodState = redact(result.value, redaction);
  lastGoodHash = result.hash;
  return { state: lastGoodState, stateHash: lastGoodHash, stateError: null, redacted: redaction.count };
}

/* ------------------------------------------------------------------ */
/* HTTP.                                                               */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

function send(response: ServerResponse, request: IncomingMessage, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "content-length": String(payload.length), ...extra });
  response.end(request.method === "HEAD" ? undefined : payload);
}

function json(response: ServerResponse, request: IncomingMessage, status: number, value: unknown, extra: Record<string, string> = {}): void {
  send(response, request, status, "application/json; charset=utf-8", JSON.stringify(value), extra);
}

function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function sourceLabels() {
  const relative = (file: string) => path.relative(repoRoot, file) || file;
  return {
    events: options.customDataDir ? path.basename(EVENTS_FILE) : relative(EVENTS_FILE),
    state: options.customDataDir ? path.basename(STATE_FILE) : relative(STATE_FILE),
    report: options.customDataDir ? path.basename(REPORT_FILE) : relative(REPORT_FILE),
    fixture: options.customDataDir,
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
  if (!allowedHost(request.headers.host, port)) {
    json(response, request, 421, { error: "Unexpected Host header" });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    json(response, request, 405, { error: "Read-only: GET and HEAD only" }, { allow: "GET, HEAD" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const asset = ASSETS[url.pathname];
  if (asset) {
    const body = await readFile(path.join(uiDir, asset.file));
    send(response, request, 200, asset.type, body);
    return;
  }
  if (url.pathname === "/api/poll") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const key = url.searchParams.get("key") || null;
    const knownState = url.searchParams.get("state") || null;
    const [events, state] = await Promise.all([
      readEvents(Number.isSafeInteger(offset) ? offset : 0, key),
      readState(),
    ]);
    json(response, request, 200, {
      now: new Date().toISOString(),
      sources: sourceLabels(),
      // Unchanged state is not resent: the client keeps what it has.
      stateUnchanged: knownState !== null && knownState === state.stateHash,
      state: knownState !== null && knownState === state.stateHash ? undefined : state.state,
      stateHash: state.stateHash,
      stateError: state.stateError,
      redacted: { events: events.redacted, state: state.redacted },
      eventsFile: { exists: events.exists, size: events.size },
      key: events.key,
      reset: events.reset,
      offset: events.offset,
      more: events.more,
      events: events.events,
    });
    return;
  }
  if (url.pathname === "/api/report") {
    const result = await readJson(REPORT_FILE, 8 * 1024 * 1024);
    if (!result.exists) return json(response, request, 404, { error: "No report has been written yet.", path: sourceLabels().report });
    if (result.error !== null) return json(response, request, 422, { error: result.error, path: sourceLabels().report });
    const redaction: Redaction = { count: 0 };
    json(response, request, 200, { path: sourceLabels().report, report: redact(result.value, redaction), redacted: redaction.count });
    return;
  }
  if (url.pathname === "/api/snapshot") {
    const events: TraceEvent[] = [];
    let offset = 0;
    let key: string | null = null;
    let redacted = 0;
    for (let page = 0; page < 64; page++) {
      const chunk = await readEvents(offset, key);
      if (chunk.reset && page > 0) {
        events.length = 0;
        redacted = 0;
      }
      events.push(...chunk.events);
      redacted += chunk.redacted;
      offset = chunk.offset;
      key = chunk.key;
      if (!chunk.more) break;
    }
    const state = await readState();
    const report = await readJson(REPORT_FILE, 8 * 1024 * 1024);
    const reportRedaction: Redaction = { count: 0 };
    const runId = state.state && typeof state.state === "object" && typeof (state.state as { runId?: unknown }).runId === "string"
      ? (state.state as { runId: string }).runId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80)
      : "no-run";
    json(response, request, 200, {
      kind: "procmem-demo-trace-snapshot",
      exportedAt: new Date().toISOString(),
      note: "Sanitized export of the demo's own event log and state; values that looked like credentials were replaced with [redacted].",
      sources: sourceLabels(),
      state: state.state,
      events,
      report: report.exists && report.error === null ? redact(report.value, reportRedaction) : null,
      redacted: redacted + state.redacted + reportRedaction.count,
    }, { "content-disposition": `attachment; filename="procmem-demo-trace-${runId}.json"` });
    return;
  }
  if (url.pathname === "/healthz") return json(response, request, 200, { ok: true });
  json(response, request, 404, { error: "Not found" });
}

const server = createServer((request, response) => {
  handle(request, response, options.port).catch((error: unknown) => {
    console.error(`[trace-ui] ${request.method} ${request.url}: ${error instanceof Error ? error.message : String(error)}`);
    if (!response.headersSent) json(response, request, 500, { error: "The trace server could not read its files." });
    else response.end();
  });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") console.error(`[trace-ui] Port ${options.port} is in use. Start with --port <other>.`);
  else console.error(`[trace-ui] ${error.message}`);
  process.exit(1);
});

server.listen(options.port, "127.0.0.1", () => {
  const labels = sourceLabels();
  console.log(`[trace-ui] ${new Date().toISOString()} listening on http://127.0.0.1:${options.port}/`);
  console.log(`[trace-ui] events: ${labels.events}  state: ${labels.state}  report: ${labels.report}${labels.fixture ? "  (custom --data-dir)" : ""}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[trace-ui] ${signal}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}

