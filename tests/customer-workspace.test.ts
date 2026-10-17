import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUSTOMER_TOOL_DEFINITIONS,
  CustomerToolError,
  CustomerWorkspace,
  CustomerWorkspaceManager,
  CUSTOMER_WORKSPACE_ORIENTATION,
  applyEdits,
  dispatchCustomerTool,
  globToRegExp,
  normalizeScratchFilePath,
  normalizeVirtualPath,
  runCustomerTool,
} from "../src/customer/index.js";
import { LOCAL_EXEC_ERROR, LocalLease } from "../src/sandbox/local.js";

const FILES = new Map<string, string>([
  ["index.md", "# Procedural memory\n\nSee [deploy](deploy/index.md).\n"],
  ["deploy/index.md", "# Deploy\n\nRun the release workflow.\nRollback: use `make rollback`.\n"],
  ["deploy/staging.md", "# Staging\nStaging deploy uses make deploy-staging\nTODO nothing\n"],
  ["billing/refunds.md", "# Refunds\nIssue refunds with the admin tool.\n"],
]);

const leases: LocalLease[] = [];
const workspaces: CustomerWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.close()));
  await Promise.all(leases.splice(0).map((l) => l.terminate()));
});

function makeWorkspace(opts: { withLease?: boolean } = {}): { ws: CustomerWorkspace; leaseCount: () => number } {
  let created = 0;
  const ws = new CustomerWorkspace({
    ns: "acme",
    workspaceId: "ws-1",
    revisionId: "rev-000000000000000000000000",
    files: FILES,
    leaseFactory: async () => {
      created++;
      if (opts.withLease === false) throw new Error("lease factory must not be called");
      const lease = await LocalLease.create();
      leases.push(lease);
      return lease;
    },
  });
  workspaces.push(ws);
  return { ws, leaseCount: () => created };
}

async function expectToolError(p: Promise<unknown>, code: string): Promise<CustomerToolError> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerToolError);
    expect((error as CustomerToolError).code).toBe(code);
    return error as CustomerToolError;
  }
  throw new Error(`expected CustomerToolError ${code}`);
}

