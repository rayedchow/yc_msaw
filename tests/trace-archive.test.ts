/**
 * sources/ trace archive: store -> archive snapshot -> every build agent's workspace.
 * Trace events here are synthetic test fixtures ingested through the real TraceIngestor;
 * agent turns come from the scripted FIXTURE client (deterministic, not model behavior).
 */
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { runMemoryBuild } from "../src/harness/daily.js";
import { createProfileRegistry } from "../src/harness/profiles.js";
import { LocalBuildWorkspace, localWorkspaceFactory, trustedLocalCommandWorkspaceFactory, type BuildWorkspaceFactory } from "../src/harness/workspace.js";
import { MemoryRepo } from "../src/store/memory.js";
import { DirectoryObjectStore, type ObjectStore } from "../src/store/objects.js";
import {
  buildTraceArchive,
  emptyTraceArchive,
  materializeCohort,
  pinDailyManifest,
  readTraceArchiveBundle,
  TraceArchiveCache,
  TraceArchiveError,
  TraceIngestor,
  type TraceEvent,
} from "../src/traces/index.js";
import { traceArchiveCacheBytesFromEnv } from "../src/traces/archive.js";
import { chunkIndexKey } from "../src/traces/schema.js";
import { normalizeVirtualPath, sandboxPath } from "../src/customer/paths.js";
import { sha256 } from "../src/util.js";
import { scripted, type ScriptStep } from "./build-fixture.js";

const NS = "tenant-a";
const OTHER = "tenant-b";
const profiles = createProfileRegistry();

let store: DirectoryObjectStore;
let clock: { now: Date };
let ingestor: TraceIngestor;
const sent: TraceEvent[] = [];
const blobBody = JSON.stringify({ rows: Array.from({ length: 3000 }, (_, i) => ({ i, note: `row ${i} of the paginated export` })) });
const blobSha = sha256(blobBody);
const bigInline = { html: "<p>".concat("x".repeat(70 * 1024), "</p>") };

function ev(sessionId: string, seq: number, type: TraceEvent["type"], data: unknown, extra: Partial<TraceEvent> = {}): TraceEvent {
  return { sessionId, seq, ts: new Date(clock.now.getTime() + seq * 1000).toISOString(), type, agent: { id: "agent-a", model: "kimi-k2" }, data, ...extra } as TraceEvent;
}

async function ingest(ns: string, day: string, sessionId: string, chunkSeq: number, events: TraceEvent[], final = false) {
  clock.now = new Date(`${day}T12:00:00.000Z`);
  if (ns === NS) sent.push(...events);
  return ingestor.ingestChunk(ns, { sessionId, chunkSeq, events, ...(final ? { final } : {}) });
}

async function seedStore() {
  // Day 1 (2026-10-14): a complete historical session with a blob payload and a large inline payload.
  clock.now = new Date("2026-10-14T12:00:00.000Z");
  await ingestor.putBlob(NS, blobSha, Buffer.from(blobBody));
  await ingest(NS, "2026-10-14", "ses-old", 1, [
    ev("ses-old", 1, "session_start", { objective: "Export invoices with pagination" }),
    ev("ses-old", 2, "tool_call", { tool: "invoices.list", args: { cursor: null, limit: 500 } }),
    ev("ses-old", 3, "error", { tool: "invoices.list", error: "429 rate limited; retry-after 2" }, { usage: { inputTokens: 10, outputTokens: 2 } }),
  ]);
  await ingest(NS, "2026-10-14", "ses-old", 2, [
    ev("ses-old", 4, "tool_result", { $blob: blobSha, bytes: Buffer.byteLength(blobBody), mediaType: "application/json" }),
    ev("ses-old", 5, "model_output", bigInline),
    ev("ses-old", 6, "session_end", null, { outcome: { status: "succeeded", summary: "exported" } }),
  ], true);
  // A session whose chunks arrive on two receipt days.
  await ingest(NS, "2026-10-15", "ses-cross", 1, [ev("ses-cross", 1, "session_start", { objective: "Rotate a webhook secret" }), ev("ses-cross", 2, "tool_call", { tool: "webhooks.rotate", args: { id: "wh_1" } })]);
  await ingest(NS, "2026-10-16", "ses-cross", 2, [ev("ses-cross", 3, "tool_result", { ok: true }), ev("ses-cross", 4, "session_end", null, { outcome: { status: "succeeded", summary: "rotated" } })], true);
  // Today's cohort session.
  await ingest(NS, "2026-10-16", "ses-today", 1, [ev("ses-today", 1, "session_start", { objective: "Refund a charge" }), ev("ses-today", 2, "tool_call", { tool: "billing.refund", args: { chargeId: "ch_1" } })]);
  // Another tenant: must never be visible.
  await ingest(OTHER, "2026-10-14", "ses-secret-b", 1, [ev("ses-secret-b", 1, "note", { secret: "tenant-b-private-marker" })]);
}

