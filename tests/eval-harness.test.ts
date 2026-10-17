import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { InProcessTraceTransport } from "../src/sdk/index.js";
import { TraceIngestor } from "../src/traces/index.js";
import { FireworksAuthError, parseDotEnv, sanitize } from "../eval/fireworks.js";
import { startFixtureMemoryServer, type FixtureMemoryServer } from "../eval/fixture-memory-server.js";
import { runMcpProbe } from "../eval/mcp-probe.js";
import { findRevision, runEval } from "../eval/run.js";

describe("eval helpers", () => {
  it("parses .env and sanitizes secrets", () => {
    expect(parseDotEnv("# c\nexport A='x y'\nB=\"q\"\nFIREWORKS_API_KEY=fw_abc\n")).toEqual({ A: "x y", B: "q", FIREWORKS_API_KEY: "fw_abc" });
    const s = sanitize({ headers: { Authorization: "Bearer abcdefghijklmnop" }, note: "key=supersecretvalue1" }, ["supersecretvalue1"]);
    expect(JSON.stringify(s)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(s)).not.toContain("supersecretvalue1");
  });

  it("finds the published revision in receipts of various shapes", () => {
    expect(findRevision({ publishedRevision: "r1" })).toBe("r1");
    expect(findRevision({ result: { published: { revision: { id: "r2" } } } })).toBe("r2");
    expect(findRevision({ ok: true })).toBeNull();
  });

  it("aborts live mode on 401 before any model call", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 401 });
    }) as typeof fetch;
    let built = false;
    await expect(
      runEval(
        {
          apiKey: "fw_invalid_key_for_test",
          mcpUrl: "http://127.0.0.1:1/mcp",
          triggerDailyBuild: async () => {
            built = true;
            return {};
          },
          fetchImpl,
        },
        { mode: "live", trainModel: "kimi", evalModels: ["glm"], reportDir: null },
      ),
    ).rejects.toBeInstanceOf(FireworksAuthError);
    expect(calls).toBe(1);
    expect(built).toBe(false);
  });
});

describe("Pi MCP extension <-> mcp-use server (no model)", () => {
  it("lists and calls an mcp-use tool through Pi's MCP extension", async () => {
    const r = await runMcpProbe();
    expect(r.error).toBeUndefined();
    expect(r.activeTools).toEqual(["mcp__memory__echo"]);
    expect(r.toolCallResultText).toBe("ECHO:HELLO MCP");
    expect(r.serverSawAuthHeader).toBe(true);
    expect(r.ok).toBe(true);
  }, 30_000);
});

describe("runEval scripted-fixture (offline, Pi faux model + real trace SDK + real MCP)", () => {
  let fixture: FixtureMemoryServer;
  let root: string;
  beforeAll(async () => {
    fixture = await startFixtureMemoryServer();
    root = await mkdtemp(path.join(tmpdir(), "eval-harness-"));
  });
  afterAll(async () => {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });

  it("runs train -> build -> held-out memory vs no-memory end to end", async () => {
    const store = new DirectoryObjectStore(root);
    const ingestor = new TraceIngestor(store);
    let builds = 0;
    const report = await runEval(
      {
        mcpUrl: fixture.url,
        mcpHeaders: fixture.headers,
        traceTransportFactory: () => new InProcessTraceTransport(ingestor, "tenant-eval"),
        triggerDailyBuild: async () => {
          builds += 1;
          return fixture.publish();
        },
      },
      {
        mode: "scripted-fixture",
        trainModel: "reference",
        evalModels: ["policy"],
        heldoutScenarios: ["heldout-x"],
        concurrency: 2,
        reportDir: null,
      },
    );
    expect(report.label).toBe("scripted-fixture");
    expect(builds).toBe(1);
    expect(report.build.publishedRevision).toBe("rev-fixture-1");
    expect(report.phaseA).toHaveLength(2);
    expect(report.phaseA.every((r) => r.success && r.traced && r.label === "scripted-fixture")).toBe(true);
    expect(report.checks.trainRunsTraced).toBe(true);
    expect(report.checks.traceCapturesPromptAndTools).toBe(true);
    // Trace data actually landed in the store.
    const listing = await readdir(root, { recursive: true });
    expect(listing.some((p) => String(p).includes("traces"))).toBe(true);

    const mem = report.phaseB.find((r) => r.condition === "memory")!;
    const base = report.phaseB.find((r) => r.condition === "no-memory")!;
    expect(mem.memoryToolCalls).toBeGreaterThanOrEqual(2); // open_memory + read
    expect(mem.memoryToolNames).toEqual(["mcp__memory__open_memory", "mcp__memory__read"]);
    expect(mem.success).toBe(true);
    expect(base.memoryToolCalls).toBe(0);
    expect(base.success).toBe(false);
    expect(base.duplicates).toBeGreaterThan(0);
    expect(base.activeTools).toEqual(["deliver", "get_deliveries", "list_notifications"]);
    expect(fixture.calls().open_memory).toBe(1);
    expect(fixture.calls().read).toBeGreaterThanOrEqual(2); // explicit index.md read + linked page
    expect(JSON.stringify(report)).not.toContain("fixture-token");
  }, 60_000);
});
