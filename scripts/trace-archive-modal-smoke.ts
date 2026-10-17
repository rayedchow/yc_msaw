/**
 * Real Modal smoke for the builder trace archive (sources/) and the model-callable `shell` tool.
 *   npx tsx scripts/trace-archive-modal-smoke.ts
 *
 * Ingests synthetic FIXTURE traces (3 receipt days, a cross-day session, a second tenant) through the
 * real TraceIngestor into a temp store, pins today's cohort, and runs runMemoryBuild with real Modal
 * build workspaces (one sandbox per agent: root -> child -> grandchild). Agent turns come from the
 * scripted fixture client, but every call goes through the same AgentToolbox path an LLM's tool calls
 * take (shell/read/grep/find/write...). Writes sanitized evidence to reports/trace-archive-modal-smoke.json
 * and exits non-zero if any check fails. Prints no credentials.
 */
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMemoryBuild } from "../src/harness/daily.js";
import { createModalBuildWorkspaceFactory } from "../src/harness/modal.js";
import { createProfileRegistry } from "../src/harness/profiles.js";
import { MemoryRepo } from "../src/store/memory.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { materializeCohort, pinDailyManifest, TraceIngestor, type TraceEvent } from "../src/traces/index.js";
import { sha256 } from "../src/util.js";
import { scripted, type ScriptStep } from "../tests/build-fixture.js";

const NS = "tenant-archive-smoke";
const OTHER = "tenant-archive-other";
const OLD = "sources/traces/2026-10-14/ses-old/events.jsonl";
const ALLOWED_ENV = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SCRATCH", "PWD", "SHLVL", "_", "OLDPWD"]);

const PROBE = `set +e
echo "uid=$(id -u)"
echo "pwd=$(pwd)"
echo "days=$(ls sources/traces | tr '\\n' ' ')"
echo "grep=$(grep -rl 'rate limited' sources/traces | sort | tr '\\n' ' ')"
echo "files=$(find sources -type f | wc -l)"
echo "sha=$(sha256sum ${OLD} | cut -c1-64)"
echo "other=$(grep -rl 'tenant-b-private-marker' /build /tmp /home /root /opt 2>/dev/null | head -3 | tr '\\n' ' ')"
head -c 160 ${OLD}; echo`;

const MUTATE = `set +e
f=${OLD}
before=$(sha256sum "$f" | cut -c1-64)
r() { if ( eval "$1" ) >/dev/null 2>&1; then echo "LEAK:$2"; else echo "denied:$2"; fi; }
r 'rm -f -- "$f" && [ ! -e "$f" ]' rm-event-file
r 'echo x >> "$f"' append-event-file
r 'echo x > sources/README.md' overwrite-readme
r 'ln -s /tmp sources/traces/link' symlink-in-sources
r 'mv sources/traces/2026-10-14 sources/traces/moved' rename-day-dir
r 'mv sources sources-moved' rename-sources-root
r 'rm -rf sources/traces/2026-10-15 && [ ! -e sources/traces/2026-10-15 ]' rm-rf-day
r 'chmod u+w "$f"' chmod-event-file
r 'touch knowledge/shell-write.md' knowledge-create
r 'mkdir knowledge/shell-dir' knowledge-mkdir
r 'ls work' work-read
r 'mkdir inputs/x' inputs-write
r 'touch published/x' published-write
r 'timeout 10 node -e "fetch(\\"https://example.com\\").then(()=>process.exit(0),()=>process.exit(1))"' network
echo "scratch=$(echo ok > "$SCRATCH/n" && cat "$SCRATCH/n")"
after=$(sha256sum "$f" | cut -c1-64)
[ "$before" = "$after" ] && echo "integrity=intact" || echo "integrity=CHANGED"
echo "env=$(env | cut -d= -f1 | sort | tr '\\n' ' ')"`;

interface Check {
  name: string;
  pass: boolean;
  detail?: unknown;
}
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail?: unknown) => {
  checks.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};

