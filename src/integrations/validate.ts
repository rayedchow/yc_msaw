import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CHILD_ALLOWED_DEPENDENCIES } from "./sandbox.js";
import { IntegrationError } from "./types.js";
import type { CommandReceipt, RepoWorkspace } from "./workspace.js";

/**
 * Sealed host validation gate for one integration working tree.
 *
 *  1. policy scan of the live tree (symlinks, nested repos, submodules, special/large files)
 *  2. exact tree id of the working tree (temporary index; real index untouched)
 *  3. `git archive <tree>` into a fresh stage dir; content sha256 of that checkout
 *  4. manifest + package checks (pinned pre-baked deps; production build/start scripts)
 *  5. `npm test` and `npm run build` in the stage dir (agent uid, no network)
 *  6. real MCP initialize / tools/list / tools/call over Streamable HTTP against the
 *     production start command, for the repo's smoke cases plus host-held regression
 *     and held-out suites (fixtures + clients run as the separate harness uid),
 *     including an unauthenticated request that must be rejected with 401.
 * Everything binds to the tree id + content hash in one receipt.
 */

/** Directory/file names the official CLI's managed archive excludes at any depth (@mcp-use/cli 4.4.0). */
export const MANUFACT_EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".vercel", ".cache", ".parcel-cache", ".pytest_cache", ".ruff_cache", ".mypy_cache", "__pycache__", ".venv", "venv", "coverage", ".nyc_output", ".output", "out", "target", ".mcp-use"]);

const ExpectSchema = z.object({
  path: z.string().min(1).max(200),
  op: z.enum(["equals", "notEquals", "gte", "lte", "exists", "absent", "contains", "lengthEquals", "unique"]),
  value: z.unknown().optional(),
});

const StepSchema = z.object({
  tool: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).optional(),
  expect: z.array(ExpectSchema).max(50).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

export const SuiteCaseSchema = z.object({
  name: z.string().min(1).max(160),
  fixture: z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/), config: z.record(z.string(), z.unknown()).default({}) }).optional(),
  env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(500)).optional(),
  steps: z.array(StepSchema).min(1).max(40),
  fixtureExpect: z.array(ExpectSchema).max(50).optional(),
  checkAuth: z.boolean().optional(),
});
export type SuiteCase = z.infer<typeof SuiteCaseSchema>;

export const ManifestSchema = z.object({
  slug: z.string(),
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  version: z.string().optional(),
  upstream: z.object({ name: z.string().max(120), docs: z.array(z.string().max(500)).max(50).default([]) }).passthrough(),
  tools: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).min(1).max(64),
  env: z
    .array(z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), required: z.boolean(), secret: z.boolean(), description: z.string().max(500).optional() }))
    .max(50),
  smoke: z.array(SuiteCaseSchema).min(1).max(40),
});
export type IntegrationManifest = z.infer<typeof ManifestSchema>;

export interface HostSuite {
  id: string;
  version: string;
  /** regression: failure details are shown to the agent. heldout: only case names/where. */
  kind: "regression" | "heldout";
  description?: string;
  cases: SuiteCase[];
}

/** Host-owned suites per integration (regressions distilled from traces, held-out variants). */
export type SuiteProvider = (slug: string) => Promise<HostSuite[]>;

export interface CaseResult {
  suite: string;
  kind: "smoke" | "regression" | "heldout";
  name: string;
  passed: boolean;
  failures: Array<{ where: string; message: string }>;
  protocol?: unknown;
  steps?: unknown;
  fixture?: unknown;
  childLogTail?: string;
  durationMs: number;
}

export interface ValidationReceiptBody {
  kind: "integration_validation";
  slug: string;
  buildId: string;
  branch: string;
  head: string;
  tree: string;
  sourceSha256: string;
  sourceFiles: number;
  /** Re-hash of the sealed stage after each phase that ran untrusted code. */
  sourceChecks: Array<{ phase: string; sha256: string; files: number; matches: boolean }>;
  /** Hash of .mcp-use/build after the production build (frozen before the start command). */
  buildOutputSha256: string | null;
  /** True when source was OS-enforced read-only for the agent uid during the gate (Modal). */
  sourceSealed: boolean;
  passed: boolean;
  failures: string[];
  policy: Record<string, unknown>;
  manifest: { tools: string[]; env: Array<{ name: string; required: boolean; secret: boolean }>; deployProbe: SuiteCase[] } | null;
  commands: Array<Omit<CommandReceipt, "stdout" | "stderr"> & { name: string; stdoutTail: string; stderrTail: string }>;
  suites: Array<{ id: string; version: string; kind: string; passed: number; failed: number }>;
  cases: CaseResult[];
  sandbox: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
}

