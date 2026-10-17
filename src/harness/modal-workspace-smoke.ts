/**
 * Real Modal smoke for ModalBuildWorkspace (one sandbox): seeds the areas,
 * exercises list/read/grep/write/remove/snapshot through the build toolbox,
 * and checks that protected areas are OS-read-only for the agent uid.
 *
 *   npx tsx src/harness/modal-workspace-smoke.ts
 *
 * Writes reports/build-modal-workspace-smoke.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createModalLease } from "../sandbox/modal.js";
import type { SandboxLease } from "../sandbox/types.js";
import { AgentToolbox, renderOutcome, resolveProviderTools, type ControlPlane } from "./tools.js";
import { ModalBuildWorkspace } from "./workspace.js";
import { parseScope } from "./scope.js";

async function main() {
  let lease: SandboxLease | null = null;
  const ws = new ModalBuildWorkspace(async () => (lease = await createModalLease({ tags: { purpose: "procmem-build-smoke" } })));
  const checks: Array<{ name: string; ok: boolean; detail: unknown }> = [];
  const check = (name: string, ok: boolean, detail: unknown) => {
    checks.push({ name, ok, detail });
    console.error(`${ok ? "PASS" : "FAIL"} ${name}`);
  };
  const started = Date.now();
  try {
    await ws.init({
      inputs: new Map([
        ["manifest.json", '{"sessions":["S-1"]}'],
        ["sessions/S-1/events.jsonl", '{"seq":1,"msg":"Idempotency-Key required"}\n{"seq":2,"msg":"ok"}\n'],
      ]),
      published: new Map([["index.md", "# Memory\n"]]),
      knowledge: new Map([["index.md", "# Memory\n"], ["guides/setup.md", "# Setup\n"]]),
      parentDraft: new Map([["index.md", "# Memory\n"]]),
    });
    const tb = new AgentToolbox(
      { agentId: "root.1", depth: 1, buildId: "smoke", isRoot: false, workspace: ws, scope: parseScope(["guides"]), declaredMoves: [], signal: new AbortController().signal },
      {} as ControlPlane,
      resolveProviderTools([], true),
    );
    const call = async (name: string, args: unknown) => JSON.parse(renderOutcome(await tb.invoke(name, JSON.stringify(args))).text);
    const ls = await call("ls", { path: "inputs/", recursive: true });
    check("ls inputs recursive", ls.ok && ls.totalFiles === 2, ls);
    const rd = await call("read", { path: "inputs/sessions/S-1/events.jsonl", offset: 2, limit: 1 });
    check("read line slice", rd.ok && rd.content === '{"seq":2,"msg":"ok"}', rd);
    const gr = await call("grep", { pattern: "idempotency-key", path: "inputs/" });
    check("grep literal ignoreCase", gr.ok && gr.matches[0] === 'inputs/sessions/S-1/events.jsonl:1: {"seq":1,"msg":"Idempotency-Key required"}', gr);
    const fd = await call("find", { path: "inputs/", name: "*.jsonl" });
    check("find glob", fd.ok && fd.paths[0] === "inputs/sessions/S-1/events.jsonl", fd);
    const w = await call("write", { path: "knowledge/guides/retries.md", content: "# Retries\n" });
    check("write in scope", w.ok && w.created === true, w);
    const ed = await call("edit", { path: "knowledge/guides/setup.md", old_text: "# Setup", new_text: "# Setup guide" });
    check("edit in scope", ed.ok, ed);
    const mv = await call("move", { from: "knowledge/guides/retries.md", to: "knowledge/guides/retry/index.md" });
    check("move (promotion)", mv.ok, mv);
    const out = await call("write", { path: "knowledge/other.md", content: "# x\n" });
    check("write outside scope rejected by host", !out.ok && out.error.code === "scope_violation", out);
    const ro = await call("write", { path: "inputs/x.json", content: "{}" });
    check("write to inputs rejected by host", !ro.ok && ro.error.code === "read_only", ro);
    const snap = await ws.snapshot("knowledge");
    check("snapshot", JSON.stringify([...snap.keys()]) === JSON.stringify(["guides/retry/index.md", "guides/setup.md", "index.md"]) && snap.get("guides/setup.md") === "# Setup guide\n", [...snap.entries()]);
    const l = lease as SandboxLease | null;
    if (l) {
      for (const dir of ["/build/inputs", "/build/published", "/build/parent-draft"]) {
        const r = await l.exec(["bash", "-c", 'echo x > "$1/sessions-probe" 2>/dev/null && echo WROTE || echo DENIED', "bash", dir], { user: "agent", timeoutMs: 20_000 });
        check(`OS denies agent write to ${dir}`, r.stdout.trim() === "DENIED", r.stdout.trim());
      }
      const r = await l.exec(["bash", "-c", 'touch /build/knowledge/os-probe && echo OK'], { user: "agent", timeoutMs: 20_000 });
      check("agent can write knowledge/", r.stdout.trim() === "OK", r.stdout.trim());
    }
  } finally {
    await ws.dispose();
  }
  const report = { kind: "build-modal-workspace-smoke", leaseProvider: "modal", wallMs: Date.now() - started, passed: checks.every((c) => c.ok), checks };
  await mkdir("reports", { recursive: true });
  await writeFile("reports/build-modal-workspace-smoke.json", JSON.stringify(report, null, 2));
  console.error(`passed=${report.passed} (${checks.filter((c) => c.ok).length}/${checks.length})`);
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`modal workspace smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
