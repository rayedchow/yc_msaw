/**
 * Runtime tests for the recursive build harness. All agent turns come from the
 * scripted FIXTURE client (tests/build-fixture.ts): deterministic test inputs,
 * not model behavior.
 */
import { describe, expect, it } from "vitest";
import { runMemoryBuild, type BuildReceipt } from "../src/harness/daily.js";
import type { AgentReceipt } from "../src/harness/orchestrator.js";
import { createProfileRegistry } from "../src/harness/profiles.js";
import { localWorkspaceFactory, LocalBuildWorkspace, type BuildWorkspaceFactory } from "../src/harness/workspace.js";
import type { InvestigationBudget } from "../src/harness/budget.js";
import type { ToolProviderRegistration } from "../src/harness/tools.js";
import { IntegrationToolProvider } from "../src/harness/integration-provider.js";
import { defineTool, failed, succeeded } from "../src/integrations/types.js";
import { validateWiki } from "../src/wiki/validate.js";
import type { MemoryRepo } from "../src/store/memory.js";
import { z } from "zod";
import { fixtureInputs, scripted, seedRepo, tempRepo, type ScriptStep, type ScriptedRun } from "./build-fixture.js";

const profiles = createProfileRegistry();

async function build(repo: MemoryRepo, scripts: Record<string, ScriptStep[]>, opts: { budget?: Partial<InvestigationBudget>; providers?: ToolProviderRegistration[]; workspaceFactory?: BuildWorkspaceFactory } = {}) {
  const run = scripted(scripts);
  const receipt = await runMemoryBuild({
    repo,
    inputs: fixtureInputs(),
    sources: ["traces-2026-10-16"],
    profiles,
    clientFactory: run.factory,
    workspaceFactory: opts.workspaceFactory ?? localWorkspaceFactory,
    budget: { waitDefaultMs: 5_000, ...opts.budget },
    toolProviders: opts.providers,
  });
  return { run, receipt };
}

function results(run: ScriptedRun, agentId: string, tool: string) {
  return (run.results[agentId] ?? []).filter((r) => r.name === tool).map((r) => r.result);
}

