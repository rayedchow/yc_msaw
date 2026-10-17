import { describe, expect, it } from "vitest";
import { BudgetConfigError, DEFAULT_BUILD_BUDGET, resolveBudget } from "../src/harness/budget.js";
import { computePatch, findConflicts, lineDiff } from "../src/harness/patch.js";
import { createProfileRegistry, DEFAULT_PROFILES, ProfileError } from "../src/harness/profiles.js";
import { parseScope, scopeAllows, scopesOverlap, scopeWithin } from "../src/harness/scope.js";
import { AgentToolbox, globToRegExp, renderOutcome, resolveProviderTools, type ControlPlane } from "../src/harness/tools.js";
import { LocalBuildWorkspace, parseAgentPath } from "../src/harness/workspace.js";

describe("budget", () => {
  it("keeps AEye root defaults and validates overrides", () => {
    expect(DEFAULT_BUILD_BUDGET).toMatchObject({ maxDepth: 4, maxChildren: 32, maxDescendants: 32, maxTurns: 24, maxToolCalls: 64, maxInputBytes: 128 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024, maxConcurrentAgents: 4 });
    expect(resolveBudget({ maxTurns: 16, maxDescendants: 2 })).toMatchObject({ maxTurns: 16, maxDescendants: 2, maxDepth: 4 });
    expect(() => resolveBudget({ maxDepth: 99 })).toThrow(BudgetConfigError);
    expect(() => resolveBudget({ maxTurns: 1.5 })).toThrow(BudgetConfigError);
    expect(() => resolveBudget({ maxConcurrentAgents: 0 })).toThrow(BudgetConfigError);
  });
});

describe("profiles", () => {
  it("accepts only host-approved models and advertised child profiles", () => {
    const reg = createProfileRegistry({ rootProfileId: "kimi-k3", childProfileIds: ["glm-5p3", "kimi-k3"], defaultChildProfileId: "glm-5p3" });
    expect(reg.root.model).toBe("accounts/fireworks/models/kimi-k3");
    expect(reg.childProfile(undefined).id).toBe("glm-5p3");
    expect(() => reg.childProfile("minimax-m3")).toThrow(ProfileError);
    expect(() => reg.childProfile("accounts/fireworks/models/kimi-k3")).toThrow(ProfileError);
    expect(() => createProfileRegistry({ profiles: [{ ...DEFAULT_PROFILES[0]!, model: "accounts/evil/models/x" }] })).toThrow(/not host-approved/);
  });
});

describe("scopes", () => {
  it("parses pages and subtrees and checks overlap/containment", () => {
    const a = parseScope(["billing", "knowledge/guides/setup.md"]);
    expect(a).toEqual([
      { kind: "subtree", path: "billing" },
      { kind: "page", path: "guides/setup.md" },
    ]);
    expect(scopeAllows(a, "billing/x/y.md")).toBe(true);
    expect(scopeAllows(a, "billing.md")).toBe(false);
    expect(scopeAllows(a, "guides/other.md")).toBe(false);
    expect(scopesOverlap(parseScope(["billing"]), parseScope(["billing/refunds.md"]))).toBe(true);
    expect(scopesOverlap(parseScope(["billing"]), parseScope(["billing-v2"]))).toBe(false);
    expect(scopesOverlap(parseScope([]), parseScope(["a"]))).toBe(false);
    expect(scopeWithin(parseScope(["billing/refunds.md"]), parseScope(["billing"]))).toBe(true);
    expect(scopeWithin(parseScope(["billing"]), parseScope(["billing/refunds.md"]))).toBe(false);
    expect(scopeWithin(parseScope(["x"]), "all")).toBe(true);
    expect(() => parseScope(["a", "a/b.md"])).toThrow(/overlap/);
    expect(() => parseScope(["../etc"])).toThrow();
    expect(() => parseScope(["status"])).toThrow();
  });
});

describe("patch", () => {
  it("computes exact-base patches and detects conflicts", () => {
    const base = new Map([["a/x.md", "1"], ["a/y.md", "2"], ["b.md", "3"]]);
    const cur = new Map([["a/x.md", "1b"], ["a/z.md", "new"], ["b.md", "3"]]);
    const p = computePatch(base, cur, parseScope(["a"]), [{ from: "a/y.md", to: "a/z.md" }]);
    expect(p.changes.map((c) => [c.path, c.op])).toEqual([["a/x.md", "modify"], ["a/y.md", "delete"], ["a/z.md", "add"]]);
    expect(p.moves).toEqual([{ from: "a/y.md", to: "a/z.md" }]);
    expect(findConflicts(base, p)).toEqual([]);
    const moved = new Map(base);
    moved.set("a/z.md", "parent created");
    expect(findConflicts(moved, p).map((c) => c.path)).toEqual(["a/z.md"]);
    expect(() => computePatch(base, new Map([...cur, ["b.md", "changed"]]), parseScope(["a"]), [])).toThrow(/outside/);
    expect(lineDiff("a\nb\n", "a\nc\n").diff).toBe("+2: c\n-2: b");
  });
});

