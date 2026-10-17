/**
 * LIVE adversarial checks against a real Modal integration sandbox.
 *   INTEGRATION_LIVE_MODAL=1 npx vitest run tests/integrations-modal-live.test.ts
 * Proves (OS-enforced, as the agent uid 1000) the git trust boundary and the sealed
 * harness, instead of asserting them from code reading.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { createModalIntegrationSandbox, IntegrationStore, RepoWorkspace, type IntegrationSandbox } from "../src/integrations/index.js";
import { childTemplateFiles, fixtureNames, TEMPLATES_ROOT } from "../src/integrations/template.js";
import { validateWorkspace } from "../src/integrations/validate.js";

const live = process.env.INTEGRATION_LIVE_MODAL === "1";

describe.skipIf(!live)("integration sandbox (live Modal, adversarial)", () => {
  let sb: IntegrationSandbox;
  let ws: RepoWorkspace;
  const agent = (script: string) => ws.exec(script, { timeoutMs: 60_000 });
  const root = (script: string) => sb.exec(["/bin/bash", "-c", script], { user: "root", timeoutMs: 60_000 });

  beforeAll(async () => {
    sb = await createModalIntegrationSandbox({ tags: { purpose: "adversarial-test" } });
    await RepoWorkspace.prepareSandbox(sb);
    ws = new RepoWorkspace(sb, "adv-test", "adv-1");
    await ws.hydrate({ files: await childTemplateFiles({ slug: "adv-test", title: "Adv", description: "adversarial", upstreamName: "none" }), message: "scaffold" });
  }, 300_000);
  afterAll(async () => {
    await sb?.terminate();
  });

  it("runs agent commands as uid 1000 with no secrets and no network", async () => {
    const r = await agent('id -u; env | cut -d= -f1 | sort | tr "\\n" " "; node -e \'fetch("https://example.com").then(()=>console.log("NET-OPEN")).catch(()=>console.log("NET-BLOCKED"))\'');
    expect(r.stdout).toMatch(/^1000\n/);
    expect(r.stdout).not.toMatch(/MODAL_|MCP_USE|EXA_|API_KEY|TOKEN|SECRET/);
    expect(r.stdout).toContain("NET-BLOCKED");
  });

  it("cannot rename, replace, delete or write the root-owned git dir", async () => {
    const g = ws.gitDir;
    const r = await agent(
      [
        `mv ${g} /tmp/stolen 2>/dev/null && echo MV-OK || echo MV-DENIED`,
        `rm -rf ${g} 2>/dev/null; test -d ${g}/objects && echo RM-DENIED || echo RM-OK`,
        `echo x >> ${g}/config 2>/dev/null && echo CFG-OK || echo CFG-DENIED`,
        `mkdir ${g}/hooks 2>/dev/null && echo HOOKS-OK || echo HOOKS-DENIED`,
        `ln -s /tmp/evil ${sb.layout.gitDir}/evil.git 2>/dev/null && echo LINK-OK || echo LINK-DENIED`,
        `git update-ref refs/heads/main HEAD~0 2>/dev/null && echo REF-OK || echo REF-DENIED`,
        `git commit --allow-empty -m pwn 2>/dev/null && echo COMMIT-OK || echo COMMIT-DENIED`,
        `git status --short >/dev/null && echo STATUS-OK`,
      ].join("; "),
    );
    for (const m of ["MV-DENIED", "RM-DENIED", "CFG-DENIED", "HOOKS-DENIED", "LINK-DENIED", "REF-DENIED", "COMMIT-DENIED", "STATUS-OK"]) expect(r.stdout).toContain(m);
    expect((await root(`stat -c '%u %a' ${g}`)).stdout.trim()).toBe("0 755");
  });

  it("host git ignores agent-planted .git dirs/files with malicious config, hooks and filters", async () => {
    await agent(
      [
        "mkdir -p .git/hooks",
        `printf '[core]\\n\\tfsmonitor = "touch /tmp/pwned-fsmonitor"\\n\\thooksPath = .git/hooks\\n[filter "evil"]\\n\\tclean = "touch /tmp/pwned-filter"\\n' > .git/config`,
        "printf '#!/bin/sh\\ntouch /tmp/pwned-hook\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
        "mkdir -p sub && printf 'gitdir: /tmp/evil.git\\n' > sub/.git",
        "printf '* filter=evil\\n' > .gitattributes",
        "echo 'export const x = 1;' > src/x.ts",
      ].join(" && "),
    );
    // Host-owned operations a build would perform:
    const tree = await ws.worktreeTree();
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    await ws.status();
    const scan = await ws.scan();
    expect(scan.nestedGit.sort()).toEqual([".git", "sub/.git"]);
    expect(scan.gitattributes).toEqual([".gitattributes"]);
    const v = await validateWorkspace(ws, { suites: [] });
    expect(v.passed).toBe(false);
    expect(v.commands).toEqual([]);
    const pw = await root("ls /tmp/pwned-* 2>/dev/null | wc -l");
    expect(pw.stdout.trim()).toBe("0");
    // cleanup for later tests
    await agent("rm -rf .git sub .gitattributes src/x.ts");
  }, 180_000);

  it("cannot read the sealed harness, host scratch, or signal/inspect harness-uid processes", async () => {
    const pidOut = await root(`setsid -f /usr/bin/setpriv --reuid=1001 --regid=1001 --clear-groups -- /usr/bin/env -i SECRET_ORACLE=hidden /bin/sleep 120; sleep 0.5; pgrep -u 1001 -n sleep`);
    const pid = pidOut.stdout.trim();
    expect(pid).toMatch(/^\d+$/);
    const r = await agent(
      [
        `cat ${sb.layout.harnessDir}/case-client.mjs >/dev/null 2>&1 && echo HARNESS-READ || echo HARNESS-DENIED`,
        `ls ${sb.layout.harnessDir} >/dev/null 2>&1 && echo HARNESS-LIST || echo HARNESS-LIST-DENIED`,
        `cat ${sb.layout.harnessDir}/fixtures/notify-hub.mjs >/dev/null 2>&1 && echo FIXTURE-READ || echo FIXTURE-DENIED`,
        `ls ${sb.layout.runsDir} >/dev/null 2>&1 && echo RUNS-LIST || echo RUNS-DENIED`,
        `cat /proc/${pid}/environ >/dev/null 2>&1 && echo ENVIRON-READ || echo ENVIRON-DENIED`,
        `kill -9 ${pid} 2>/dev/null && echo KILL-OK || echo KILL-DENIED`,
        `touch ${sb.layout.toolsDir}/fsop.mjs 2>/dev/null && echo TOOLS-WRITE || echo TOOLS-DENIED`,
        `touch ${sb.layout.root}/node_modules/mcp-use/package.json 2>/dev/null && echo DEPS-WRITE || echo DEPS-DENIED`,
      ].join("; "),
    );
    for (const m of ["HARNESS-DENIED", "HARNESS-LIST-DENIED", "FIXTURE-DENIED", "RUNS-DENIED", "ENVIRON-DENIED", "KILL-DENIED", "TOOLS-DENIED", "DEPS-DENIED"]) expect(r.stdout).toContain(m);
    expect((await root(`kill -0 ${pid} && echo ALIVE`)).stdout).toContain("ALIVE");
    // The harness uid itself can read its files.
    const h = await sb.exec(["/bin/cat", `${sb.layout.harnessDir}/case-client.mjs`], { user: "harness", timeoutMs: 20_000 });
    expect(h.exitCode).toBe(0);
  });

  it("agent file tools refuse symlink escapes", async () => {
    await agent("ln -s /etc linkdir");
    await expect(ws.read("linkdir/passwd")).rejects.toMatchObject({ code: "symlink_refused" });
    await expect(ws.write("linkdir/x", "y")).rejects.toMatchObject({ code: "symlink_refused" });
    await agent("rm linkdir");
  });
});

describe.skipIf(!live)("sealed validation gate (live Modal)", () => {
  let sb: IntegrationSandbox;
  beforeAll(async () => {
    sb = await createModalIntegrationSandbox({ tags: { purpose: "gate-test" } });
    await RepoWorkspace.prepareSandbox(sb);
  }, 300_000);
  afterAll(async () => {
    await sb?.terminate();
  });

  async function repoWithTestScript(slug: string, testScript: string) {
    const ws = new RepoWorkspace(sb, slug, "gate-1");
    await ws.hydrate({ files: await childTemplateFiles({ slug, title: "Gate", description: "gate test", upstreamName: "none" }), message: "scaffold" });
    const pkg = JSON.parse((await ws.read("package.json")).text);
    pkg.scripts.test = testScript;
    await ws.write("package.json", JSON.stringify(pkg, null, 2));
    return ws;
  }

  it("a test that rewrites source is denied by the OS (source sealed) and cannot pass", async () => {
    const ws = await repoWithTestScript("gate-rewrite", `node -e "require('fs').appendFileSync('src/tools.ts', '// poisoned')" && echo REWROTE`);
    const v = await validateWorkspace(ws, { suites: [] });
    expect(v.sourceSealed).toBe(true);
    expect(v.passed).toBe(false);
    const test = v.commands.find((c) => c.name === "npm test")!;
    expect(test.exitCode).not.toBe(0);
    expect(`${test.stdoutTail}${test.stderrTail}`).toMatch(/EACCES|permission denied/i);
    expect(v.sourceChecks[0]).toMatchObject({ phase: "npm test", matches: true });
  }, 300_000);

  it("a daemonized test-phase poisoner is reaped; build output stays the built artifact through MCP checks", async () => {
    const poison = "setsid -f sh -c 'while true; do echo POISON > .mcp-use/build/index.js 2>/dev/null; echo POISON > src/tools.ts 2>/dev/null; sleep 0.1; done' >/dev/null 2>&1; echo spawned";
    const ws = await repoWithTestScript("gate-daemon", poison);
    const v = await validateWorkspace(ws, { suites: [] });
    expect(v.passed).toBe(true);
    expect(v.sourceChecks.map((c) => [c.phase, c.matches])).toEqual([["npm test", true], ["npm run build", true], ["mcp suites", true]]);
    expect(v.buildOutputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.cases.every((c) => c.passed)).toBe(true);
    const left = await sb.exec(["/bin/sh", "-c", "pgrep -u 1000 | wc -l"], { user: "root", timeoutMs: 20_000 });
    expect(left.stdout.trim()).toBe("0");
  }, 300_000);
});

// Re-gate the repaired notify-hub revision from the successful live demo (durable bundle), under the hardened gate.
const demoStore = ".data/integration-demo/20261017-aea758/store";
describe.skipIf(!live || !existsSync(demoStore))("hardened gate on the live-demo repaired source (live Modal)", () => {
  it("restores the demo bundle and passes smoke + regression v2 + held-out v2 with sealed source", async () => {
    const store = new IntegrationStore(new DirectoryObjectStore(demoStore), "demo-tenant");
    const rec = (await store.get("notify-hub"))!;
    const sb = await createModalIntegrationSandbox({ tags: { purpose: "regate-demo" } });
    try {
      await RepoWorkspace.prepareSandbox(sb);
      const ws = new RepoWorkspace(sb, "notify-hub", "regate-1");
      const h = await ws.hydrate({ bundle: await store.getBlob(rec.bundle!.key) });
      expect(h.head).toBe(rec.promoted!.commit);
      const suites = JSON.parse(await readFile(path.join(TEMPLATES_ROOT, "demo/notify-hub/suites/v2.json"), "utf8"));
      const v = await validateWorkspace(ws, { suites, fixtureNames: await fixtureNames() });
      await writeFile(".data/integration-demo/regate-evidence.json", JSON.stringify({ at: new Date().toISOString(), sandbox: v.sandbox, sourceSealed: v.sourceSealed, passed: v.passed, tree: v.tree, sourceSha256: v.sourceSha256, promotedSourceSha256: rec.promoted!.sourceSha256, sourceChecks: v.sourceChecks, buildOutputSha256: v.buildOutputSha256, cases: v.cases.map((c) => [c.kind, c.name, c.passed]), commands: v.commands.map((c) => [c.name, c.exitCode, c.durationMs]) }, null, 1));
      expect(v.passed).toBe(true);
      expect(v.tree).toBe(rec.promoted!.tree);
      expect(v.sourceSha256).toBe(rec.promoted!.sourceSha256);
      expect(v.cases).toHaveLength(13);
      expect(v.sourceChecks.every((c) => c.matches)).toBe(true);
    } finally {
      await sb.terminate();
    }
  }, 600_000);
});