function find(tree: AgentReceipt, id: string): AgentReceipt {
  if (tree.agentId === id) return tree;
  for (const c of tree.children) {
    try {
      return find(c, id);
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`agent ${id} not in receipt`);
}

function lastTree(r: BuildReceipt): AgentReceipt {
  return r.attempts[r.attempts.length - 1]!.tree;
}

const ROOT_INDEX_WITH_BILLING = "# Procedural memory\n\n- [Billing](billing/index.md): refunds and charges.\n";

describe("recursive build tree", () => {
  it("root -> child -> grandchild with nested scopes, exact-base merges, root-only publish", async () => {
    const repo = await tempRepo();
    const head0 = await repo.ensureHead();
    const { run, receipt } = await build(repo, {
      root: [
        [{ name: "ls", args: { path: "inputs/" } }, { name: "read", args: { path: "inputs/manifest.json" } }],
        [{ name: "spawn_agents", args: { agents: [{ objective: "What billing workflows do the traces show?", paths: ["inputs/sessions/s1/"], knowledgeWriteScope: ["billing"] }] } }],
        [{ name: "write", args: { path: "knowledge/index.md", content: ROOT_INDEX_WITH_BILLING } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "read_agent_result", args: { agentId: "root.1" } }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "accept", reason: "Supported by s1#2 and s1#4" }] } }],
        [{ name: "validate", args: {} }],
        [{ name: "publish", args: { summary: "Add billing refund workflow" } }],
      ],
      "root.1": [
        [{ name: "write", args: { path: "knowledge/billing/index.md", content: "# Billing\n\n- [Refunds](refunds.md): idempotent refunds.\n\n[Up](../index.md)\n" } }],
        [{ name: "spawn_agents", args: { agents: [{ objective: "How must refunds be retried?", knowledgeWriteScope: ["billing/refunds.md"] }] } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1.1", decision: "accept", reason: "cites s1#2" }] } }],
        [{ name: "write", args: { path: "work/handoff.md", content: "Billing branch: refunds page added." } }],
        [{ name: "complete_task", args: { summary: "Billing subtree with refunds procedure", handoffFile: "work/handoff.md" } }],
      ],
      "root.1.1": [
        [{ name: "grep", args: { pattern: "idempotency", path: "inputs/sessions/s1/" } }],
        [{ name: "write", args: { path: "knowledge/billing/refunds.md", content: "# Refunds\n\nAlways pass idempotencyKey; without it the API returned 409 (s1#2). The retry with a key returned refunded (s1#4; outcome client-reported).\n\n[Billing](index.md)\n" } }],
        [{ name: "complete_task", args: { summary: "Refund idempotency procedure" } }],
      ],
    });
    expect(receipt.status).toBe("published");
    expect(receipt.revisionId).not.toBe(head0);
    const files = await repo.files(receipt.revisionId);
    expect([...files.keys()].sort()).toEqual(["billing/index.md", "billing/refunds.md", "index.md"]);
    expect(validateWiki(files).ok).toBe(true);
    const m = await repo.manifest(receipt.revisionId);
    expect(m.parent).toBe(head0);
    expect(m.sources).toEqual(["traces-2026-10-16"]);

    // Grep receipt is host-produced with exact engine and evidence lines.
    const grep = results(run, "root.1.1", "grep")[0];
    expect(grep.ok).toBe(true);
    expect(grep.engine).toBe("literal");
    expect(grep.matches[0]).toMatch(/^inputs\/sessions\/s1\/events\.jsonl:2: /);

    // Parent saw the child's proposal (diffs) before accepting; nothing visible earlier.
    const rr = results(run, "root", "read_agent_result")[0];
    expect(rr.patch.changes.map((c: any) => c.path).sort()).toEqual(["knowledge/billing/index.md", "knowledge/billing/refunds.md"]);
    expect(rr.handoff.content).toContain("refunds page added");

    const tree = lastTree(receipt);
    expect(tree.status).toBe("completed");
    expect(tree.publish?.status).toBe("published");
    const child = find(tree, "root.1");
    const grand = find(tree, "root.1.1");
    expect(child.depth).toBe(1);
    expect(grand.depth).toBe(2);
    expect(child.scope).toEqual(["billing/**"]);
    expect(grand.scope).toEqual(["billing/refunds.md"]);
    expect(grand.decision).toMatchObject({ decision: "accepted", decidedBy: "root.1" });
    expect(child.decision).toMatchObject({ decision: "accepted", decidedBy: "root" });
    expect(child.result?.patch.changes.map((c) => c.path)).toEqual(["billing/index.md", "billing/refunds.md"]);
    expect(child.result?.patch.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(child.result?.handoff?.path).toBe("work/handoff.md");
    expect(grand.result?.patch.changes).toEqual([expect.objectContaining({ path: "billing/refunds.md", op: "add", baseSha256: null })]);
    expect(tree.descendants.agents).toBe(2);
    expect(tree.usage.turns).toBe(8);
    expect(tree.descendants.turns).toBe(child.usage.turns + grand.usage.turns);
    expect(child.workspace?.kind).toBe("local");
    expect(receipt.workspaceBackend).toBe("local");
  });

  it("rejects overlapping sibling scopes and scopes escaping the parent", async () => {
    const repo = await tempRepo();
    const { run, receipt } = await build(repo, {
      root: [
        [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["alpha"] }, { objective: "b", knowledgeWriteScope: ["alpha/beta.md"] }] } }],
        [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["alpha"] }] } }],
        [{ name: "spawn_agents", args: { agents: [{ objective: "x", knowledgeWriteScope: ["alpha/x"] }] } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "reject", reason: "nothing useful" }] } }],
        [{ name: "publish", args: { summary: "no change" } }],
      ],
      "root.1": [
        [{ name: "spawn_agents", args: { agents: [{ objective: "escape", knowledgeWriteScope: ["gamma"] }] } }],
        [{ name: "complete_task", args: { summary: "nothing" } }],
      ],
    });
    const spawns = results(run, "root", "spawn_agents");
    expect(spawns[0].error.code).toBe("scope_overlap");
    expect(spawns[1].ok).toBe(true);
    expect(spawns[2].error.code).toBe("scope_overlap");
    expect(spawns[2].error.message).toContain("active sibling root.1");
    expect(results(run, "root.1", "spawn_agents")[0].error.code).toBe("scope_escape");
    expect(receipt.status).toBe("no_change");
    expect(lastTree(receipt).children).toHaveLength(1);
    expect(find(lastTree(receipt), "root.1").decision?.decision).toBe("rejected");
  });

  it("rejects writes outside the child's scope and to read-only areas", async () => {
    const repo = await tempRepo();
    const { run, receipt } = await build(repo, {
      root: [
        [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["alpha"] }, { objective: "review", knowledgeWriteScope: [] }] } }],
        [{ name: "wait_agents", args: { agentIds: ["root.1"] } }],
        [{ name: "wait_agents", args: { agentIds: ["root.2"] } }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "reject", reason: "test" }, { agentId: "root.2", decision: "reject", reason: "test" }] } }],
        [{ name: "write", args: { path: "inputs/manifest.json", content: "{}" } }, { name: "write", args: { path: "published/index.md", content: "# x" } }],
        [{ name: "publish", args: { summary: "no change" } }],
      ],
      "root.1": [
        [
          { name: "write", args: { path: "knowledge/other.md", content: "# Other\n" } },
          { name: "edit", args: { path: "knowledge/index.md", old_text: "Procedural", new_text: "X" } },
          { name: "write", args: { path: "knowledge/alpha/ok.md", content: "# OK\n" } },
          { name: "write", args: { path: "knowledge/../escape.md", content: "x" } },
        ],
        [{ name: "complete_task", args: { summary: "done" } }],
      ],
      "root.2": [[{ name: "write", args: { path: "knowledge/alpha/x.md", content: "# X\n" } }], [{ name: "complete_task", args: { summary: "review only" } }]],
    });
    const w = results(run, "root.1", "write");
    expect(w[0].error.code).toBe("scope_violation");
    expect(w[1].ok).toBe(true);
    expect(w[2].error.code).toBe("invalid_path");
    expect(results(run, "root.1", "edit")[0].error.code).toBe("scope_violation");
    expect(results(run, "root.2", "write")[0].error.code).toBe("scope_violation");
    const rootWrites = results(run, "root", "write");
    expect(rootWrites.map((r) => r.error.code)).toEqual(["read_only", "read_only"]);
    const t = lastTree(receipt);
    expect(find(t, "root.1").result?.patch.changes.map((c) => c.path)).toEqual(["alpha/ok.md"]);
    expect(find(t, "root.2").result?.patch.changes).toEqual([]);
    expect(receipt.status).toBe("no_change");
  });

  it("refuses to accept a child patch whose base changed in the parent (exact-base conflict)", async () => {
    const repo = await tempRepo();
    await seedRepo(repo, {
      "index.md": "# Memory\n\n- [Guides](guides/index.md): setup guides.\n",
      "guides/index.md": "# Guides\n\n- [Setup](setup.md): initial setup.\n\n[Up](../index.md)\n",
      "guides/setup.md": "# Setup\n\nOriginal.\n",
    });
    const { run, receipt } = await build(repo, {
      root: [
        [{ name: "spawn_agents", args: { agents: [{ objective: "update setup", knowledgeWriteScope: ["guides"] }] } }],
        [{ name: "edit", args: { path: "knowledge/guides/setup.md", old_text: "Original.", new_text: "Root edit." } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "accept", reason: "try" }] } }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "reject", reason: "conflict with my edit" }] } }],
        [{ name: "publish", args: { summary: "root edit" } }],
      ],
      "root.1": [
        [{ name: "edit", args: { path: "knowledge/guides/setup.md", old_text: "Original.", new_text: "Child edit." } }],
        [{ name: "complete_task", args: { summary: "edited setup" } }],
      ],
    });
    const d = results(run, "root", "decide_agent_results");
    expect(d[0].ok).toBe(false);
    expect(d[0].error.code).toBe("decision_failed");
    const failedAccept = d[0].error.details.results[0];
    expect(failedAccept.code).toBe("patch_conflict");
    expect(failedAccept.conflicts[0].path).toBe("knowledge/guides/setup.md");
    expect(d[1].ok).toBe(true);
    expect(receipt.status).toBe("published");
    const files = await repo.files(receipt.revisionId);
    expect(files.get("guides/setup.md")).toBe("# Setup\n\nRoot edit.\n");
    const child = find(lastTree(receipt), "root.1");
    expect(child.decision?.decision).toBe("rejected");
    expect(child.failedAccepts?.[0]?.conflicts[0]?.path).toBe("guides/setup.md");
  });

  it("publish is root-only and complete_task is child-only; publish requires decided handoffs", async () => {
    const repo = await tempRepo();
    const { run, receipt } = await build(repo, {
      root: [
        [{ name: "complete_task", args: { summary: "nope" } }],
        [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["a"] }] } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "publish", args: { summary: "too early" } }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "reject", reason: "test" }] } }],
        [{ name: "publish", args: { summary: "ok" } }],
      ],
      "root.1": [[{ name: "publish", args: { summary: "child publish" } }], [{ name: "complete_task", args: { summary: "done" } }]],
    });
    expect(results(run, "root", "complete_task")[0].error.code).toBe("not_available");
    expect(results(run, "root.1", "publish")[0].error.code).toBe("not_available");
    expect(run.toolsSeen["root.1"]).not.toContain("publish");
    expect(run.toolsSeen["root"]).not.toContain("complete_task");
    expect(results(run, "root", "publish")[0].error.code).toBe("undecided_handoffs");
    expect(receipt.status).toBe("no_change");
  });

  it("promotes foo.md to foo/index.md, fixes links, merges a child page, and validates", async () => {
    const repo = await tempRepo();
    await seedRepo(repo, {
      "index.md": "# Memory\n\n- [Deploy](deploy.md): how to deploy.\n",
      "deploy.md": "# Deploy\n\nRun the deploy tool. See [home](index.md).\n",
    });
    const { run, receipt } = await build(repo, {
      root: [
        [{ name: "move", args: { from: "knowledge/deploy.md", to: "knowledge/deploy/index.md" } }],
        [{ name: "validate", args: {} }],
        [
          { name: "edit", args: { path: "knowledge/index.md", old_text: "(deploy.md)", new_text: "(deploy/index.md)" } },
          { name: "edit", args: { path: "knowledge/deploy/index.md", old_text: "[home](index.md)", new_text: "[home](../index.md)" } },
        ],
        [{ name: "spawn_agents", args: { agents: [{ objective: "Document rollback", knowledgeWriteScope: ["deploy"] }] } }],
        [{ name: "wait_agents", args: {} }],
        [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "accept", reason: "good" }] } }],
        [{ name: "validate", args: {} }],
        [{ name: "publish", args: { summary: "Promote deploy into a directory with rollback" } }],
      ],
      "root.1": [
        [
          { name: "write", args: { path: "knowledge/deploy/rollback.md", content: "# Rollback\n\nRoll back with the previous version id.\n\n[Deploy](index.md)\n" } },
          { name: "edit", args: { path: "knowledge/deploy/index.md", old_text: "Run the deploy tool.", new_text: "Run the deploy tool.\n\n- [Rollback](rollback.md): when a deploy fails." } },
        ],
        [{ name: "validate", args: {} }],
        [{ name: "complete_task", args: { summary: "rollback page" } }],
      ],
    });
    const v = results(run, "root", "validate");
    expect(v[0].valid).toBe(false);
    expect(v[0].errors.join("\n")).toMatch(/broken_link/);
    expect(v[1].valid).toBe(true);
    expect(results(run, "root.1", "validate")[0].valid).toBe(true);
    expect(receipt.status).toBe("published");
    const files = await repo.files(receipt.revisionId);
    expect([...files.keys()].sort()).toEqual(["deploy/index.md", "deploy/rollback.md", "index.md"]);
    expect(validateWiki(files).ok).toBe(true);
  });

  it("exposes registered tool providers to root (and children only when allowed)", async () => {
    const repo = await tempRepo();
    const calls: unknown[] = [];
    const docs = defineTool({
      name: "docs_search",
      description: "Search official docs (fixture).",
      scope: "builder-research",
      authority: "fixture",
      mutates: false,
      input: z.object({ q: z.string() }),
      run: async (input) => {
        calls.push(input);
        return input.q === "fail" ? failed("upstream_down", "fixture failure") : succeeded({ hits: [`doc for ${input.q}`] });
      },
    });
    const deploy = defineTool({ name: "deploy_child", description: "deploy", scope: "host-deploy", authority: "host", mutates: true, input: z.object({}), run: async () => succeeded({}) });
    const provider = new IntegrationToolProvider({ tools: [docs, deploy] });
    const { run, receipt } = await build(
      repo,
      {
        root: [
          [{ name: "docs_search", args: { q: "refunds" } }, { name: "docs_search", args: { q: "fail" } }, { name: "docs_search", args: { bad: 1 } }, { name: "deploy_child", args: {} }],
          [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: [] }] } }],
          [{ name: "wait_agents", args: {} }],
          [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "reject", reason: "test" }] } }],
          [{ name: "publish", args: { summary: "none" } }],
        ],
        "root.1": [[{ name: "docs_search", args: { q: "x" } }], [{ name: "complete_task", args: { summary: "done" } }]],
      },
      { providers: [{ provider, availableToChildren: false }] },
    );
    const r = results(run, "root", "docs_search");
    expect(r[0]).toMatchObject({ ok: true, status: "succeeded", data: { hits: ["doc for refunds"] } });
    expect(r[1]).toMatchObject({ ok: false, error: { code: "upstream_down" } });
    expect(r[2]).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(results(run, "root", "deploy_child")[0].error.code).toBe("unknown_tool");
    expect(run.toolsSeen.root).toContain("docs_search");
    expect(run.systemPrompts.root).toContain("mcps/<slug>/");
    expect(run.toolsSeen["root.1"]).not.toContain("docs_search");
    expect(results(run, "root.1", "docs_search")[0].error.code).toBe("unknown_tool");
    expect(calls).toHaveLength(2);
    expect(receipt.status).toBe("no_change");
  });
});