beforeEach(async () => {
  store = new DirectoryObjectStore(await mkdtemp(path.join(os.tmpdir(), "procmem-archive-test-")));
  clock = { now: new Date("2026-10-14T00:00:00.000Z") };
  ingestor = new TraceIngestor(store, { now: () => clock.now });
  sent.length = 0;
  await seedStore();
});

/** Simulate on-disk corruption behind the immutable store API. */
async function tamper(ns: string, key: string, bytes: Buffer) {
  const file = path.join(store.root, ns, "objects", ...key.split("/"));
  await fs.rm(file, { force: true });
  await fs.writeFile(file, bytes);
}

function parseJsonl(text: string): any[] {
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("trace archive snapshot", () => {
  it("contains every retained day/session partition, cross-day links and full payloads", async () => {
    const a = await buildTraceArchive(store, NS);
    expect(a.dayList).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(a.stats).toMatchObject({ days: 3, sessions: 3, partitions: 4, chunks: 5, events: 12, unindexedChunks: 0 });
    expect([...a.files.keys()].filter((k) => k.endsWith("events.jsonl")).sort()).toEqual([
      "traces/2026-10-14/ses-old/events.jsonl",
      "traces/2026-10-15/ses-cross/events.jsonl",
      "traces/2026-10-16/ses-cross/events.jsonl",
      "traces/2026-10-16/ses-today/events.jsonl",
    ]);
    expect(a.files.has("README.md") && a.files.has("manifest.json") && a.files.has("traces/2026-10-15/index.json")).toBe(true);

    // Cross-day session: one directory per receipt day, linked both ways; whole-session view is complete.
    const cross1 = JSON.parse(a.files.get("traces/2026-10-15/ses-cross/session.json")!);
    const cross2 = JSON.parse(a.files.get("traces/2026-10-16/ses-cross/session.json")!);
    expect(cross1.archive.otherDays).toEqual(["2026-10-16"]);
    expect(cross2.archive.otherDays).toEqual(["2026-10-15"]);
    expect(cross1.complete).toBe(false);
    expect(cross1.archive.session).toMatchObject({ events: 4, firstSeq: 1, lastSeq: 4, complete: true, objective: "Rotate a webhook secret", outcome: "succeeded" });
    expect(JSON.parse(a.files.get("manifest.json")!).sessions["ses-cross"].days).toEqual(["2026-10-15", "2026-10-16"]);

    // Every event the SDK sent is reconstructable exactly (ids, args, errors, usage, outcome, payload bytes).
    const byRef = new Map<string, any>();
    for (const [k, v] of a.files) {
      if (!k.endsWith("events.jsonl")) continue;
      const dir = k.slice(0, -"events.jsonl".length);
      for (const e of parseJsonl(v)) byRef.set(e.ref, { e, dir });
    }
    expect(byRef.size).toBe(sent.length);
    for (const orig of sent) {
      const { e, dir } = byRef.get(`${orig.sessionId}#${orig.seq}`)!;
      const { ref: _ref, data, ...rest } = e;
      const { data: origData, ...origRest } = orig as any;
      expect(rest).toEqual(origRest);
      if (data && typeof data === "object" && "$payload" in data) {
        const payload = a.files.get(`${dir}${data.$payload}`)!;
        if (origData.$blob) {
          expect(sha256(payload)).toBe(origData.$blob);
          expect(payload).toBe(blobBody);
        } else expect(JSON.parse(payload)).toEqual(origData);
      } else expect(data).toEqual(origData);
    }
    // Round trip through the workspace bundle is digest-verified.
    expect(readTraceArchiveBundle(a.bundle()).sha256).toBe(a.sha256);
  });

  it("is strictly tenant-isolated", async () => {
    const a = await buildTraceArchive(store, NS);
    for (const [k, v] of a.files) {
      expect(k).not.toContain("secret-b");
      expect(v).not.toContain("tenant-b-private-marker");
    }
    const b = await buildTraceArchive(store, OTHER);
    expect([...b.sessionDays.keys()]).toEqual(["ses-secret-b"]);
  });

  it("pages listings and batches reads without changing the result", async () => {
    const calls = { list: 0, get: [] as number[] };
    const counting: ObjectStore = new Proxy(store, {
      get(target, prop, recv) {
        if (prop === "list") return (ns: string, prefix: string, o?: any) => ((calls.list += 1), target.list(ns, prefix, o));
        if (prop === "get") return (ns: string, keys: string[]) => (calls.get.push(keys.length), target.get(ns, keys));
        return Reflect.get(target, prop, recv);
      },
    });
    const full = await buildTraceArchive(store, NS);
    const paged = await buildTraceArchive(counting, NS, { listPageSize: 2, maxGetKeys: 2 });
    expect(paged.sha256).toBe(full.sha256);
    expect(calls.list).toBeGreaterThanOrEqual(3);
    expect(Math.max(...calls.get)).toBeLessThanOrEqual(2);
  });

  it("fails explicitly over the configured caps instead of dropping traces", async () => {
    await expect(buildTraceArchive(store, NS, { maxBytes: 4096 })).rejects.toMatchObject({ code: "archive_too_large" });
    await expect(buildTraceArchive(store, NS, { maxFiles: 6 })).rejects.toMatchObject({ code: "archive_too_large" });
    await expect(buildTraceArchive(store, NS, { maxBytes: 4096 })).rejects.toThrow(/PROCMEM_TRACE_ARCHIVE_MAX_BYTES/);
  });

  it("fails closed on a tampered chunk", async () => {
    const key = "traces/2026-10-14/ses-old/chunk-000001.jsonl.gz";
    await tamper(NS, key, gzipSync(Buffer.from('{"tampered":true}\n')));
    const err = await buildTraceArchive(store, NS).catch((e) => e);
    expect(err).toBeInstanceOf(TraceArchiveError);
    expect(err.code).toBe("archive_integrity");
  });

  it("fails closed when a referenced blob is missing", async () => {
    const dir = store.root;
    const hits: string[] = [];
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.includes(`${path.sep}blobs${path.sep}`) && p.includes(blobSha)) hits.push(p);
      }
    };
    await walk(dir);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) await fs.rm(h);
    await expect(buildTraceArchive(store, NS)).rejects.toMatchObject({ code: "archive_integrity" });
  });

  it("reuses immutable partitions across builds and re-renders only what changed", async () => {
    const cache = new TraceArchiveCache();
    const first = await buildTraceArchive(store, NS, { cache });
    expect(first.stats).toMatchObject({ cachedPartitions: 0, renderedPartitions: 4 });
    const again = await buildTraceArchive(store, NS, { cache });
    expect(again.stats).toMatchObject({ cachedPartitions: 4, renderedPartitions: 0 });
    expect(again.sha256).toBe(first.sha256);
    await ingest(NS, "2026-10-17", "ses-today", 2, [ev("ses-today", 3, "tool_result", { status: "refunded" })]);
    const later = await buildTraceArchive(store, NS, { cache });
    expect(later.stats).toMatchObject({ cachedPartitions: 4, renderedPartitions: 1, partitions: 5 });
    expect(JSON.parse(later.files.get("traces/2026-10-16/ses-today/session.json")!).archive.otherDays).toEqual(["2026-10-17"]);
    // A cache entry can never serve another tenant.
    const b = await buildTraceArchive(store, OTHER, { cache });
    expect(b.stats.cachedPartitions).toBe(0);
  });

  it("maxFiles counts rendered files, not stored chunks (100 chunks of one session fit in 5 files)", async () => {
    const solo = "tenant-many-chunks";
    clock.now = new Date("2026-10-13T12:00:00.000Z");
    for (let i = 1; i <= 100; i++) await ingestor.ingestChunk(solo, { sessionId: "ses-chunky", chunkSeq: i, events: [ev("ses-chunky", i, "note", { i })] });
    // Expected tree written out by hand: README.md, manifest.json, one day index, one session.json, one events.jsonl.
    const a = await buildTraceArchive(store, solo, { maxFiles: 5 });
    expect([...a.files.keys()].sort()).toEqual(["README.md", "manifest.json", "traces/2026-10-13/index.json", "traces/2026-10-13/ses-chunky/events.jsonl", "traces/2026-10-13/ses-chunky/session.json"]);
    expect(a.stats.chunks).toBe(100);
    expect(parseJsonl(a.files.get("traces/2026-10-13/ses-chunky/events.jsonl")!).map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    await expect(buildTraceArchive(store, solo, { maxFiles: 4 })).rejects.toMatchObject({ code: "archive_too_large" });
    // The separate stored-chunk budget bounds listing/read cost and fails before reading chunks.
    await expect(buildTraceArchive(store, solo, { maxChunks: 99 })).rejects.toThrow(/maxChunks=99.*PROCMEM_TRACE_ARCHIVE_MAX_CHUNKS/);
    expect((await buildTraceArchive(store, solo, { maxChunks: 100 })).stats.chunks).toBe(100);
  });

  it("unindexed chunks are verified with bounded decompression and fail explicitly when corrupt", async () => {
    const key = "traces/2026-10-14/ses-old/chunk-000001.jsonl.gz";
    const indexFile = path.join(store.root, NS, "objects", ...chunkIndexKey("ses-old", 1).split("/"));
    await fs.rm(indexFile);
    const ok = await buildTraceArchive(store, NS);
    expect(ok.stats.unindexedChunks).toBe(1);
    expect(parseJsonl(ok.files.get("traces/2026-10-14/ses-old/events.jsonl")!).map((e) => e.ref)).toContain("ses-old#3");

    await tamper(NS, key, Buffer.from("definitely not gzip"));
    await expect(buildTraceArchive(store, NS)).rejects.toMatchObject({ code: "archive_integrity", message: expect.stringMatching(/not valid gzip/) });

    // ~3 MiB of output from a few KiB of gzip: rejected at the chunk limit instead of being inflated.
    await tamper(NS, key, gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x61)));
    await expect(buildTraceArchive(store, NS)).rejects.toMatchObject({ code: "archive_integrity", message: expect.stringMatching(/decompresses past the \d+-byte chunk limit/) });
  });

  it("validates the cache size setting instead of silently disabling it", () => {
    expect(traceArchiveCacheBytesFromEnv({})).toBe(64 * 1024 * 1024);
    expect(traceArchiveCacheBytesFromEnv({ PROCMEM_TRACE_ARCHIVE_CACHE_BYTES: "0" })).toBe(0);
    expect(traceArchiveCacheBytesFromEnv({ PROCMEM_TRACE_ARCHIVE_CACHE_BYTES: "1048576" })).toBe(1048576);
    for (const bad of ["abc", "-5", "1.5", "NaN", "1e6"]) expect(() => traceArchiveCacheBytesFromEnv({ PROCMEM_TRACE_ARCHIVE_CACHE_BYTES: bad }), bad).toThrow(/non-negative integer/);
    expect(() => new TraceArchiveCache(-1)).toThrow();
    expect(() => new TraceArchiveCache(Number.NaN)).toThrow();
    const off = new TraceArchiveCache(0);
    expect(off.size).toBe(0);
  });

  it("the customer MCP path space cannot name the builder archive", () => {
    for (const p of ["sources/README.md", "/build/sources/manifest.json", "$KNOWLEDGE/../sources", "$WORK/../../build/sources", "$WORK/scratch/../../sources"]) {
      let resolved: string | null = null;
      try {
        const vp = normalizeVirtualPath(p);
        expect(sandboxPath(vp), p).not.toMatch(/^\/build(\/|$)/);
        resolved = `${vp.root}:${vp.rel}`;
      } catch {
        /* rejected */
      }
      if (resolved !== null) expect(resolved, p).toMatch(/^(knowledge|scratch):/);
      if (resolved !== null) expect(resolved, p).not.toMatch(/^(knowledge|scratch):(\.\.|.*\/\.\.)/);
    }
  });

  it("an empty tenant yields a navigable empty tree", async () => {
    const e = await buildTraceArchive(store, "tenant-empty");
    expect([...e.files.keys()].sort()).toEqual(["README.md", "manifest.json"]);
    expect(e.files.get("README.md")).toContain("No traces are retained");
    expect(emptyTraceArchive("tenant-empty", { disabled: true }).files.get("README.md")).toContain("disabled");
  });
});

