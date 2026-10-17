/**
 * LIVE, READ-ONLY: the live-tools SDK against the deployed parent (Manufact) and its real child integration MCP.
 *
 *   npx tsx scripts/sdk-live-tools-hosted.ts            # uses .context/hosted-demo-client.json (keys.read), mode 600
 *
 * 1. LiveToolRegistry discovers memory + every catalog child over the real HTTPS endpoints (real child token mint).
 * 2. Calls ONLY tools annotated readOnlyHint:true (memory__open_memory/ls/read and child list/get tools). Never calls a
 *    mutating tool, never sends notifications, never changes or retires the child.
 * 3. Spawns the packaged-style stdio bridge (src/sdk/live/bridge-cli.ts) with the key in its ENVIRONMENT and repeats
 *    discovery + one read-only call through the official MCP client over stdio.
 * The report (reports/sdk-live-tools-hosted.json) is scanned for every credential value and JWT shapes before writing.
 * Note: the static headless read key is a non-expiring credential; this does NOT exercise parent OAuth refresh.
 */
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { LiveToolRegistry, type LiveTool, type LiveToolResult } from "../src/sdk/live/index.js";

interface DemoClient {
  baseUrl: string;
  keys: Record<string, string>;
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

function summarize(r: LiveToolResult): Record<string, unknown> {
  const textOut = r.content
    .filter((c) => c.type === "text")
    .map((c) => String(c.text))
    .join("\n");
  return {
    isError: r.isError === true,
    contentTypes: r.content.map((c) => c.type),
    textPreview: textOut.slice(0, 400),
    hasStructuredContent: r.structuredContent !== undefined,
    errorCode: (r._meta?.["procmem/error"] as { code?: string } | undefined)?.code ?? null,
  };
}

function pickReadOnly(tools: readonly LiveTool[]): LiveTool[] {
  return tools.filter((t) => t.source !== "memory" && t.annotations?.readOnlyHint === true);
}

function argsFor(t: LiveTool): Record<string, unknown> {
  // Fill only required string enums/strings with a benign first value; skip tools needing anything else.
  const schema = t.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
  const out: Record<string, unknown> = {};
  for (const k of schema.required ?? []) {
    const p = schema.properties?.[k];
    if (p?.enum?.length) out[k] = p.enum.includes("failed") ? "failed" : p.enum[0];
    else if (k === "status") out[k] = "failed";
    else if (p?.type === "string") out[k] = "n-1";
    else if (p?.type === "number" || p?.type === "integer") out[k] = 1;
    else return { __unsupported: true };
  }
  return out;
}

async function main(): Promise<void> {
  const demo = JSON.parse(await readFile(".context/hosted-demo-client.json", "utf8")) as DemoClient;
  const keyName = process.env.PROCMEM_HOSTED_KEY ?? "read";
  const key = demo.keys[keyName];
  if (!key) throw new Error(`no key ${keyName} in hosted-demo-client.json`);
  const secrets = Object.values(demo.keys);
  const logs: string[] = [];
  const report: Record<string, unknown> = {
    kind: "sdk-live-tools-hosted",
    labels: {
      mode: "LIVE READ-ONLY: real deployed parent + real child integration MCP over HTTPS; only readOnlyHint tools called",
      upstream: "child integration is LLM-authored (integration-llm-run); its third-party API is SIMULATED in-process (NOTIFY_HUB_SIMULATED=1)",
      credential: `static headless key '${keyName}' (non-expiring); parent OAuth refresh is NOT exercised here`,
    },
    baseUrl: demo.baseUrl,
    startedAt: new Date().toISOString(),
    checks: [] as Array<{ name: string; ok: boolean; detail?: unknown }>,
  };
  const checks = report.checks as Array<{ name: string; ok: boolean; detail?: unknown }>;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
    console.error(`${ok ? "PASS" : "FAIL"} ${name}`);
  };