describe("integration runtime wiring", () => {
  it("registers runtime tools for the root only, adds runtime instructions to the root prompt, and closes the runtime once", async () => {
    const { createIntegrationToolProviders } = await import("../src/harness/integration-provider.js");
    const repo = await tempRepo();
    let closed = 0;
    let deps: Record<string, unknown> = {};
    const tool = (name: string, scope: "builder-research" | "builder-workspace" | "host-deploy") =>
      defineTool({ name, description: `${name} (fixture)`, scope, authority: "fixture", mutates: scope !== "builder-research", input: z.object({}), run: async () => succeeded({ name }) });
    // FIXTURE module standing in for src/integrations/index.ts (contract: .context/integrations-progress.md).
    const fakeModule = {
      createIntegrationRuntime: async (d: Record<string, unknown>) => {
        deps = d;
        return { tools: [tool("research_fetch_url", "builder-research"), tool("repo_write_file", "builder-workspace"), tool("integration_publish", "host-deploy")], instructions: "REPO RULES: branch codex/build-<buildId>; never force-push.", close: async () => void closed++ };
      },
    };
    const providers = await createIntegrationToolProviders({ store: repo.store, ns: repo.ns, buildId: "build-int", loadModule: async () => fakeModule });
    expect(deps).toMatchObject({ ns: repo.ns, buildId: "build-int" });
    const { run, receipt } = await build(
      repo,
      {
        root: [
          [{ name: "repo_write_file", args: {} }, { name: "integration_publish", args: {} }],
          [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: [] }] } }],
          [{ name: "wait_agents", args: {} }],
          [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "reject", reason: "x" }] } }],
          [{ name: "publish", args: { summary: "none" } }],
        ],
        "root.1": [[{ name: "complete_task", args: { summary: "done" } }]],
      },
      { providers },
    );
    expect(results(run, "root", "repo_write_file")[0]).toMatchObject({ ok: true, status: "succeeded" });
    expect(results(run, "root", "integration_publish")[0].error.code).toBe("unknown_tool");
    expect(run.systemPrompts.root).toContain("REPO RULES");
    expect(run.systemPrompts.root).toContain("Integration tools are ROOT-ONLY: you alone hold research_fetch_url, repo_write_file");
    expect(run.systemPrompts["root.1"]).not.toContain("REPO RULES");
    expect(run.systemPrompts["root.1"]).not.toContain("ROOT-ONLY");
    expect(run.toolsSeen["root.1"]).not.toContain("repo_write_file");
    expect(closed).toBe(1);
    expect(receipt.providerClose).toEqual([{ id: "integrations", ok: true, detail: { persisted: [] } }]);
  });
});