describe("paths and tools", () => {
  it("enforces host path policy before backends", () => {
    expect(parseAgentPath("inputs/sessions/S-1/events.jsonl")).toEqual({ area: "inputs", rel: "sessions/S-1/events.jsonl" });
    expect(parseAgentPath("parent-draft/index.md").area).toBe("parent-draft");
    for (const bad of ["inputs/../x", "knowledge/A.md", "/etc/passwd", "knowledge/status/x.md", "work/a b", "knowledge/plan.md", "inputs/a\\b"]) {
      expect(() => parseAgentPath(bad), bad).toThrow();
    }
    expect(globToRegExp("*.jsonl").test("events.jsonl")).toBe(true);
    expect(globToRegExp("**/session.json").test("sessions/s1/session.json")).toBe(true);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
  });

  it("bounds tool output with explicit markers and slices reads", async () => {
    const r = renderOutcome({ ok: true, value: { content: "x".repeat(50_000) } }, 1000);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/tool output truncated by host/);

    const ws = new LocalBuildWorkspace();
    await ws.init({ inputs: new Map([["big.jsonl", `${"y".repeat(20_000)}\nsecond\n`]]), published: new Map([["index.md", "# I\n"]]), knowledge: new Map([["index.md", "# I\n"]]), parentDraft: null });
    try {
      const control = {} as ControlPlane;
      const tb = new AgentToolbox({ agentId: "root", depth: 0, buildId: "b", isRoot: true, workspace: ws, scope: "all", declaredMoves: [], signal: new AbortController().signal }, control, resolveProviderTools([], false));
      const line = JSON.parse(renderOutcome(await tb.invoke("read", JSON.stringify({ path: "inputs/big.jsonl" }))).text);
      expect(line.truncated).toBe(true);
      expect(line.note).toMatch(/byteOffset/);
      const bytes = JSON.parse(renderOutcome(await tb.invoke("read", JSON.stringify({ path: "inputs/big.jsonl", byteOffset: 19_990, byteLimit: 20 }))).text);
      expect(bytes.content).toBe("yyyyyyyyyy\nsecond\n");
      const second = JSON.parse(renderOutcome(await tb.invoke("read", JSON.stringify({ path: "inputs/big.jsonl", offset: 2 }))).text);
      expect(second.content).toBe("second\n");
      const missing = await tb.invoke("read", JSON.stringify({ path: "inputs/nope.json" }));
      expect(missing).toMatchObject({ ok: false, code: "not_found" });
      const badArgs = await tb.invoke("read", JSON.stringify({ path: "inputs/big.jsonl", extra: 1 }));
      expect(badArgs).toMatchObject({ ok: false, code: "invalid_arguments" });
      const parentDraft = await tb.invoke("ls", JSON.stringify({ path: "parent-draft/" }));
      expect(parentDraft).toMatchObject({ ok: false, code: "not_mounted" });
      const mv1 = await tb.invoke("write", JSON.stringify({ path: "knowledge/a.md", content: "# A\n" }));
      expect(mv1.ok).toBe(true);
      const mv = await tb.invoke("move", JSON.stringify({ from: "knowledge/a.md", to: "knowledge/index.md" }));
      expect(mv).toMatchObject({ ok: false, code: "already_exists" });
      const edit = await tb.invoke("edit", JSON.stringify({ path: "knowledge/index.md", old_text: "nothing", new_text: "x" }));
      expect(edit).toMatchObject({ ok: false, code: "edit_mismatch" });
    } finally {
      await ws.dispose();
    }
  });
});

describe("integration providers", () => {
  it("returns [] with an explicit logged reason when the integrations runtime module is absent", async () => {
    const { createIntegrationToolProviders } = await import("../src/harness/integration-provider.js");
    const logs: string[] = [];
    const regs = await createIntegrationToolProviders({ store: {} as never, ns: "tenant-x", buildId: "build-x", log: (m) => logs.push(m), loadModule: async () => { throw Object.assign(new Error("Cannot find module '../integrations/index.js'"), { code: "ERR_MODULE_NOT_FOUND" }); } });
    expect(regs).toEqual([]);
    expect(logs[0]).toMatch(/integration tools unavailable for build build-x: cannot load src\/integrations\/index/);
    const noExport = await createIntegrationToolProviders({ store: {} as never, ns: "t", buildId: "b", log: (m) => logs.push(m), loadModule: async () => ({}) });
    expect(noExport).toEqual([]);
    expect(logs[1]).toMatch(/does not export createIntegrationRuntime/);
    await expect(createIntegrationToolProviders({ store: {} as never, ns: "t", buildId: "b", required: true, loadModule: async () => ({}) })).rejects.toThrow(/unavailable/);
  });
});