// ---------------------------------------------------------------------------
// Build integration: inputs/ = today's cohort only; sources/ = all history, read-only for every depth.
// ---------------------------------------------------------------------------

const OLD_EVENTS = "sources/traces/2026-10-14/ses-old/events.jsonl";
const WRITE_ATTEMPTS = [
  { name: "write", args: { path: OLD_EVENTS, content: "x" } },
  { name: "edit", args: { path: OLD_EVENTS, old_text: "429", new_text: "200" } },
  { name: "move", args: { from: OLD_EVENTS, to: "work/stolen.jsonl" } },
  { name: "delete", args: { path: "sources/README.md" } },
];
const SHELL_READ = { name: "shell", args: { command: "ls sources/traces && grep -rl 'rate limited' sources/traces | sort && head -c 200 sources/traces/2026-10-14/ses-old/session.json && pwd" } };
const SHELL_MUTATE = {
  name: "shell",
  args: { command: `rm -f ${OLD_EVENTS}; echo hacked > sources/README.md; ln -s /tmp sources/traces/link; mv sources/traces/2026-10-14 sources/traces/moved; test -f ${OLD_EVENTS} && echo STILL_THERE` },
};

async function cohortInputs() {
  const pin = await pinDailyManifest(store, NS, "2026-10-16");
  return { manifest: pin.manifest!, inputs: await materializeCohort(store, NS, pin.manifest!) };
}