describe("model output robustness", () => {
  it("invalid tool-call JSON is an explicit tool error and is replayed to the provider as a valid JSON object string", async () => {
    const repo = await tempRepo();
    const { run, receipt } = await build(repo, {
      root: [
        [{ name: "write", rawArguments: '{"path": "knowledge/a.md", "content": "# A\n unterminated' }, { name: "ls", rawArguments: "" }],
        [{ name: "publish", args: { summary: "none" } }],
      ],
    });
    expect(results(run, "root", "write")[0].error.code).toBe("invalid_arguments");
    expect(results(run, "root", "ls")[0].ok).toBe(true);
    const replayed = run.lastMessages.root!.find((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "write"))!;
    for (const call of replayed.tool_calls!) {
      const parsed = JSON.parse(call.function.arguments);
      expect(typeof parsed).toBe("object");
    }
    expect(JSON.parse(replayed.tool_calls![0]!.function.arguments)._invalid_arguments).toContain("unterminated");
    expect(receipt.status).toBe("no_change");
  });
});

describe("budgets", () => {
  it("depth limit is an explicit failure", async () => {
    const repo = await tempRepo();
    const { run, receipt } = await build(
      repo,
      {
        root: [
          [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["a"] }] } }],
          [{ name: "wait_agents", args: {} }],
          [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "reject", reason: "x" }] } }],
          [{ name: "publish", args: { summary: "none" } }],
        ],
        "root.1": [[{ name: "spawn_agents", args: { agents: [{ objective: "deeper", knowledgeWriteScope: ["a/b"] }] } }], [{ name: "complete_task", args: { summary: "done" } }]],
      },
      { budget: { maxDepth: 1 } },
    );
    const e = results(run, "root.1", "spawn_agents")[0];
    expect(e.error.code).toBe("budget_exhausted");
    expect(e.error.message).toMatch(/depth limit 1/);
    expect(receipt.status).toBe("no_change");
  });

  it("descendant limit is an explicit failure (batch is all-or-nothing)", async () => {
    const repo = await tempRepo();
    const { run, receipt } = await build(
      repo,
      { root: [[{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["a"] }, { objective: "b", knowledgeWriteScope: ["b"] }] } }], [{ name: "publish", args: { summary: "none" } }]] },
      { budget: { maxDescendants: 1 } },
    );
    const e = results(run, "root", "spawn_agents")[0];
    expect(e.error.code).toBe("budget_exhausted");
    expect(e.error.message).toMatch(/descendants limit 1/);
    expect(lastTree(receipt).children).toHaveLength(0);
    expect(receipt.status).toBe("no_change");
  });

  it("turn exhaustion fails the build and leaves the published revision intact", async () => {
    const repo = await tempRepo();
    const head0 = await repo.ensureHead();
    const loop: ScriptStep = [{ name: "ls", args: { path: "knowledge/" } }];
    const { receipt } = await build(repo, { root: [[{ name: "write", args: { path: "knowledge/index.md", content: "# Changed\n" } }], loop, loop, loop] }, { budget: { maxTurns: 2, maxSessions: 1 } });
    expect(receipt.status).toBe("failed");
    expect(receipt.failure?.code).toBe("budget_exhausted");
    expect(lastTree(receipt).failure).toMatchObject({ dimension: "turns", limit: 2 });
    expect(lastTree(receipt).status).toBe("budget_exhausted");
    expect(receipt.revisionId).toBe(head0);
    expect((await repo.head())?.value.revisionId).toBe(head0);
  });

  it("a child that exhausts its tool-call budget fails explicitly and cannot be accepted", async () => {
    const repo = await tempRepo();
    const ls: ScriptStep = [{ name: "ls", args: {} }, { name: "ls", args: {} }];
    const { run, receipt } = await build(
      repo,
      {
        root: [
          [{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["a"] }] } }],
          [{ name: "wait_agents", args: {} }],
          [{ name: "decide_agent_results", args: { decisions: [{ agentId: "root.1", decision: "accept", reason: "x" }] } }],
          [{ name: "publish", args: { summary: "none" } }],
        ],
        "root.1": [ls, ls, ls],
      },
      { budget: { maxToolCalls: 4, maxSessions: 1 } },
    );
    const child = find(lastTree(receipt), "root.1");
    expect(child.status).toBe("budget_exhausted");
    expect(child.failure?.dimension).toBe("tool_calls");
    expect(results(run, "root", "decide_agent_results")[0].error.code).toBe("not_completed");
    expect(receipt.status).toBe("no_change");
  });

  it("session limits reset the conversation to a host state summary and the agent continues (AEye session boundary)", async () => {
    const repo = await tempRepo();
    const { run, receipt } = await build(
      repo,
      {
        root: [
          [{ name: "write", args: { path: "work/notes.md", content: "plan: add billing page" } }, { name: "write", args: { path: "knowledge/billing.md", content: "# Billing\n\nRefunds need an idempotency key (s1#2).\n" } }],
          [{ name: "ls", args: {} }],
          // session 2 starts here with the host summary
          [{ name: "read", args: { path: "work/notes.md" } }],
          [{ name: "edit", args: { path: "knowledge/index.md", old_text: "No workflows have been learned yet.", new_text: "- [Billing](billing.md): refunds." } }, { name: "publish", args: { summary: "billing" } }],
        ],
      },
      { budget: { maxTurns: 2, maxSessions: 3 } },
    );
    expect(receipt.status).toBe("published");
    const t = lastTree(receipt);
    expect(t.usage.sessions).toBe(2);
    expect(t.usage.turns).toBe(4);
    expect(t.toolCalls.map((c) => c.session)).toEqual([1, 1, 1, 2, 2, 2]);
    const resume = run.lastMessages.root!.find((m) => m.role === "user" && (m.content ?? "").startsWith("[host] Session 2 started"));
    expect(resume?.content).toContain("knowledge/billing.md");
    expect(resume?.content).toContain("work/notes.md");
  });

  it("two consecutive sessions without progress stop the agent explicitly", async () => {
    const repo = await tempRepo();
    const ls: ScriptStep = [{ name: "ls", args: {} }];
    const { receipt } = await build(repo, { root: [ls, ls, ls, ls, ls, ls, ls, ls] }, { budget: { maxTurns: 2, maxSessions: 10 } });
    expect(receipt.status).toBe("failed");
    expect(lastTree(receipt).failure?.code).toBe("no_progress");
    expect(lastTree(receipt).usage.sessions).toBe(3);
  });

  it("the root task prompt carries a host-computed cohort overview and delegation guidance", async () => {
    const repo = await tempRepo();
    const { run } = await build(repo, { root: [[{ name: "publish", args: { summary: "none" } }]] });
    const task = run.firstMessages.root![1]!.content ?? "";
    expect(task).toMatch(/s1: 4 event\(s\), \d+ KiB/);
    expect(task).toContain('"Refund a charge"');
    expect(run.systemPrompts.root).toContain("aggressively parallelize");
  });

  it("unknown child model profiles are rejected", async () => {
    const repo = await tempRepo();
    const { run } = await build(repo, {
      root: [[{ name: "spawn_agents", args: { agents: [{ objective: "a", modelProfileId: "accounts/fireworks/models/some-other" }] } }], [{ name: "publish", args: { summary: "none" } }]],
    });
    expect(results(run, "root", "spawn_agents")[0].error.code).toBe("invalid_model_profile");
  });
});