async function seed(store: DirectoryObjectStore) {
  const clock = { now: new Date() };
  const ing = new TraceIngestor(store, { now: () => clock.now });
  const ev = (sessionId: string, seq: number, type: TraceEvent["type"], data: unknown, extra: Partial<TraceEvent> = {}) =>
    ({ sessionId, seq, ts: new Date(clock.now.getTime() + seq * 1000).toISOString(), type, agent: { id: "fixture-agent", model: "fixture" }, data, ...extra }) as TraceEvent;
  const at = (day: string) => (clock.now = new Date(`${day}T12:00:00.000Z`));
  const blob = JSON.stringify({ rows: Array.from({ length: 2000 }, (_, i) => ({ i })) });
  at("2026-10-14");
  await ing.putBlob(NS, sha256(blob), Buffer.from(blob));
  await ing.ingestChunk(NS, { sessionId: "ses-old", chunkSeq: 1, events: [ev("ses-old", 1, "session_start", { objective: "Export invoices" }), ev("ses-old", 2, "error", { tool: "invoices.list", error: "429 rate limited" })] });
  await ing.ingestChunk(NS, { sessionId: "ses-old", chunkSeq: 2, final: true, events: [ev("ses-old", 3, "tool_result", { $blob: sha256(blob), bytes: blob.length, mediaType: "application/json" }), ev("ses-old", 4, "session_end", null, { outcome: { status: "succeeded", summary: "ok" } })] });
  await ing.ingestChunk(OTHER, { sessionId: "ses-secret-b", chunkSeq: 1, events: [ev("ses-secret-b", 1, "note", { secret: "tenant-b-private-marker" })] });
  at("2026-10-15");
  await ing.ingestChunk(NS, { sessionId: "ses-cross", chunkSeq: 1, events: [ev("ses-cross", 1, "session_start", { objective: "Rotate webhook" })] });
  at("2026-10-16");
  await ing.ingestChunk(NS, { sessionId: "ses-cross", chunkSeq: 2, final: true, events: [ev("ses-cross", 2, "session_end", null, { outcome: { status: "succeeded", summary: "ok" } })] });
  await ing.ingestChunk(NS, { sessionId: "ses-today", chunkSeq: 1, events: [ev("ses-today", 1, "session_start", { objective: "Refund a charge" })] });
}

const shell = (command: string) => ({ name: "shell", args: { command, timeoutMs: 60_000, maxOutputBytes: 12 * 1024 } });
const FS_WRITES = [
  { name: "write", args: { path: OLD, content: "x" } },
  { name: "delete", args: { path: "sources/README.md" } },
];