async function buildWith(scripts: Record<string, ScriptStep[]>, workspaceFactory: BuildWorkspaceFactory = trustedLocalCommandWorkspaceFactory, extra: Record<string, unknown> = {}) {
  const repo = new MemoryRepo(store, NS);
  const { manifest, inputs } = await cohortInputs();
  const run = scripted(scripts);
  const receipt = await runMemoryBuild({ repo, inputs, sources: [manifest.key], profiles, clientFactory: run.factory, workspaceFactory, budget: { waitDefaultMs: 5_000 }, ...extra });
  return { run, receipt, repo, inputs };
}

const results = (run: ReturnType<typeof scripted>, agent: string, tool: string) => (run.results[agent] ?? []).filter((r) => r.name === tool).map((r) => r.result);

describe("sources/ in the build tree", () => {
  it("root, child and grandchild read the archive (FS tools + shell) and none can mutate it", async () => {
    const { run, receipt, inputs } = await buildWith({
      root: [
        [{ name: "ls", args: { path: "sources/traces/" } }, { name: "read", args: { path: OLD_EVENTS } }, SHELL_READ],
        WRITE_ATTEMPTS,
        [SHELL_MUTATE],
        [{ name: "spawn_agents", args: { agents: [{ objective: "Billing branch", knowledgeWriteScope: ["billing"] }] } }],
        [{ name: "write", args: { path: "knowledge/index.md", content: "# Memory\n\n- [Billing](billing/index.md): refunds.\n" } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "accept", reason: "ok" }] } }],
        [{ name: "publish", args: { summary: "billing" } }],
      ],
      "root.1": [
        [{ name: "grep", args: { pattern: "rate limited", path: "sources/traces/" } }, SHELL_READ],
        WRITE_ATTEMPTS,
        [{ name: "write", args: { path: "knowledge/billing/index.md", content: "# Billing\n\n- [Refunds](refunds.md): refunds.\n\n[Up](../index.md)\n" } }],
        [{ name: "spawn_agents", args: { agents: [{ objective: "Refunds", knowledgeWriteScope: ["billing/refunds.md"] }] } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1.1", decision: "accept", reason: "ok" }] } }],
        [{ name: "complete_task", args: { summary: "billing" } }],
      ],
      "root.1.1": [
        [{ name: "find", args: { path: "sources/", name: "session.json" } }, SHELL_READ],
        [...WRITE_ATTEMPTS, SHELL_MUTATE],
        [{ name: "write", args: { path: "knowledge/billing/refunds.md", content: "# Refunds\n\nRetry 429s after retry-after (ses-old#3).\n\n[Billing](index.md)\n" } }],
        [{ name: "complete_task", args: { summary: "refunds" } }],
      ],
    });
    expect(receipt.status).toBe("published");
    expect(receipt.traceArchive).toMatchObject({ days: 3, sessions: 3, disabled: false });

    // inputs/ is only today's cohort; the old session is only under sources/.
    const inputSessions = [...inputs.keys()].filter((k) => k.endsWith("session.json")).sort();
    expect(inputSessions).toEqual(["sessions/ses-cross/session.json", "sessions/ses-today/session.json"]);

    for (const agent of ["root", "root.1", "root.1.1"]) {
      const shell = results(run, agent, "shell")[0];
      expect(shell.ok, agent).toBe(true);
      expect(shell.exitCode).toBe(0);
      expect(shell.stdout).toContain("2026-10-14\n2026-10-15\n2026-10-16");
      expect(shell.stdout).toContain("traces/2026-10-14/ses-old/events.jsonl");
      expect(shell.stdout).toContain('"sessionId": "ses-old"');
      for (const r of results(run, agent, "write").filter((x) => !x.ok)) expect(r.error.code).toBe("read_only");
      for (const tool of ["edit", "move", "delete"]) expect(results(run, agent, tool)[0].error.code, `${agent} ${tool}`).toBe("read_only");
      expect(run.systemPrompts[agent]).toContain("sources/ (read-only, OS-enforced) is the archive of ALL retained traces");
      expect(run.toolsSeen[agent]).toContain("shell");
    }
    expect(results(run, "root", "read")[0].content).toContain("rate limited");
    expect(results(run, "root.1", "grep")[0].matches[0]).toMatch(/^sources\/traces\/2026-10-14\/ses-old\/events\.jsonl:3: /);
    expect(results(run, "root.1.1", "find")[0].paths).toContain("sources/traces/2026-10-14/ses-old/session.json");

    // Shell mutations had no effect (file modes; OS uid isolation is proven by the Modal smoke).
    if (process.getuid?.() !== 0) {
      for (const agent of ["root", "root.1.1"]) {
        const m = results(run, agent, "shell").at(-1);
        expect(m.stdout).toContain("STILL_THERE");
      }
    }
    // Root task prompt carries the host-computed archive facts.
    const rootTask = run.firstMessages.root!.find((m) => m.role === "user")!.content!;
    expect(rootTask).toMatch(/Trace archive \(sources\/, snapshot [0-9a-f]{12}\): 3 day\(s\) \[2026-10-14, 2026-10-15, 2026-10-16\], 3 session\(s\) \(1 historical, 2 also in today's cohort\)/);
    // Knowledge writes within scope still work through the FS tools.
    const files = await new MemoryRepo(store, NS).files(receipt.revisionId);
    expect([...files.keys()].sort()).toEqual(["billing/index.md", "billing/refunds.md", "index.md"]);
  });

  it("default local backend mounts sources/ but offers no shell", async () => {
    const { run, receipt } = await buildWith(
      {
        root: [[{ name: "ls", args: { path: "sources/" } }, { name: "shell", args: { command: "ls" } }], [{ name: "publish", args: { summary: "nothing new" } }]],
      },
      localWorkspaceFactory,
    );
    expect(receipt.status).toBe("no_change");
    expect(run.toolsSeen.root).not.toContain("shell");
    expect(results(run, "root", "shell")[0].error.code).toBe("not_available");
    expect(results(run, "root", "ls")[0].entries.map((e: any) => e.path)).toEqual(expect.arrayContaining(["sources/README.md", "sources/manifest.json", "sources/traces/"]));
  });

  it("an archive integrity failure fails the build explicitly and keeps the head", async () => {
    const repo = new MemoryRepo(store, NS);
    const head = await repo.ensureHead();
    const { manifest, inputs } = await cohortInputs();
    await tamper(NS, "traces/2026-10-14/ses-old/chunk-000002.jsonl.gz", gzipSync(Buffer.from("{}\n")));
    const run = scripted({ root: [[{ name: "publish", args: { summary: "x" } }]] });
    const receipt = await runMemoryBuild({ repo, inputs, sources: [manifest.key], profiles, clientFactory: run.factory, workspaceFactory: localWorkspaceFactory });
    expect(receipt.status).toBe("failed");
    expect(receipt.failure?.code).toBe("trace_archive_failed");
    expect(receipt.traceArchive).toBeNull();
    expect(receipt.revisionId).toBe(head);
    expect(receipt.attempts).toEqual([]);
  });

  it("rejects a snapshot from another tenant and supports an explicit disabled archive", async () => {
    const other = await buildTraceArchive(store, OTHER);
    const { receipt } = await buildWith({ root: [[{ name: "publish", args: { summary: "x" } }]] }, localWorkspaceFactory, { traceArchive: other });
    expect(receipt.failure?.code).toBe("trace_archive_failed");
    const { run, receipt: r2 } = await buildWith({ root: [[{ name: "read", args: { path: "sources/README.md" } }], [{ name: "publish", args: { summary: "x" } }]] }, localWorkspaceFactory, { traceArchive: "disabled" });
    expect(r2.traceArchive).toMatchObject({ disabled: true, sessions: 0 });
    expect(results(run, "root", "read")[0].content).toContain("disabled");
  });

  it("knowledge symlinks cannot be used to write into sources/", async () => {
    const ws = new LocalBuildWorkspace();
    await ws.init({ inputs: new Map(), sources: await buildTraceArchive(store, NS), published: new Map(), knowledge: new Map(), parentDraft: null });
    const target = path.join(ws.rootDir, "sources", "README.md");
    const before = await fs.readFile(target, "utf8");
    await fs.symlink(target, path.join(ws.rootDir, "knowledge", "evil.md"));
    await expect(ws.writeFile("knowledge", "evil.md", "pwned")).rejects.toMatchObject({ code: "invalid_path" });
    expect(await fs.readFile(target, "utf8")).toBe(before);
    await expect(ws.runCommand({ command: "ls", timeoutMs: 1000, maxOutputBytes: 100 })).rejects.toMatchObject({ code: "unsupported" });
    await ws.dispose();
  });
});