describe("publish CAS", () => {
  it("rebuilds once on the new head when another writer moved it", async () => {
    const repo = await tempRepo();
    const head0 = await repo.ensureHead();
    let intruder = "";
    const { receipt } = await build(repo, {
      "root#1": [
        [{ name: "write", args: { path: "knowledge/index.md", content: "# Memory A\n" } }],
        async () => {
          // Fixture: a concurrent writer publishes between pin and publish.
          const r = await repo.publish(head0, new Map([["index.md", "# Intruder\n"]]), { buildId: "other", summary: "other writer", sources: [] });
          intruder = r.revisionId;
          return [{ name: "publish", args: { summary: "attempt 1" } }];
        },
      ],
      "root#2": [
        [{ name: "read", args: { path: "published/index.md" } }],
        [{ name: "write", args: { path: "knowledge/index.md", content: "# Memory B\n" } }],
        [{ name: "publish", args: { summary: "attempt 2" } }],
      ],
    });
    expect(receipt.attempts.map((a) => a.status)).toEqual(["publish_conflict", "published"]);
    expect(receipt.attempts[1]!.baseRevision).toBe(intruder);
    expect(receipt.status).toBe("published");
    const m = await repo.manifest(receipt.revisionId);
    expect(m.parent).toBe(intruder);
    expect((await repo.files(receipt.revisionId)).get("index.md")).toBe("# Memory B\n");
  });
});

describe("workspace cleanup", () => {
  it("disposes every agent workspace, including after failures", async () => {
    const repo = await tempRepo();
    const made: LocalBuildWorkspace[] = [];
    const disposed = new Set<string>();
    const factory: BuildWorkspaceFactory = () => {
      const ws = new LocalBuildWorkspace();
      const orig = ws.dispose.bind(ws);
      ws.dispose = async () => {
        disposed.add(ws.id);
        await orig();
      };
      made.push(ws);
      return ws;
    };
    await build(
      repo,
      {
        root: [[{ name: "spawn_agents", args: { agents: [{ objective: "a", knowledgeWriteScope: ["a"] }, { objective: "b", knowledgeWriteScope: ["b"] }] } }], { text: "done?" }, { text: "done!" }, { text: "really" }],
        "root.1": [{ text: "thinking" }],
      },
      { workspaceFactory: factory },
    );
    expect(made).toHaveLength(3);
    expect(disposed.size).toBe(3);
  });
});