  // 1. Registry over HTTPS
  const registry = new LiveToolRegistry({ parent: { baseUrl: demo.baseUrl, credential: () => key }, pollIntervalMs: 60_000, onLog: (e) => logs.push(`${e.level}: ${e.message}`) });
  try {
    const t0 = Date.now();
    await registry.start();
    const snap = registry.getSnapshot();
    report.discoveryMs = Date.now() - t0;
    report.catalog = snap.catalog;
    report.sources = snap.sources;
    report.tools = snap.tools.map((t) => ({ name: t.name, source: t.source, upstreamName: t.upstreamName, annotations: t.annotations ?? null, hasOutputSchema: !!t.outputSchema, required: (t.inputSchema as { required?: string[] }).required ?? [], fingerprint: t.fingerprint.slice(0, 16), integration: t.integration ?? null }));
    check("catalog fetched (authenticated HTTPS)", snap.catalog.state === "ok", { state: snap.catalog.state, childAuth: snap.catalog.configured });
    check("memory tools exposed", snap.tools.some((t) => t.name === "memory__open_memory"), snap.tools.filter((t) => t.source === "memory").map((t) => t.name));
    const children = snap.sources.filter((s) => s.source !== "memory");
    check("at least one child integration connected", children.some((s) => s.state === "ready" && s.toolCount > 0), children);
    for (const slug of children.map((s) => s.source.slice("integration:".length))) report[`tokenMints:${slug}`] = registry.tokenMints(slug);

    const open = await registry.callTool("memory__open_memory", {});
    check("memory__open_memory (read-only) succeeds", !open.isError, summarize(open));

    const calls: Record<string, unknown> = {};
    for (const t of pickReadOnly(snap.tools)) {
      const args = argsFor(t);
      if (args.__unsupported) continue;
      calls[t.name] = { args, result: summarize(await registry.callTool(t.name, args)) };
      if (Object.keys(calls).length >= 2) break;
    }
    report.readOnlyCalls = calls;
    check("read-only child tool call(s) returned MCP results", Object.values(calls).length > 0 && Object.values(calls).every((c) => !(c as { result: { isError: boolean } }).result.isError), Object.keys(calls));
    report.notCalled = snap.tools.filter((t) => t.source !== "memory" && t.annotations?.readOnlyHint !== true).map((t) => t.name);

    // 2. Bridge over stdio with the key in the environment only
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/sdk/live/bridge-cli.ts"],
      env: { ...getDefaultEnvironment(), PROCMEM_BASE_URL: demo.baseUrl, PROCMEM_API_KEY: key, PROCMEM_BRIDGE_LOG: "quiet" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const client = new Client({ name: "sdk-live-tools-hosted", version: "1.0.0" });
    let listChanged = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      listChanged++;
    });
    await client.connect(transport);
    try {
      const deadline = Date.now() + 60_000;
      let names: string[] = [];
      while (Date.now() < deadline) {
        names = (await client.listTools(undefined, { cacheMode: "bypass" } as never)).tools.map((t) => t.name);
        if (names.some((n) => n.startsWith("integration__"))) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      report.bridge = { tools: names, listChangedNotifications: listChanged, protocolVersion: client.getNegotiatedProtocolVersion?.() ?? null };
      check("stdio bridge lists memory + integration tools after list_changed", names.includes("memory__open_memory") && names.some((n) => n.startsWith("integration__")) && listChanged >= 1, { count: names.length, listChanged });
      const first = Object.entries(calls)[0];
      if (first) {
        const [name, c] = first as [string, { args: Record<string, unknown> }];
        const r = (await client.callTool({ name, arguments: c.args })) as LiveToolResult;
        check(`bridge read-only call ${name}`, !r.isError, summarize(r));
      }
      const fb = (await client.callTool({ name: "procmem_list_live_tools", arguments: {} })) as LiveToolResult;
      check("bridge fallback procmem_list_live_tools", !fb.isError && Array.isArray((fb.structuredContent as { tools?: unknown[] })?.tools));
      check("bridge stderr has no credentials", !secrets.some((s) => stderr.includes(s)) && !JWT_RE.test(stderr));
    } finally {
      await client.close();
    }
  } finally {
    await registry.dispose();
  }
  report.logs = logs;
  report.finishedAt = new Date().toISOString();
  report.ok = checks.every((c) => c.ok);
  const out = JSON.stringify(report, null, 2);
  if (secrets.some((s) => out.includes(s)) || JWT_RE.test(out)) throw new Error("report contains a credential; refusing to write it");
  await writeFile("reports/sdk-live-tools-hosted.json", `${out}\n`);
  console.error(`report: reports/sdk-live-tools-hosted.json ok=${String(report.ok)}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`sdk-live-tools-hosted failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