describe("path policy", () => {
  it("maps virtual roots and sandbox aliases", () => {
    expect(normalizeVirtualPath("$KNOWLEDGE")).toEqual({ root: "knowledge", rel: "" });
    expect(normalizeVirtualPath("$KNOWLEDGE/deploy/index.md")).toEqual({ root: "knowledge", rel: "deploy/index.md" });
    expect(normalizeVirtualPath("${KNOWLEDGE}/a//b/./c.md")).toEqual({ root: "knowledge", rel: "a/b/c.md" });
    expect(normalizeVirtualPath("/memory/knowledge/index.md")).toEqual({ root: "knowledge", rel: "index.md" });
    expect(normalizeVirtualPath("$WORK/scratch/notes.txt")).toEqual({ root: "scratch", rel: "notes.txt" });
    expect(normalizeVirtualPath("/work/scratch")).toEqual({ root: "scratch", rel: "" });
    expect(normalizeVirtualPath("notes/a.txt")).toEqual({ root: "scratch", rel: "notes/a.txt" });
  });

  it.each([
    ["../etc/passwd"],
    ["$KNOWLEDGE/../secrets"],
    ["$WORK/scratch/a/../../x"],
    ["/etc/passwd"],
    ["/memory"],
    ["/work"],
    ["$WORK"],
    ["$INPUTS/trace.json"],
    ["$TRACES"],
    ["~/x"],
    ["a\u0000b"],
    ["a\nb"],
    ["'$KNOWLEDGE/index.md'"],
    ["a\\b"],
    [""],
    ["x".repeat(2001)],
  ])("rejects %j", (p) => {
    expect(() => normalizeVirtualPath(p)).toThrow(CustomerToolError);
  });

  it("rejects writes outside scratch", () => {
    expect(() => normalizeScratchFilePath("$KNOWLEDGE/index.md")).toThrow(/read-only/);
    expect(() => normalizeScratchFilePath("$WORK/scratch")).toThrow(/file below/);
    expect(normalizeScratchFilePath("out/x.md")).toEqual({ root: "scratch", rel: "out/x.md" });
  });

  it("converts globs", () => {
    expect(globToRegExp("*.md").test("a.md")).toBe(true);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("c.md")).toBe(true);
    expect(globToRegExp("{a,b}.txt").test("b.txt")).toBe(true);
    expect(globToRegExp("[!x]y").test("zy")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("host-side knowledge tools (no sandbox)", () => {
  it("read slices by line and byte", async () => {
    const { ws, leaseCount } = makeWorkspace({ withLease: false });
    const all = await ws.read({ path: "$KNOWLEDGE/deploy/index.md" });
    expect(all).toMatchObject({ tool: "read", ok: true, path: "$KNOWLEDGE/deploy/index.md", totalLines: 4, startLine: 1, endLine: 4, truncated: false });
    expect(all.content).toBe("# Deploy\n\nRun the release workflow.\nRollback: use `make rollback`.");
    const slice = await ws.read({ path: "$KNOWLEDGE/deploy/index.md", offset: 2, limit: 2 });
    expect(slice).toMatchObject({ content: "\nRun the release workflow.", startLine: 2, endLine: 3, nextOffset: 4, truncated: true });
    const bytes = await ws.read({ path: "/memory/knowledge/index.md", byteOffset: 2, byteLimit: 10 });
    expect(bytes).toMatchObject({ mode: "bytes", content: "Procedural", byteOffset: 2, nextByteOffset: 12, truncated: true });
    expect(typeof all.durationMs).toBe("number");
    expect(leaseCount()).toBe(0);
  });

  it("read errors are typed", async () => {
    const { ws } = makeWorkspace({ withLease: false });
    const nf = await expectToolError(ws.read({ path: "$KNOWLEDGE/deploy/prod.md" }), "not_found");
    expect(nf.message).toMatch(/staging\.md/);
    await expectToolError(ws.read({ path: "$KNOWLEDGE/deploy" }), "not_a_file");
    await expectToolError(ws.read({ path: "$KNOWLEDGE/index.md", offset: 99 }), "invalid_input");
    await expect(ws.read({ path: "$KNOWLEDGE/index.md", offset: 1, byteLimit: 4 })).rejects.toThrow(/cannot be combined/);
  });

  it("ls lists one level with directories marked", async () => {
    const { ws } = makeWorkspace({ withLease: false });
    const root = await ws.ls();
    expect(root.path).toBe("$KNOWLEDGE");
    expect(root.entries.map((e) => e.name)).toEqual(["billing/", "deploy/", "index.md"]);
    const limited = await ws.ls({ path: "$KNOWLEDGE", limit: 1 });
    expect(limited).toMatchObject({ total: 3, truncated: true });
    const file = await ws.ls({ path: "$KNOWLEDGE/index.md" });
    expect(file.entries).toEqual([{ name: "index.md", type: "file", size: Buffer.byteLength(FILES.get("index.md")!) }]);
  });

  it("find matches basenames or relative paths", async () => {
    const { ws } = makeWorkspace({ withLease: false });
    expect((await ws.find({ pattern: "index.md" })).matches).toEqual(["$KNOWLEDGE/deploy/index.md", "$KNOWLEDGE/index.md"]);
    expect((await ws.find({ pattern: "deploy/*.md" })).matches).toEqual(["$KNOWLEDGE/deploy/index.md", "$KNOWLEDGE/deploy/staging.md"]);
    expect((await ws.find({ path: "$KNOWLEDGE/deploy", pattern: "*" })).matches).toEqual(["$KNOWLEDGE/deploy/index.md", "$KNOWLEDGE/deploy/staging.md"]);
    expect((await ws.find({})).matches).toContain("$KNOWLEDGE/billing/");
    expect((await ws.find({ pattern: "*", limit: 2 })).truncated).toBe(true);
  });

  it("grep supports regex, literal, ignoreCase, glob, limit", async () => {
    const { ws } = makeWorkspace({ withLease: false });
    const r = await ws.grep({ pattern: "make [a-z-]+" });
    expect(r.matches).toEqual([
      { path: "$KNOWLEDGE/deploy/index.md", line: 4, text: "Rollback: use `make rollback`." },
      { path: "$KNOWLEDGE/deploy/staging.md", line: 2, text: "Staging deploy uses make deploy-staging" },
    ]);
    expect((await ws.grep({ pattern: "(", literal: true })).matches).toHaveLength(1);
    expect((await ws.grep({ pattern: "REFUNDS", ignoreCase: true })).matches.map((m) => m.line)).toEqual([1, 2]);
    expect((await ws.grep({ pattern: "#", glob: "staging.md" })).matches).toHaveLength(1);
    expect((await ws.grep({ pattern: "#", limit: 2 })).truncated).toBe(true);
    expect((await ws.grep({ pattern: "Deploy", path: "$KNOWLEDGE/deploy/index.md" })).matches).toHaveLength(1);
    await expectToolError(ws.grep({ pattern: "(" }), "invalid_input");
  });

  it("grep kills catastrophic regex backtracking", async () => {
    const files = new Map([["evil.md", `${"a".repeat(40)}!\n`]]);
    const ws = new CustomerWorkspace({ ns: "n", workspaceId: "w", revisionId: "r", files, leaseFactory: async () => { throw new Error("no"); } });
    workspaces.push(ws);
    const started = Date.now();
    await expectToolError(ws.grep({ pattern: "^(a+)+$" }), "pattern_timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("knowledge is not writable through tools", async () => {
    const { ws, leaseCount } = makeWorkspace();
    await expectToolError(ws.write({ path: "$KNOWLEDGE/index.md", content: "x" }), "read_only");
    await expectToolError(ws.edit({ path: "/memory/knowledge/index.md", edits: [{ oldText: "#", newText: "x" }] }), "read_only");
    await expectToolError(ws.write({ path: "/etc/passwd", content: "x" }), "invalid_path");
    expect(leaseCount()).toBe(0);
  });
});

describe("scratch via LocalLease", () => {
  it("write, read, ls, find, grep, edit in scratch", async () => {
    const { ws, leaseCount } = makeWorkspace();
    const w = await ws.write({ path: "$WORK/scratch/notes/plan.txt", content: "alpha\nbeta\ngamma\n" });
    expect(w).toMatchObject({ tool: "write", path: "$WORK/scratch/notes/plan.txt", bytes: 17, created: true });
    expect((await ws.write({ path: "notes/plan.txt", content: "alpha\nbeta\ngamma\n" })).created).toBe(false);
    expect((await ws.read({ path: "notes/plan.txt", offset: 2, limit: 1 })).content).toBe("beta");
    expect((await ws.read({ path: "$WORK/scratch/notes/plan.txt", byteOffset: 6, byteLimit: 4 })).content).toBe("beta");
    expect((await ws.ls({ path: "$WORK/scratch" })).entries.map((e) => e.name)).toEqual(["notes/"]);
    expect((await ws.find({ path: "$WORK/scratch", pattern: "*.txt" })).matches).toEqual(["$WORK/scratch/notes/plan.txt"]);
    expect((await ws.grep({ path: "$WORK/scratch", pattern: "^g" })).matches).toEqual([{ path: "$WORK/scratch/notes/plan.txt", line: 3, text: "gamma" }]);

    const e = await ws.edit({ path: "notes/plan.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "gamma\n", newText: "" }] });
    expect(e).toMatchObject({ replacements: 2, bytesBefore: 17, bytesAfter: 11 });
    expect((await ws.read({ path: "notes/plan.txt" })).content).toBe("ALPHA\nbeta");
    await expectToolError(ws.edit({ path: "notes/plan.txt", edits: [{ oldText: "zzz", newText: "" }] }), "edit_mismatch");
    await expectToolError(ws.edit({ path: "notes/missing.txt", edits: [{ oldText: "a", newText: "" }] }), "not_found");
    await expectToolError(ws.read({ path: "notes/missing.txt" }), "not_found");
    await expectToolError(ws.read({ path: "$WORK/scratch/notes" }), "not_a_file");
    expect(leaseCount()).toBe(1);
  });

  it("materializes protected knowledge and a writable scratch dir in the lease", async () => {
    const { ws } = makeWorkspace();
    await ws.write({ path: "a.txt", content: "x" });
    const lease = leases[0]!;
    const knowledgeFile = lease.hostPath("/memory/knowledge/deploy/index.md");
    expect(await fs.readFile(knowledgeFile, "utf8")).toBe(FILES.get("deploy/index.md"));
    await expect(fs.writeFile(knowledgeFile, "tampered")).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.writeFile(path.join(path.dirname(knowledgeFile), "new.md"), "x")).rejects.toMatchObject({ code: "EACCES" });
    expect((await fs.stat(lease.hostPath("/work/scratch"))).mode & 0o777).toBe(0o700);
    // Knowledge reads remain host-side and pinned even with a lease.
    expect((await ws.read({ path: "$KNOWLEDGE/deploy/index.md" })).content).toContain("release workflow");
  });

  it("shell is rejected offline with a clear error", async () => {
    const { ws } = makeWorkspace();
    await expect(ws.shell({ script: "echo hi" })).rejects.toThrow(LOCAL_EXEC_ERROR);
    await expectToolError(ws.poll_command({ commandId: "00000000-0000-4000-8000-000000000000" }), "unknown_command");
    const lease = await LocalLease.create();
    leases.push(lease);
    await expect(lease.exec(["true"], { user: "agent", timeoutMs: 1000 })).rejects.toThrow(LOCAL_EXEC_ERROR);
    await expect(lease.start(["true"], { user: "root", timeoutMs: 1000 })).rejects.toThrow(LOCAL_EXEC_ERROR);
  });

  it("applyEdits rejects ambiguous and overlapping edits", () => {
    expect(() => applyEdits("aa", [{ oldText: "a", newText: "b" }])).toThrow(/more than once/);
    expect(() => applyEdits("abcd", [{ oldText: "abc", newText: "" }, { oldText: "cd", newText: "" }])).toThrow(/overlap/);
    expect(applyEdits("abcd", [{ oldText: "cd", newText: "X" }, { oldText: "ab", newText: "Y" }])).toBe("YX");
  });
});

describe("tool definitions and manager", () => {
  it("exports the customer tool set without builder/trace tools", () => {
    const names = CUSTOMER_TOOL_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual(["read", "grep", "find", "ls", "shell", "poll_command", "write_command", "cancel_command", "write", "edit"]);
    for (const d of CUSTOMER_TOOL_DEFINITIONS) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(typeof d.inputSchema.safeParse).toBe("function");
    }
    expect(CUSTOMER_TOOL_DEFINITIONS.filter((d) => d.mutates).map((d) => d.name)).toEqual(["shell", "write_command", "cancel_command", "write", "edit"]);
  });

  it("runCustomerTool validates input via schemas", async () => {
    const { ws } = makeWorkspace({ withLease: false });
    await expect(runCustomerTool(ws, "read", { path: "$KNOWLEDGE/index.md", bogus: 1 })).rejects.toThrow();
    const r = (await runCustomerTool(ws, "ls", {})) as { entries: unknown[] };
    expect(r.entries).toHaveLength(3);
  });

  it("caps workspaces per namespace, isolates scratch, and evicts idle ones", async () => {
    const created: LocalLease[] = [];
    const mgr = new CustomerWorkspaceManager({
      maxWorkspacesPerNs: 2,
      idleMs: 1_000,
      sweepIntervalMs: 0,
      leaseFactory: async () => {
        const l = await LocalLease.create();
        created.push(l);
        leases.push(l);
        return l;
      },
    });
    try {
      const a = mgr.open("acme", "rev-a", FILES);
      const b = mgr.open("acme", "rev-a", FILES);
      const other = mgr.open("globex", "rev-a", FILES);
      await mgr.get("acme", a).write({ path: "secret.txt", content: "only a" });
      await expectToolError(mgr.get("acme", b).read({ path: "secret.txt" }), "not_found");
      expect(() => mgr.get("globex", a)).toThrow(CustomerToolError);
      mgr.get("acme", a); // touch a so b is LRU
      mgr.get("acme", b).lastUsedAt = 0;
      const c = mgr.open("acme", "rev-a", FILES);
      expect(mgr.list("acme").sort()).toEqual([a, c].sort());
      mgr.get("acme", a).lastUsedAt = 0;
      expect(await mgr.sweep(Date.now())).toBe(1);
      expect(mgr.has("acme", a)).toBe(false);
      // The evicted workspace's lease was terminated.
      await expect(fs.stat(created[0]!.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(mgr.has("globex", other)).toBe(true);
    } finally {
      await mgr.closeAll();
    }
  });
});

describe("dispatchCustomerTool", () => {
  it("returns JSON-able receipts and error receipts", async () => {
    const mgr = new CustomerWorkspaceManager({ sweepIntervalMs: 0, leaseFactory: async () => { throw new Error("no sandbox in this test"); } });
    try {
      const id = mgr.open("acme", "rev-a", FILES);
      const ok = await dispatchCustomerTool(mgr, "acme", id, "read", { path: "$KNOWLEDGE/index.md" });
      expect(ok).toMatchObject({ tool: "read", ok: true });
      expect(JSON.parse(JSON.stringify(ok))).toEqual(ok);
      expect(await dispatchCustomerTool(mgr, "acme", id, "read", { path: "../x" })).toMatchObject({ ok: false, code: "invalid_path" });
      expect(await dispatchCustomerTool(mgr, "acme", id, "read", {})).toMatchObject({ ok: false, code: "invalid_input" });
      expect(await dispatchCustomerTool(mgr, "acme", id, "ask_knowledge", {})).toMatchObject({ ok: false, code: "invalid_input" });
      expect(await dispatchCustomerTool(mgr, "other", id, "ls", {})).toMatchObject({ ok: false, code: "workspace_not_found" });
      expect(CUSTOMER_TOOL_DEFINITIONS.find((d) => d.name === "read")!.description).toContain(CUSTOMER_WORKSPACE_ORIENTATION);
      expect(CUSTOMER_TOOL_DEFINITIONS.every((d) => d.readOnly === !d.mutates)).toBe(true);
    } finally {
      await mgr.closeAll();
    }
  });
});