async function main() {
  const store = new DirectoryObjectStore(await mkdtemp(path.join(os.tmpdir(), "procmem-archive-smoke-")));
  await seed(store);
  const pin = await pinDailyManifest(store, NS, "2026-10-16");
  const inputs = await materializeCohort(store, NS, pin.manifest!);
  check("inputs = current cohort only", !inputs.has("sessions/ses-old/session.json") && inputs.has("sessions/ses-today/session.json"), [...inputs.keys()].filter((k) => k.endsWith("session.json")));

  const scripts: Record<string, ScriptStep[]> = {
    root: [
      [shell(PROBE), { name: "read", args: { path: OLD } }],
      [shell(MUTATE), ...FS_WRITES],
      [{ name: "spawn_agents", args: { agents: [{ objective: "billing", knowledgeWriteScope: ["billing"] }] } }],
      [{ name: "write", args: { path: "knowledge/index.md", content: "# Memory\n\n- [Billing](billing/index.md): billing.\n" } }],
      [{ name: "wait_agents", args: { timeoutMs: 600_000 } }],
      [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "accept", reason: "smoke" }] } }],
      [{ name: "publish", args: { summary: "trace archive modal smoke" } }],
    ],
    "root.1": [
      [shell(PROBE), { name: "grep", args: { pattern: "rate limited", path: "sources/traces/" } }],
      [shell(MUTATE), ...FS_WRITES],
      [{ name: "write", args: { path: "knowledge/billing/index.md", content: "# Billing\n\n- [Refunds](refunds.md): refunds.\n\n[Up](../index.md)\n" } }],
      [shell("cat knowledge/billing/index.md && (echo nope > knowledge/billing/index.md) 2>&1; echo exit=$?")],
      [{ name: "spawn_agents", args: { agents: [{ objective: "refunds", knowledgeWriteScope: ["billing/refunds.md"] }] } }],
      [{ name: "wait_agents", args: { timeoutMs: 600_000 } }],
      [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1.1", decision: "accept", reason: "smoke" }] } }],
      [{ name: "complete_task", args: { summary: "billing" } }],
    ],
    "root.1.1": [
      [shell(PROBE), { name: "find", args: { path: "sources/", name: "session.json" } }],
      [shell(MUTATE), ...FS_WRITES],
      [{ name: "write", args: { path: "knowledge/billing/refunds.md", content: "# Refunds\n\nRetry after 429 (ses-old#2).\n\n[Billing](index.md)\n" } }],
      [{ name: "complete_task", args: { summary: "refunds" } }],
    ],
  };
  const run = scripted(scripts);
  const workspaces: string[] = [];
  const modalFactory = createModalBuildWorkspaceFactory({ timeoutMs: 20 * 60_000, idleTimeoutMs: 10 * 60_000 });
  const started = Date.now();
  const receipt = await runMemoryBuild({
    repo: new MemoryRepo(store, NS),
    inputs,
    sources: [pin.manifest!.key],
    profiles: createProfileRegistry(),
    clientFactory: run.factory,
    workspaceFactory: (spec) => {
      const ws = modalFactory(spec);
      workspaces.push(`${spec.agentId}:${ws.kind}`);
      return ws;
    },
    budget: { waitDefaultMs: 60_000 },
    log: (e) => {
      if (e.event !== "tool_call") console.log(`[${e.agentId}] ${e.event}`);
    },
  });
  check("build published on Modal", receipt.status === "published" && receipt.workspaceBackend === "modal", { status: receipt.status, failure: receipt.failure, backend: receipt.workspaceBackend });
  check("archive non-empty", (receipt.traceArchive?.sessions ?? 0) === 3 && receipt.traceArchive?.days === 3, receipt.traceArchive);

  for (const agent of ["root", "root.1", "root.1.1"]) {
    const res = (run.results[agent] ?? []).filter((r) => r.name === "shell").map((r) => r.result);
    const probe = res[0];
    const mut = res[1];
    const out: string = probe?.stdout ?? "";
    check(`${agent}: shell offered`, (run.toolsSeen[agent] ?? []).includes("shell"));
    check(`${agent}: shell runs as reader uid in workspace root`, /uid=1001\n/.test(out) && /pwd=\/build\n/.test(out) && probe?.runAs === "sandbox-reader-uid", out.slice(0, 200));
    check(`${agent}: ls sources/traces lists all days`, out.includes("days=2026-10-14 2026-10-15 2026-10-16"), out.match(/days=.*/)?.[0]);
    check(`${agent}: grep reaches historical session`, out.includes("sources/traces/2026-10-14/ses-old/events.jsonl"), out.match(/grep=.*/)?.[0]);
    check(`${agent}: cat reads event content`, out.includes('"sessionId":"ses-old"'));
    check(`${agent}: other tenant invisible`, /other=\s*\n/.test(out), out.match(/other=.*/)?.[0]);
    const m: string = mut?.stdout ?? "";
    const leaks = m.split("\n").filter((l) => l.startsWith("LEAK"));
    const denied = m.split("\n").filter((l) => l.startsWith("denied")).length;
    check(`${agent}: every shell mutation/network attempt denied`, leaks.length === 0 && denied === 14, { leaks, denied });
    check(`${agent}: archive intact + scratch writable`, m.includes("integrity=intact") && m.includes("scratch=ok"));
    const envKeys = (m.match(/env=(.*)/)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    check(`${agent}: no secrets in command env`, envKeys.length > 0 && envKeys.every((k) => ALLOWED_ENV.has(k)), envKeys);
    const fsWrite = (run.results[agent] ?? []).filter((r) => r.name === "write" || r.name === "delete").map((r) => r.result).filter((r) => !r.ok);
    check(`${agent}: FS write/delete to sources rejected`, fsWrite.length === 2 && fsWrite.every((r) => r.error.code === "read_only"));
  }
  const childCat = (run.results["root.1"] ?? []).filter((r) => r.name === "shell").map((r) => r.result)[2]?.stdout ?? "";
  check("child shell reads its FS-tool draft but cannot write it", childCat.includes("# Billing") && /Permission denied/.test(childCat) && !/exit=0/.test(childCat), childCat.slice(0, 300));
  const files = receipt.status === "published" ? await new MemoryRepo(store, NS).files(receipt.revisionId) : new Map();
  check("scoped FS writes from all depths published", ["billing/index.md", "billing/refunds.md", "index.md"].every((p) => files.has(p)), [...files.keys()]);

  const report = { schema: "procmem.trace-archive-modal-smoke/v1", at: new Date().toISOString(), durationMs: Date.now() - started, workspaces, traceArchive: receipt.traceArchive, buildStatus: receipt.status, checks };
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile("reports/trace-archive-modal-smoke.json", JSON.stringify(report, null, 2) + "\n");
  const failed = checks.filter((c) => !c.pass);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed -> reports/trace-archive-modal-smoke.json`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
