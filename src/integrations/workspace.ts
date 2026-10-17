import { randomUUID } from "node:crypto";
import type { ExecResult } from "../sandbox/types.js";
import { sha256 } from "../util.js";
import { assertSlug, buildBranch, normalizeRepoPath } from "./paths.js";
import { AGENT_UID, type IntegrationSandbox, type SandboxUser } from "./sandbox.js";
import { harnessFiles, toolFiles } from "./template.js";
import { IntegrationError } from "./types.js";

/**
 * One integration repository inside an IntegrationSandbox.
 *
 * Git trust boundary (OS-enforced on Modal):
 *  - the git dir lives at <gitDir>/<slug>.git, root-owned under a root-owned 0755
 *    parent, OUTSIDE the agent-writable working tree <mcps>/<slug>/. The agent uid
 *    cannot rename, replace, symlink or write it (no write permission on it or its
 *    parent). Any ".git" entry the agent creates inside the worktree is ignored by
 *    host git (explicit --git-dir/--work-tree, no discovery) and rejected by the
 *    validation policy scan.
 *  - host git always runs with GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null,
 *    core.hooksPath=/dev/null, core.fsmonitor=false, and the per-repo config is
 *    host-written; in-tree .gitattributes files are rejected by policy, so no
 *    agent-defined filter/diff/textconv/export-subst can run or change archives.
 *  - working tree files are agent-owned and edited via tools/fsop.mjs running as
 *    the agent uid. The agent's raw commands get GIT_DIR/GIT_WORK_TREE for
 *    read-only git; commit/reset/rebase/update-ref fail with EACCES.
 */
export interface CommandReceipt {
  argv: string[];
  cwd: string;
  user: SandboxUser;
  timeoutMs: number;
  maxOutputBytes: number;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutSha256: string;
  stderrSha256: string;
  sandbox: { provider: string; id: string; blockNetwork: boolean };
}

export interface GitStatusEntry {
  path: string;
  origPath?: string;
  /** Porcelain v2 XY (index, worktree) or "??" untracked / "UU"-style unmerged. */
  xy: string;
  kind: "changed" | "renamed" | "unmerged" | "untracked";
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  clean: boolean;
  entries: GitStatusEntry[];
}

export interface GitLogEntry {
  commit: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
/** Config sources for host git: only the host-written per-repo config is read. */
const HOST_GIT_ENV: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const COMMITTER = ["-c", "user.name=procmem-integration-builder", "-c", "user.email=integration-builder@procmem.invalid"];

export class RepoWorkspace {
  readonly repoDir: string;
  readonly gitDir: string;
  readonly branch: string;

  constructor(
    readonly sandbox: IntegrationSandbox,
    readonly slug: string,
    readonly buildId: string,
  ) {
    assertSlug(slug);
    this.repoDir = `${sandbox.layout.mcpsDir}/${slug}`;
    this.gitDir = `${sandbox.layout.gitDir}/${slug}.git`;
    this.branch = buildBranch(buildId);
  }

  get #enforcing() {
    return this.sandbox.provider === "modal";
  }

  /**
   * Install host scripts once per sandbox:
   *  - tools/ (fsop.mjs) root:root 0755/0644 — executed by the agent uid;
   *  - harness/ (orchestrator, MCP case client, fixtures) root:harness 0750/0640 —
   *    unreadable by the agent uid; held-out cases never touch disk at all (stdin only).
   */
  static async prepareSandbox(sandbox: IntegrationSandbox): Promise<void> {
    const gid = sandbox.policy.harnessUid;
    for (const [rel, bytes] of await toolFiles()) await sandbox.writeFile(`${sandbox.layout.toolsDir}/${rel}`, bytes, { mode: 0o644 });
    for (const [rel, bytes] of await harnessFiles()) await sandbox.writeFile(`${sandbox.layout.harnessDir}/${rel}`, bytes, { mode: 0o640, gid });
    if (sandbox.provider === "modal") {
      const r = await sandbox.exec(
        ["/bin/sh", "-c", 'set -e; chown -R 0:0 -- "$1"; chmod -R a+rX,go-w -- "$1"; chown -R "0:$3" -- "$2"; find "$2" -type d -exec chmod 0750 {} +; find "$2" -type f -exec chmod 0640 {} +', "prep", sandbox.layout.toolsDir, sandbox.layout.harnessDir, String(gid)],
        { user: "root", timeoutMs: 30_000 },
      );
      if (r.exitCode !== 0) throw new IntegrationError("sandbox_setup_failed", `Harness install failed: ${r.stderr.slice(0, 500)}`);
    }
  }

