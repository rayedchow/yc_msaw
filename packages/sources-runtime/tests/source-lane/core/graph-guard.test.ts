import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ensureDefaultKbForTenant } from "../../../src/graph/wiring/default-kb.js";
import {
  enqueueGraphDeleteForMirrorFile,
  enqueueGraphIngestForGoogleDocScopeEntry,
  enqueueGraphIngestForMirrorFile,
  graphIngestEnabled,
} from "../../../src/graph/wiring/ingest-hook.js";
import { assertSourceOnlyHandlers } from "../../../src/source-lane/worker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Static import closure (relative imports, including dynamic import("./x.js")) of the given files. */
function closure(starts: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = starts.map((s) => path.join(ROOT, s));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2]!;
      if (!spec.startsWith(".")) continue;
      let target = path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"));
      if (!existsSync(target) && existsSync(`${target}.ts`)) target = `${target}.ts`;
      if (existsSync(target) && target.endsWith(".ts")) stack.push(target);
    }
  }
  return new Set([...seen].map((f) => path.relative(ROOT, f).split(path.sep).join("/")));
}

const ENTRYPOINTS = ["api", "worker", "sweeper", "exporter"].map((e) => `src/source-lane/entrypoints/${e}.ts`);
const ALLOWED_GRAPH = new Set(["src/graph/wiring/ingest-hook.ts", "src/graph/wiring/default-kb.ts", "src/graph/bridge/session-windows.ts"]);

describe("source lane has no graph/LLM path", () => {
  const files = closure(ENTRYPOINTS);

  it("imports only the graph shims and the deterministic session-window helper", () => {
    const graph = [...files].filter((f) => f.startsWith("src/graph/"));
    expect(graph.filter((f) => !ALLOWED_GRAPH.has(f))).toEqual([]);
    expect(files.has("src/graph/bridge/chunker.ts")).toBe(false);
    for (const banned of ["src/wiki/", "src/chat/", "src/answerer/", "src/agent/", "src/api/", "src/mcp/", "src/entrypoints/"]) {
      expect([...files].filter((f) => f.startsWith(banned)), banned).toEqual([]);
    }
  });

  it("never pulls an LLM SDK into the source lane", () => {
    const external = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(path.join(ROOT, f), "utf8").matchAll(/from\s+["']([^."'][^"']*)["']/g)) external.add(m[1]!.split("/").slice(0, m[1]!.startsWith("@") ? 2 : 1).join("/"));
    }
    for (const sdk of ["ai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible", "@anthropic-ai/sdk", "modal", "web-tree-sitter", "ioredis"]) expect(external.has(sdk), sdk).toBe(false);
  });

  it("shims keep donor call sites working without touching the database or enqueueing work", async () => {
    const executor = { execute: () => Promise.reject(new Error("shim must not query")) } as never;
    expect(graphIngestEnabled()).toBe(false);
    await expect(enqueueGraphIngestForMirrorFile(executor, { tenantId: "t", path: "sources/x/y.md", contentSha: "x" })).resolves.toBeUndefined();
    await expect(enqueueGraphDeleteForMirrorFile(executor, { tenantId: "t", path: "sources/x/y.md" })).resolves.toBeUndefined();
    await expect(enqueueGraphIngestForGoogleDocScopeEntry(executor, { tenantId: "t", docId: "d", mirrorPathPrefix: null, folderIds: [], previousFolderIds: [] })).resolves.toBeUndefined();
    await expect(ensureDefaultKbForTenant(executor, "t")).resolves.toEqual({ kbId: null, attachedProviders: [] });
  });

  it("refuses graph task handlers by kind", () => {
    expect(() => assertSourceOnlyHandlers({ "graph.extract_chunks": async () => undefined })).toThrow(/refuses/);
    expect(() => assertSourceOnlyHandlers({ "wiki.render": async () => undefined })).toThrow(/refuses/);
    expect(() => assertSourceOnlyHandlers({ "gdocs.poll": async () => undefined })).not.toThrow();
  });
});