class PolicyStop extends Error {}

/** Root-level files the production build generates inside the stage (excluded from the source hash). */
const GENERATED_OUTPUTS = ["mcp-env.d.ts"];

const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

function trimCommand(name: string, r: CommandReceipt) {
  const { stdout, stderr, ...rest } = r;
  return { name, ...rest, stdoutTail: tail(stdout, 6000), stderrTail: tail(stderr, 6000) };
}

export async function validateWorkspace(ws: RepoWorkspace, opts: { suites: HostSuite[]; fixtureNames?: string[] }): Promise<ValidationReceiptBody> {
  const startedAt = new Date().toISOString();
  const failures: string[] = [];
  const commands: ValidationReceiptBody["commands"] = [];
  const head = await ws.head();
  const branch = ws.branch;

  const scan = await ws.scan();
  const policy = { ...scan };
  if (scan.symlinks.length) failures.push(`symlinks are not allowed: ${scan.symlinks.slice(0, 10).join(", ")}`);
  if (scan.nestedGit.length) failures.push(`nested git repositories are not allowed: ${scan.nestedGit.slice(0, 10).join(", ")}`);
  if (scan.gitmodules) failures.push("submodules (.gitmodules) are not allowed");
  if (scan.gitattributes.length) failures.push(`.gitattributes files are not allowed (filters/export rules would make archives differ from tested trees): ${scan.gitattributes.join(", ")}`);
  if (scan.special.length) failures.push(`special files are not allowed: ${scan.special.slice(0, 10).join(", ")}`);
  if (scan.large.length) failures.push(`files over 1 MiB: ${scan.large.slice(0, 10).join(", ")}`);
  if (scan.fileCount > 2000 || scan.truncated) failures.push(`too many files (${scan.fileCount})`);

  const tree = await ws.worktreeTree();
  // Paths stock `mcp-use deploy --no-github` silently drops (any component named like
  // build/dist/out/... or .env*): reject them so tested source == deployable source.
  const dropped = (await ws.treePaths(tree)).filter((p) => p.split("/").some((seg) => MANUFACT_EXCLUDED_SEGMENTS.has(seg) || seg.startsWith(".env") || seg === ".DS_Store"));
  if (dropped.length) failures.push(`paths excluded by Manufact managed uploads (rename them): ${dropped.slice(0, 10).join(", ")}`);
  const stageId = `val-${randomUUID()}`;
  // Policy failures are final: never stage or execute a tree that already broke policy.
  const stage = failures.length === 0 ? await ws.stageTree(tree, stageId) : null;
  const cases: CaseResult[] = [];
  const suitesSummary: ValidationReceiptBody["suites"] = [];
  let manifest: IntegrationManifest | null = null;
  let sourceSha256 = "";
  let sourceFiles = 0;
  let buildOutputSha256: string | null = null;
  const sourceChecks: ValidationReceiptBody["sourceChecks"] = [];
  try {
    if (!stage) throw new PolicyStop();
    const hashed = await ws.hashStage(stage, GENERATED_OUTPUTS);
    sourceSha256 = hashed.sha256;
    sourceFiles = hashed.files;
    // Source stays root-owned/read-only for the whole gate; after every phase that ran
    // untrusted code, agent processes are reaped and the source is re-hashed. A mismatch is
    // a hard stop: nothing tested afterwards could be attributed to the attested tree.
    await ws.sealStageSource(stage);
    const verifySource = async (phase: string) => {
      await ws.killAgentProcesses();
      const now = await ws.hashStage(stage, GENERATED_OUTPUTS);
      sourceChecks.push({ phase, sha256: now.sha256, files: now.files, matches: now.sha256 === sourceSha256 });
      if (now.sha256 !== sourceSha256) {
        failures.push(`source changed during ${phase} (attested ${sourceSha256.slice(0, 12)}, now ${now.sha256.slice(0, 12)}); results cannot be bound to the validated tree`);
        throw new PolicyStop();
      }
    };

    const readStage = async (rel: string) => {
      const r = await ws.run(["/bin/cat", "--", `${stage}/${rel}`], "agent", { maxOutputBytes: 256 * 1024 });
      if (r.exitCode !== 0) throw new IntegrationError("manifest_missing", `${rel} is missing`);
      return r.stdout;
    };
    try {
      manifest = ManifestSchema.parse(JSON.parse(await readStage("integration.json")));
      if (manifest.slug !== ws.slug) failures.push(`integration.json slug ${manifest.slug} != ${ws.slug}`);
      for (const c of manifest.smoke) {
        if (c.fixture && opts.fixtureNames && !opts.fixtureNames.includes(c.fixture.name)) failures.push(`smoke case "${c.name}" uses unknown host fixture ${c.fixture.name}`);
      }
    } catch (error) {
      failures.push(`integration.json invalid: ${error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message}`);
    }
    try {
      const pkg = JSON.parse(await readStage("package.json")) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (pkg.scripts?.build !== "mcp-use build") failures.push('package.json scripts.build must be exactly "mcp-use build" (the command Manufact runs)');
      if (pkg.scripts?.start !== "mcp-use start") failures.push('package.json scripts.start must be exactly "mcp-use start"');
      if (!pkg.scripts?.test) failures.push("package.json scripts.test is required");
      for (const [section, deps] of [["dependencies", pkg.dependencies ?? {}], ["devDependencies", pkg.devDependencies ?? {}]] as const) {
        for (const [name, version] of Object.entries(deps)) {
          const pinned = CHILD_ALLOWED_DEPENDENCIES[name];
          if (!pinned) failures.push(`${section}.${name} is not in the pre-baked offline dependency set`);
          else if (version !== pinned) failures.push(`${section}.${name} must be pinned to ${pinned} (got ${version})`);
        }
      }
      if (!pkg.dependencies?.["mcp-use"]) failures.push("dependencies.mcp-use is required");
    } catch (error) {
      failures.push(`package.json invalid: ${(error as Error).message}`);
    }

    if (failures.length === 0) {
      const test = await ws.run(["npm", "run", "--silent", "test"], "agent", { cwd: stage, timeoutMs: 240_000, maxOutputBytes: 256 * 1024 });
      commands.push(trimCommand("npm test", test));
      if (test.exitCode !== 0) failures.push(`npm test failed (exit ${test.exitCode}${test.timedOut ? ", timed out" : ""})`);
      await verifySource("npm test");
      // Whatever the test phase left in the outputs is discarded before the production build.
      await ws.resetStageOutputs(stage);
      const build = await ws.run(["npm", "run", "--silent", "build"], "agent", { cwd: stage, timeoutMs: 240_000, maxOutputBytes: 256 * 1024 });
      commands.push(trimCommand("npm run build", build));
      if (build.exitCode !== 0) failures.push(`npm run build failed (exit ${build.exitCode}${build.timedOut ? ", timed out" : ""})`);
      await verifySource("npm run build");
      if (build.exitCode === 0) {
        await ws.sealStageOutputs(stage);
        buildOutputSha256 = (await ws.hashStage(`${stage}/.mcp-use/build`)).sha256;
      }
    }

    if (failures.length === 0 && manifest) {
      type Labeled = SuiteCase & { suite: string; kind: CaseResult["kind"] };
      const all: Labeled[] = [
        ...manifest.smoke.map((c) => ({ ...c, suite: "smoke", kind: "smoke" as const })),
        ...opts.suites.flatMap((s) => s.cases.map((c) => ({ ...SuiteCaseSchema.parse(c), suite: `${s.id}@${s.version}`, kind: s.kind }))),
      ];
      const spec = {
        stageDir: stage,
        harnessDir: ws.sandbox.layout.harnessDir,
        path: ws.sandbox.layout.path,
        agentUid: ws.sandbox.policy.agentUid,
        harnessUid: ws.sandbox.policy.harnessUid,
        uidSwitch: ws.sandbox.provider === "modal",
        startCommand: ["mcp-use", "start"],
        auth: { audience: `urn:procmem:integration:validation:${ws.slug}` },
        declaredTools: manifest.tools,
        caseTimeoutMs: 90_000,
        cases: all.map((c, i) => ({ id: i, suite: c.suite, name: c.name, fixture: c.fixture, env: c.env, steps: c.steps, fixtureExpect: c.fixtureExpect, checkAuth: c.checkAuth })),
      };
      const run = await ws.run(["node", `${ws.sandbox.layout.harnessDir}/run-suite.mjs`], "root", { cwd: ws.sandbox.layout.harnessDir, stdin: JSON.stringify(spec), timeoutMs: Math.min(60_000 + all.length * 100_000, 1_200_000), maxOutputBytes: 4 * 1024 * 1024 });
      commands.push(trimCommand("mcp suites", { ...run, stdout: run.stdout.slice(0, 200), argv: run.argv }));
      let parsed: { cases: Array<{ id: number; passed: boolean; failures: CaseResult["failures"]; protocol: unknown; steps: unknown; fixture: unknown; childLogTail: string; durationMs: number }> };
      try {
        parsed = JSON.parse(run.stdout.trim().split("\n").pop() ?? "");
      } catch {
        throw new IntegrationError("harness_failed", `Suite harness produced no result (exit ${run.exitCode}): ${run.stderr.slice(0, 1500)}`);
      }
      for (const r of parsed.cases) {
        const c = all[r.id]!;
        const base = { suite: c.suite, kind: c.kind, name: c.name, passed: r.passed, durationMs: r.durationMs };
        // Held-out details stay sealed: the agent learns which case failed and where, not the expected values.
        cases.push(
          c.kind === "heldout"
            ? { ...base, failures: r.failures.map((f) => ({ where: f.where, message: "held-out assertion failed" })) }
            : { ...base, failures: r.failures, protocol: r.protocol, steps: r.steps, fixture: r.fixture, childLogTail: r.childLogTail },
        );
      }
      const groups = new Map<string, { kind: string; passed: number; failed: number }>();
      for (const c of cases) {
        const g = groups.get(c.suite) ?? { kind: c.kind, passed: 0, failed: 0 };
        if (c.passed) g.passed++;
        else g.failed++;
        groups.set(c.suite, g);
      }
      await verifySource("mcp suites");
      const after = (await ws.hashStage(`${stage}/.mcp-use/build`)).sha256;
      if (after !== buildOutputSha256) {
        failures.push(`build output changed during mcp suites (${buildOutputSha256?.slice(0, 12)} -> ${after.slice(0, 12)})`);
        throw new PolicyStop();
      }
      for (const [id, g] of groups) {
        const [sid, version] = id.split("@");
        suitesSummary.push({ id: sid!, version: version ?? "repo", kind: g.kind, passed: g.passed, failed: g.failed });
        if (g.failed) failures.push(`${id} (${g.kind}): ${g.failed} case(s) failed`);
      }
    }
  } catch (error) {
    if (!(error instanceof PolicyStop)) throw error;
  } finally {
    if (stage) await ws.removeStage(stage);
  }
  return {
    kind: "integration_validation",
    slug: ws.slug,
    buildId: ws.buildId,
    branch,
    head,
    tree,
    sourceSha256,
    sourceFiles,
    sourceChecks,
    buildOutputSha256,
    sourceSealed: ws.sandbox.provider === "modal",
    passed: failures.length === 0 && cases.length > 0,
    failures,
    policy,
    // Fixture-free smoke cases double as the post-deploy probe against the live Manufact endpoint.
    manifest: manifest ? { tools: manifest.tools, env: manifest.env.map((e) => ({ name: e.name, required: e.required, secret: e.secret })), deployProbe: manifest.smoke.filter((c) => !c.fixture) } : null,
    commands,
    suites: suitesSummary,
    cases,
    sandbox: { ...ws.sandbox.policy, id: ws.sandbox.id },
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