  async run(argv: string[], user: SandboxUser, opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string>; stdin?: string | Uint8Array } = {}): Promise<CommandReceipt> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;
    const cwd = opts.cwd ?? this.sandbox.layout.root;
    const startedAt = new Date().toISOString();
    const r: ExecResult = await this.sandbox.exec(argv, { user, cwd, timeoutMs, maxOutputBytes, ...(opts.env ? { env: opts.env } : {}), ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    return {
      argv,
      cwd,
      user,
      timeoutMs,
      maxOutputBytes,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: r.stdout,
      stderr: r.stderr,
      stdoutTruncated: r.stdoutTruncated,
      stderrTruncated: r.stderrTruncated,
      stdoutSha256: sha256(r.stdout),
      stderrSha256: sha256(r.stderr),
      sandbox: { provider: this.sandbox.provider, id: this.sandbox.id, blockNetwork: this.sandbox.policy.blockNetwork },
    };
  }

  async #must(argv: string[], user: SandboxUser, code: string, opts: Parameters<RepoWorkspace["run"]>[2] = {}): Promise<CommandReceipt> {
    const r = await this.run(argv, user, opts);
    if (r.exitCode !== 0) {
      throw new IntegrationError(code, `${argv.slice(0, 6).join(" ")} failed (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""}): ${(r.stderr || r.stdout).slice(0, 1500)}`);
    }
    return r;
  }

  /** Host git argv: explicit git dir + work tree (no discovery), hooks/fsmonitor disabled. */
  #git(args: string[]): string[] {
    return ["git", `--git-dir=${this.gitDir}`, `--work-tree=${this.repoDir}`, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...COMMITTER, ...args];
  }

  /** Root git: pre-flight ownership check + sanitized config sources. */
  async #rootGit(args: string[], code = "git_failed", opts: Parameters<RepoWorkspace["run"]>[2] = {}): Promise<CommandReceipt> {
    await this.#assertGitDirSafe();
    return this.#must(this.#git(args), "root", code, { ...opts, env: { ...HOST_GIT_ENV, ...(opts.env ?? {}) } });
  }

  /** Environment for the agent uid's read-only git (status/diff/log). */
  get agentGitEnv(): Record<string, string> {
    return { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.repoDir };
  }

  async #agentGit(args: string[], code = "git_failed", maxOutputBytes = 256 * 1024): Promise<CommandReceipt> {
    return this.#must(["git", "--no-pager", ...args], "agent", code, { maxOutputBytes, env: this.agentGitEnv });
  }

  async #assertGitDirSafe(): Promise<void> {
    if (!this.#enforcing) return;
    const r = await this.run(["/usr/bin/stat", "-c", "%u %a %F", this.sandbox.layout.gitDir, this.gitDir, `${this.gitDir}/config`], "root", { timeoutMs: 15_000 });
    const lines = r.stdout.trim().split("\n");
    const ok = r.exitCode === 0 && lines.length === 3 && /^0 7[0-5][0-5] directory$/.test(lines[0]!) && /^0 7[0-5][0-5] directory$/.test(lines[1]!) && /^0 6[0-4][0-4] regular (empty )?file$/.test(lines[2]!);
    if (!ok) throw new IntegrationError("git_dir_tampered", `Refusing host git operation: ${this.gitDir} is not a root-owned, non-agent-writable git dir (${r.stdout.trim() || r.stderr.trim()})`);
  }

  async #fixOwnership(): Promise<void> {
    if (!this.#enforcing) return;
    await this.#must(
      ["/bin/sh", "-c", 'set -e; chown -R 0:0 -- "$1"; chmod -R go-w -- "$1"; chown -R -h "$3:$3" -- "$2"; chmod 0755 -- "$2"', "own", this.gitDir, this.repoDir, String(AGENT_UID)],
      "root",
      "sandbox_setup_failed",
    );
  }

  async exists(): Promise<boolean> {
    const r = await this.run(["test", "-d", this.gitDir], "root", { timeoutMs: 15_000 });
    return r.exitCode === 0;
  }

  /**
   * Materialize the repo: from a durable git bundle (full history, all branches)
   * or, for a new integration, from scaffold files committed on main. Then
   * check out codex/build-<id> (resuming it if the bundle already has it).
   */
  async hydrate(src: { bundle: Buffer } | { files: Map<string, string>; message: string }): Promise<{ created: boolean; resumedBranch: boolean; head: string }> {
    if (await this.exists()) throw new IntegrationError("already_open", `Repository ${this.slug} is already materialized in this sandbox`);
    await this.#must(["/bin/mkdir", "-p", "--", this.repoDir], "root", "sandbox_setup_failed");
    await this.#must(["git", "init", "-q", "--bare", "-b", "main", this.gitDir], "root", "git_failed", { env: HOST_GIT_ENV });
    await this.#must(["git", `--git-dir=${this.gitDir}`, "config", "core.bare", "false"], "root", "git_failed", { env: HOST_GIT_ENV });
    // No sample hooks, no info/ excludes from templates: the host owns every byte of the git dir.
    await this.#must(["/bin/rm", "-rf", "--", `${this.gitDir}/hooks`], "root", "git_failed");
    let created = false;
    if ("bundle" in src) {
      const bundlePath = `${this.sandbox.layout.runsDir}/${this.slug}-${randomUUID()}.bundle`;
      await this.sandbox.writeFile(bundlePath, src.bundle);
      await this.#rootGit(["bundle", "verify", "-q", bundlePath], "bundle_invalid");
      await this.#rootGit(["fetch", "-q", "--update-head-ok", bundlePath, "+refs/heads/*:refs/heads/*"], "bundle_invalid");
      await this.run(["/bin/rm", "-f", "--", bundlePath], "root");
      await this.#rootGit(["checkout", "-q", "-f", "main"], "git_failed");
    } else {
      created = true;
      for (const [rel, content] of src.files) {
        normalizeRepoPath(rel);
        await this.sandbox.writeFile(`${this.repoDir}/${rel}`, content);
      }
      await this.#rootGit(["add", "-A"]);
      await this.#rootGit(["commit", "-q", "-m", src.message]);
    }
    const branches = await this.#branchNames();
    const resumedBranch = branches.includes(this.branch);
    if (resumedBranch) await this.#rootGit(["checkout", "-q", "-f", this.branch]);
    else await this.#rootGit(["checkout", "-q", "-b", this.branch, "main"]);
    await this.#fixOwnership();
    return { created, resumedBranch, head: await this.head() };
  }

  async #branchNames(): Promise<string[]> {
    const r = await this.#rootGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return r.stdout.split("\n").filter(Boolean);
  }

  async head(): Promise<string> {
    const r = await this.#rootGit(["rev-parse", "HEAD"]);
    const sha = r.stdout.trim();
    if (!SHA_RE.test(sha)) throw new IntegrationError("git_failed", `Unexpected HEAD ${sha}`);
    return sha;
  }

  async resolve(ref: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(ref) || ref.includes("..")) throw new IntegrationError("invalid_ref", `Invalid ref ${JSON.stringify(ref)}`);
    await this.#assertGitDirSafe();
    const r = await this.run(this.#git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]), "root", { env: HOST_GIT_ENV });
    const sha = r.stdout.trim();
    if (r.exitCode !== 0 || !SHA_RE.test(sha)) throw new IntegrationError("unknown_ref", `Unknown commit/ref ${ref}`);
    return sha;
  }

  async commitTree(commit: string): Promise<string> {
    const r = await this.#rootGit(["rev-parse", `${commit}^{tree}`]);
    return r.stdout.trim();
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    await this.#assertGitDirSafe();
    const r = await this.run(this.#git(["merge-base", "--is-ancestor", ancestor, descendant]), "root", { env: HOST_GIT_ENV });
    if (r.exitCode === 0) return true;
    if (r.exitCode === 1) return false;
    throw new IntegrationError("git_failed", `merge-base failed: ${r.stderr.slice(0, 500)}`);
  }

  // ---- agent-uid file operations -------------------------------------------------

  async #fsop<T>(req: Record<string, unknown>): Promise<T> {
    const r = await this.run(["node", `${this.sandbox.layout.toolsDir}/fsop.mjs`], "agent", { stdin: JSON.stringify({ repo: this.repoDir, ...req }), timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024 });
    let parsed: { ok: boolean; code?: string; message?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      throw new IntegrationError("fs_error", `File operation failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500)}`);
    }
    if (!parsed.ok) throw new IntegrationError(parsed.code ?? "fs_error", parsed.message ?? "File operation failed");
    return parsed as T;
  }

  async list(relDir: string, limit = 2000) {
    const p = normalizeRepoPath(relDir, { allowRoot: true });
    return this.#fsop<{ entries: Array<{ path: string; type: string; bytes?: number; target?: string }>; truncated: boolean }>({ op: "list", path: p, limit });
  }

  async read(relPath: string, maxBytes = 256 * 1024): Promise<{ text: string; bytes: number; truncated: boolean }> {
    const p = normalizeRepoPath(relPath);
    const r = await this.#fsop<{ base64: string; bytes: number; truncated: boolean }>({ op: "read", path: p, maxBytes });
    return { text: Buffer.from(r.base64, "base64").toString("utf8"), bytes: r.bytes, truncated: r.truncated };
  }

  async write(relPath: string, content: string): Promise<{ path: string; bytes: number; sha256: string }> {
    const p = normalizeRepoPath(relPath);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > 512 * 1024) throw new IntegrationError("file_too_large", "File content exceeds 512 KiB");
    await this.#fsop({ op: "write", path: p, base64: bytes.toString("base64") });
    return { path: p, bytes: bytes.length, sha256: sha256(bytes) };
  }

  async remove(relPath: string): Promise<void> {
    await this.#fsop({ op: "delete", path: normalizeRepoPath(relPath) });
  }

  /** Policy scan of the whole working tree (run as root so nothing is hidden by permissions). */
  async scan(): Promise<{ fileCount: number; totalBytes: number; symlinks: string[]; nestedGit: string[]; special: string[]; gitmodules: boolean; gitattributes: string[]; large: string[]; truncated: boolean }> {
    const r = await this.run(["node", `${this.sandbox.layout.toolsDir}/fsop.mjs`], "root", { stdin: JSON.stringify({ repo: this.repoDir, op: "scan" }), timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 });
    const parsed = JSON.parse(r.stdout || "{}");
    if (!parsed.ok) throw new IntegrationError(parsed.code ?? "fs_error", parsed.message ?? `scan failed: ${r.stderr.slice(0, 300)}`);
    return parsed;
  }

  /** Arbitrary bounded command as the agent uid, cwd inside the repo. Network is blocked by the sandbox policy. */
  async exec(command: string, opts: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<CommandReceipt> {
    const rel = normalizeRepoPath(opts.cwd ?? "", { allowRoot: true });
    const cwd = rel ? `${this.repoDir}/${rel}` : this.repoDir;
    return this.run(["/bin/bash", "-c", command], "agent", { cwd, env: this.agentGitEnv, timeoutMs: Math.min(opts.timeoutMs ?? 120_000, 600_000), maxOutputBytes: Math.min(opts.maxOutputBytes ?? 64 * 1024, 1024 * 1024) });
  }

  // ---- read-only git (agent uid) -------------------------------------------------

  async status(): Promise<GitStatus> {
    const r = await this.#agentGit(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    return parsePorcelainV2(r.stdout);
  }

  async diff(opts: { staged?: boolean; base?: string; paths?: string[]; stat?: boolean; maxOutputBytes?: number } = {}): Promise<{ diff: string; truncated: boolean }> {
    const args = ["diff", "--no-color", "--no-ext-diff"];
    if (opts.stat) args.push("--stat");
    if (opts.staged) args.push("--cached");
    if (opts.base) args.push(await this.resolve(opts.base));
    args.push("--", ...(opts.paths ?? []).map((p) => normalizeRepoPath(p)));
    const r = await this.run(["git", "--no-pager", ...args], "agent", { env: this.agentGitEnv, maxOutputBytes: Math.min(opts.maxOutputBytes ?? 128 * 1024, 1024 * 1024) });
    if (r.exitCode !== 0) throw new IntegrationError("git_failed", r.stderr.slice(0, 800));
    // Untracked files are not in `git diff`; status lists them.
    return { diff: r.stdout, truncated: r.stdoutTruncated };
  }

  async log(opts: { ref?: string; maxCount?: number } = {}): Promise<GitLogEntry[]> {
    const ref = opts.ref ? await this.resolve(opts.ref) : "HEAD";
    const r = await this.#agentGit(["log", `--max-count=${Math.min(Math.max(opts.maxCount ?? 20, 1), 200)}`, "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1e", ref]);
    return r.stdout
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [commit, parents, author, date, subject] = line.split("\x1f");
        return { commit: commit!, parents: (parents ?? "").split(" ").filter(Boolean), author: author ?? "", date: date ?? "", subject: subject ?? "" };
      });
  }

  async branches(): Promise<Array<{ name: string; commit: string; current: boolean }>> {
    const r = await this.#agentGit(["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(HEAD)", "refs/heads"]);
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, commit, head] = l.split("\t");
        return { name: name!, commit: commit!, current: head === "*" };
      });
  }

  // ---- host-owned git writes (root) ----------------------------------------------

  /** Tree id of the exact working tree (tracked + untracked, honoring .gitignore) without touching the real index. */
  async worktreeTree(): Promise<string> {
    const index = `${this.sandbox.layout.runsDir}/${this.slug}-${randomUUID()}.index`;
    try {
      await this.#rootGit(["read-tree", "HEAD"], "git_failed", { env: { GIT_INDEX_FILE: index } });
      await this.#rootGit(["add", "-A"], "git_failed", { env: { GIT_INDEX_FILE: index } });
      const r = await this.#rootGit(["write-tree"], "git_failed", { env: { GIT_INDEX_FILE: index } });
      return r.stdout.trim();
    } finally {
      await this.run(["/bin/rm", "-f", "--", index], "root");
    }
  }

  /** All file paths in a tree (for deployability policy checks). */
  async treePaths(tree: string): Promise<string[]> {
    const r = await this.#rootGit(["ls-tree", "-r", "-z", "--name-only", "--full-tree", tree], "git_failed", { maxOutputBytes: 4 * 1024 * 1024 });
    return r.stdout.split("\0").filter(Boolean);
  }

  /** Extract an exact tree into a fresh agent-owned stage dir (for sealed tests/build/smoke). */
  async stageTree(tree: string, stageId: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/.test(tree) || !/^[a-z0-9-]{6,80}$/.test(stageId)) throw new IntegrationError("invalid_input", "Invalid tree or stage id");
    const dir = `${this.sandbox.layout.stageDir}/${stageId}`;
    await this.#assertGitDirSafe();
    await this.#must(
      ["/bin/bash", "-c", 'set -euo pipefail; mkdir -p -- "$3"; git --git-dir="$1" -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null archive --format=tar "$2" | tar -x --no-same-owner -C "$3"', "stage", this.gitDir, tree, dir],
      "root",
      "stage_failed",
      { timeoutMs: 120_000, env: HOST_GIT_ENV },
    );
    if (this.#enforcing) await this.#must(["/bin/chown", "-R", "-h", `${AGENT_UID}:${AGENT_UID}`, "--", dir], "root", "stage_failed");
    return dir;
  }

  /** Unpack exact archive bytes (app/ prefix stripped) into a fresh stage dir, to hash what will be deployed. */
  async extractArchive(bytes: Buffer, stageId: string): Promise<string> {
    if (!/^[a-z0-9-]{6,80}$/.test(stageId)) throw new IntegrationError("invalid_input", "Invalid stage id");
    const file = `${this.sandbox.layout.runsDir}/${stageId}.tar.gz`;
    const dir = `${this.sandbox.layout.stageDir}/${stageId}`;
    await this.sandbox.writeFile(file, bytes);
    try {
      await this.#must(["/bin/bash", "-c", 'set -euo pipefail; mkdir -p -- "$2"; tar -xzf "$1" --no-same-owner --strip-components=1 -C "$2" app/', "unpack", file, dir], "root", "archive_failed", { timeoutMs: 120_000 });
    } finally {
      await this.run(["/bin/rm", "-f", "--", file], "root");
    }
    return dir;
  }

  async hashStage(dir: string, exclude: string[] = []): Promise<{ sha256: string; files: number }> {
    const r = await this.run(["node", `${this.sandbox.layout.toolsDir}/fsop.mjs`], "root", { stdin: JSON.stringify({ repo: dir, op: "hash", exclude }), timeoutMs: 60_000 });
    const parsed = JSON.parse(r.stdout || "{}");
    if (!parsed.ok) throw new IntegrationError(parsed.code ?? "fs_error", parsed.message ?? "hash failed");
    return { sha256: parsed.sha256, files: parsed.files };
  }

  /**
   * Seal an exact-tree stage for the validation gate: every source file/dir becomes
   * root-owned and non-writable; only the build output dir (.mcp-use/) and the generated
   * mcp-env.d.ts are agent-writable. Enforced by the OS on Modal (no-op on host-test).
   */
  async sealStageSource(dir: string): Promise<void> {
    this.#assertStage(dir);
    if (!this.#enforcing) return;
    await this.#must(
      ["/bin/sh", "-c", 'set -e; chown -R -h 0:0 -- "$1"; chmod -R a+rX,go-w -- "$1"', "seal", dir],
      "root",
      "stage_failed",
    );
    await this.resetStageOutputs(dir);
  }

  /** Fresh, empty agent-writable outputs (discarding anything an earlier phase planted). */
  async resetStageOutputs(dir: string): Promise<void> {
    this.#assertStage(dir);
    const script = this.#enforcing
      ? 'set -e; rm -rf -- "$1/.mcp-use" "$1/mcp-env.d.ts"; mkdir -- "$1/.mcp-use"; : > "$1/mcp-env.d.ts"; chown -h "$2:$2" -- "$1/.mcp-use" "$1/mcp-env.d.ts"; chmod 0755 -- "$1/.mcp-use"; chmod 0644 -- "$1/mcp-env.d.ts"'
      : 'set -e; rm -rf -- "$1/.mcp-use" "$1/mcp-env.d.ts"';
    await this.#must(["/bin/sh", "-c", script, "outputs", dir, String(AGENT_UID)], "root", "stage_failed");
  }

  /** Freeze build output before the production start command runs. */
  async sealStageOutputs(dir: string): Promise<void> {
    this.#assertStage(dir);
    if (!this.#enforcing) return;
    await this.#must(["/bin/sh", "-c", 'set -e; chown -R -h 0:0 -- "$1/.mcp-use" "$1/mcp-env.d.ts"; chmod -R a+rX,go-w -- "$1/.mcp-use" "$1/mcp-env.d.ts"', "freeze", dir], "root", "stage_failed");
  }

  /**
   * Kill every agent-uid process (including setsid/daemonized ones that escaped the
   * per-command process group) so nothing from an untrusted phase outlives it.
   */
  async killAgentProcesses(): Promise<void> {
    if (!this.#enforcing) return;
    const r = await this.run(["/bin/sh", "-c", 'pkill -KILL -u "$1" 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -u "$1" >/dev/null || exit 0; sleep 0.2; pkill -KILL -u "$1" 2>/dev/null; done; echo "agent processes survived" >&2; exit 1', "reap", String(AGENT_UID)], "root", { timeoutMs: 20_000 });
    if (r.exitCode !== 0) throw new IntegrationError("sandbox_reap_failed", `Could not stop agent processes: ${r.stderr.slice(0, 300)}`);
  }

  #assertStage(dir: string) {
    if (!dir.startsWith(`${this.sandbox.layout.stageDir}/`) || dir.includes("..")) throw new IntegrationError("invalid_input", `Not a stage dir: ${dir}`);
  }

  async removeStage(dir: string): Promise<void> {
    if (!dir.startsWith(`${this.sandbox.layout.stageDir}/`)) return;
    await this.run(["/bin/rm", "-rf", "--", dir], "root", { timeoutMs: 60_000 });
  }

  /**
   * Commit the working tree on the build branch, only if it is byte-identical
   * to the validated tree. Returns the new commit sha.
   */
  async commit(message: string, validatedTree: string): Promise<{ commit: string; tree: string; parent: string }> {
    const current = (await this.status()).branch;
    if (current !== this.branch) throw new IntegrationError("wrong_branch", `HEAD is on ${current}, expected ${this.branch}`);
    const parent = await this.head();
    await this.#rootGit(["add", "-A"]);
    const tree = (await this.#rootGit(["write-tree"])).stdout.trim();
    if (tree !== validatedTree) {
      await this.#rootGit(["read-tree", "HEAD"]); // restore the index; the working tree is untouched
      throw new IntegrationError("tree_mismatch", `Working tree ${tree} differs from validated tree ${validatedTree}; run integration_validate again on the current tree`);
    }
    if (tree === (await this.commitTree(parent))) {
      throw new IntegrationError("nothing_to_commit", "Validated tree equals HEAD; nothing to commit");
    }
    await this.#rootGit(["commit", "-q", "-m", message]);
    return { commit: await this.head(), tree, parent };
  }

  /** Fast-forward refs/heads/main to `commit` (compare-and-swap on the old value). */
  async fastForwardMain(commit: string): Promise<{ previous: string }> {
    const previous = await this.resolve("main");
    if (!(await this.isAncestor(previous, commit))) throw new IntegrationError("not_fast_forward", `main (${previous.slice(0, 12)}) is not an ancestor of ${commit.slice(0, 12)}; merge main into the build branch first`);
    await this.#rootGit(["update-ref", "-m", "procmem: promote validated revision", "refs/heads/main", commit, previous]);
    return { previous };
  }

  /**
   * Deterministic deploy archive of a commit, rooted at app/ like the archives the
   * official `mcp-use deploy --no-github` uploads (Manufact unpacks app/ as the project).
   */
  async archive(commit: string): Promise<Buffer> {
    const out = `${this.sandbox.layout.runsDir}/${this.slug}-${commit}.tar.gz`;
    await this.#rootGit(["archive", "--format=tar.gz", "--prefix=app/", "-o", out, commit], "archive_failed", { timeoutMs: 120_000 });
    try {
      return await this.sandbox.readFile(out);
    } finally {
      await this.run(["/bin/rm", "-f", "--", out], "root");
    }
  }

  /** Full-history bundle of every branch plus the branch->commit map it contains. */
  async bundle(): Promise<{ bytes: Buffer; refs: Record<string, string> }> {
    const out = `${this.sandbox.layout.runsDir}/${this.slug}-${randomUUID()}.bundle`;
    await this.#rootGit(["bundle", "create", "-q", out, "--branches"], "bundle_failed", { timeoutMs: 120_000 });
    try {
      const bytes = await this.sandbox.readFile(out);
      const refs: Record<string, string> = {};
      for (const b of await this.branches()) refs[b.name] = b.commit;
      return { bytes, refs };
    } finally {
      await this.run(["/bin/rm", "-f", "--", out], "root");
    }
  }

  /** Every previously persisted branch must still exist and only have moved forward. */
  async verifyHistoryPreserved(previous: Record<string, string>): Promise<{ ok: true } | { ok: false; problems: string[] }> {
    const current = Object.fromEntries((await this.branches()).map((b) => [b.name, b.commit]));
    const problems: string[] = [];
    for (const [name, sha] of Object.entries(previous)) {
      const now = current[name];
      if (!now) problems.push(`branch ${name} was deleted`);
      else if (now !== sha && !(await this.isAncestor(sha, now))) problems.push(`branch ${name} was rewritten (${sha.slice(0, 12)} is no longer an ancestor of ${now.slice(0, 12)})`);
    }
    return problems.length ? { ok: false, problems } : { ok: true };
  }
}

/** Parse `git status --porcelain=v2 --branch -z` (documented machine-readable format). */
export function parsePorcelainV2(raw: string): GitStatus {
  const status: GitStatus = { branch: null, head: null, clean: true, entries: [] };
  const recs = raw.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    if (!rec) continue;
    if (rec.startsWith("# branch.oid ")) status.head = rec.slice(13) === "(initial)" ? null : rec.slice(13);
    else if (rec.startsWith("# branch.head ")) status.branch = rec.slice(14) === "(detached)" ? null : rec.slice(14);
    else if (rec.startsWith("# ")) continue;
    else if (rec.startsWith("1 ")) {
      const f = rec.split(" ");
      status.entries.push({ kind: "changed", xy: f[1]!, path: f.slice(8).join(" ") });
    } else if (rec.startsWith("2 ")) {
      const f = rec.split(" ");
      status.entries.push({ kind: "renamed", xy: f[1]!, path: f.slice(9).join(" "), origPath: recs[++i] ?? "" });
    } else if (rec.startsWith("u ")) {
      const f = rec.split(" ");
      status.entries.push({ kind: "unmerged", xy: f[1]!, path: f.slice(10).join(" ") });
    } else if (rec.startsWith("? ")) status.entries.push({ kind: "untracked", xy: "??", path: rec.slice(2) });
  }
  status.clean = status.entries.length === 0;
  return status;
}
