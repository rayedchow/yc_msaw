/**
 * Real Modal smoke test for the sandbox lease + customer workspace.
 *   npx tsx scripts/modal-smoke.ts
 * Uses one sandbox (short lifetime), writes sanitized evidence to
 * reports/modal-smoke.json, exits non-zero if any check fails.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ModalClient } from "modal";
import { CustomerWorkspace } from "../src/customer/index.js";
import { createModalLease, DEFAULT_MODAL_IMAGE } from "../src/sandbox/modal.js";
import type { SandboxLease } from "../src/sandbox/types.js";

interface Check {
  name: string;
  pass: boolean;
  ms: number;
  detail: Record<string, unknown>;
}

const checks: Check[] = [];
const ALLOWED_ENV = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PWD", "SHLVL", "_", "KNOWLEDGE", "WORK", "SCRATCH", "OLDPWD"]);

function sanitize(text: unknown, max = 600): string {
  const s = String(text ?? "");
  return s
    .replace(/\b(ak|as|wk|ws|tok|sk)-[A-Za-z0-9_-]{8,}/g, "$1-<redacted>")
    .replace(/(token|secret|key|password)=\S+/gi, "$1=<redacted>")
    .slice(0, max);
}

async function check(name: string, fn: () => Promise<{ pass: boolean; detail?: Record<string, unknown> }>): Promise<void> {
  const started = Date.now();
  try {
    const r = await fn();
    checks.push({ name, pass: r.pass, ms: Date.now() - started, detail: r.detail ?? {} });
  } catch (error) {
    checks.push({ name, pass: false, ms: Date.now() - started, detail: { error: sanitize(error instanceof Error ? error.message : error) } });
  }
  const c = checks[checks.length - 1]!;
  console.log(`${c.pass ? "PASS" : "FAIL"} ${name} (${c.ms}ms)${c.pass ? "" : ` ${JSON.stringify(c.detail).slice(0, 400)}`}`);
}

const FILES = new Map<string, string>([
  ["index.md", "# Procedural memory\n\n- [Deploy](deploy/index.md)\n"],
  ["deploy/index.md", "# Deploy\n\nRun `make release` then verify the canary.\n"],
]);

async function main(): Promise<number> {
  const t0 = Date.now();
  let lease: SandboxLease | undefined;
  let ws: CustomerWorkspace | undefined;
  let sandboxId = "";
  let setupMs = 0;
  try {
    lease = await createModalLease({ timeoutMs: 10 * 60_000, idleTimeoutMs: 5 * 60_000, cpu: 0.25, memoryMiB: 512, tags: { purpose: "procmem-modal-smoke" } });
    setupMs = Date.now() - t0;
    sandboxId = lease.id;
    console.log(`sandbox ready in ${setupMs}ms`);
    const l = lease;
    ws = new CustomerWorkspace({ ns: "smoke", workspaceId: "smoke-ws", revisionId: "rev-smoke", files: FILES, leaseFactory: async () => l });
    const w = ws;

    await check("workspace shell writes scratch (lease setup: materialize + protectTree verified)", async () => {
      const r = await w.shell({ script: 'echo "hello from sandbox" > out.txt && head -n 1 "$KNOWLEDGE/index.md" && pwd', yield_time_ms: 20_000 });
      return { pass: !r.running && r.exitCode === 0 && r.stdout.includes("# Procedural memory") && r.stdout.includes("/work/scratch"), detail: { exitCode: r.exitCode, stdout: sanitize(r.stdout) } };
    });

    await check("workspace read scratch file written by shell", async () => {
      const r = await w.read({ path: "$WORK/scratch/out.txt" });
      return { pass: r.content === "hello from sandbox", detail: { content: r.content } };
    });

    await check("workspace grep knowledge (host) and scratch (sandbox)", async () => {
      const k = await w.grep({ pattern: "make \\w+" });
      const s = await w.grep({ path: "$WORK/scratch", pattern: "sandbox" });
      return {
        pass: k.matches.length === 1 && k.matches[0]?.path === "$KNOWLEDGE/deploy/index.md" && s.matches.length === 1 && s.matches[0]?.path === "$WORK/scratch/out.txt",
        detail: { knowledge: k.matches, scratch: s.matches },
      };
    });

    await check("workspace write/edit/ls/find scratch via agent uid", async () => {
      await w.write({ path: "notes/a.md", content: "one\ntwo\n" });
      await w.edit({ path: "notes/a.md", edits: [{ oldText: "two", newText: "TWO" }] });
      const r = await w.shell({ script: "cat notes/a.md; stat -c '%u %a' notes/a.md", yield_time_ms: 10_000 });
      const ls = await w.ls({ path: "$WORK/scratch" });
      const find = await w.find({ path: "$WORK/scratch", pattern: "*.md" });
      return {
        pass: r.stdout.startsWith("one\nTWO\n") && r.stdout.includes("1000 644") && ls.entries.some((e) => e.name === "notes/") && find.matches.includes("$WORK/scratch/notes/a.md"),
        detail: { stdout: sanitize(r.stdout), ls: ls.entries.map((e) => e.name), find: find.matches },
      };
    });

    await check("agent uid is unprivileged", async () => {
      const r = await l.exec(["id"], { user: "agent", timeoutMs: 10_000 });
      const u = await l.exec(["id", "-u"], { user: "agent", timeoutMs: 10_000 });
      const caps = await l.exec(["/bin/bash", "-c", "grep -E '^Cap(Eff|Prm|Bnd)' /proc/self/status"], { user: "agent", timeoutMs: 10_000 });
      return { pass: u.stdout.trim() === "1000" && /CapEff:\s+0+\b/.test(caps.stdout), detail: { id: r.stdout.trim(), caps: caps.stdout.trim() } };
    });

    await check("knowledge is read-only for agent (OS-enforced)", async () => {
      const script = [
        'for op in "append" "create" "mkdir" "unlink" "rename" "chmod"; do',
        '  case $op in',
        '    append) out=$( (echo x >> "$KNOWLEDGE/index.md") 2>&1);;',
        '    create) out=$( (echo x > "$KNOWLEDGE/new.md") 2>&1);;',
        '    mkdir) out=$(mkdir "$KNOWLEDGE/newdir" 2>&1);;',
        '    unlink) out=$(rm -f "$KNOWLEDGE/index.md" 2>&1); rc=$?; [ -e "$KNOWLEDGE/index.md" ] || out="LEAK"; (exit $rc);;',
        '    rename) out=$(mv "$KNOWLEDGE" /work/scratch/k 2>&1);;',
        '    chmod) out=$(chmod u+w "$KNOWLEDGE/index.md" 2>&1);;',
        '  esac',
        '  rc=$?; echo "$op rc=$rc $out"',
        'done',
        'stat -c "%U %a %n" "$KNOWLEDGE" "$KNOWLEDGE/index.md"',
      ].join("\n");
      const r = await w.shell({ script, yield_time_ms: 15_000 });
      const lines = r.stdout.trim().split("\n");
      const opLines = lines.slice(0, 6);
      const allDenied = opLines.length === 6 && opLines.every((x) => !/rc=0\b/.test(x) && !x.includes("LEAK") && /(Permission denied|Read-only|Operation not permitted)/.test(x));
      const content = await w.read({ path: "$KNOWLEDGE/index.md" });
      const inSandbox = await l.exec(["cat", "/memory/knowledge/index.md"], { user: "agent", timeoutMs: 10_000 });
      return { pass: allDenied && inSandbox.stdout === FILES.get("index.md") && content.content.startsWith("# Procedural memory"), detail: { results: lines.map((x) => sanitize(x, 200)) } };
    });

    await check("scratch symlink cannot redirect writes into knowledge", async () => {
      await w.shell({ script: "ln -sf \"$KNOWLEDGE/index.md\" evil.md", yield_time_ms: 10_000 });
      let rejected = "";
      try {
        await w.write({ path: "evil.md", content: "pwned" });
      } catch (error) {
        rejected = (error as { code?: string }).code ?? "error";
      }
      const after = await l.exec(["cat", "/memory/knowledge/index.md"], { user: "root", timeoutMs: 10_000 });
      return { pass: rejected !== "" && after.stdout === FILES.get("index.md"), detail: { rejectedWith: rejected } };
    });

    await check("agent env has only allowlisted vars; no secrets; /proc/1/environ unreadable", async () => {
      const r = await w.shell({ script: "env | cut -d= -f1 | sort; echo ---; cat /proc/1/environ >/dev/null 2>&1 && echo ENVIRON_READABLE || echo environ_denied", yield_time_ms: 10_000 });
      const [envPart = "", tail = ""] = r.stdout.split("---");
      const keys = envPart.split("\n").map((s) => s.trim()).filter(Boolean);
      const extra = keys.filter((k) => !ALLOWED_ENV.has(k));
      return { pass: extra.length === 0 && keys.includes("PATH") && !keys.some((k) => /KEY|TOKEN|SECRET|MODAL/i.test(k)) && tail.includes("environ_denied"), detail: { keys, extra } };
    });

    await check("outbound network blocked", async () => {
      const dns = await l.exec(["getent", "hosts", "example.com"], { user: "agent", timeoutMs: 15_000 });
      const fetchScript =
        "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(6000)}).then(()=>{console.log('NET_OK');process.exit(0)},e=>{console.log('NET_BLOCKED',(e.cause&&e.cause.code)||e.name);process.exit(3)})";
      const http = await l.exec(["node", "-e", fetchScript], { user: "agent", timeoutMs: 20_000 });
      return {
        pass: dns.exitCode !== 0 && http.exitCode !== 0 && !http.stdout.includes("NET_OK"),
        detail: { dnsExit: dns.exitCode, fetchExit: http.exitCode, fetch: sanitize(http.stdout.trim(), 200) },
      };
    });

    await check("output capture is bounded and marked truncated", async () => {
      const r = await l.exec(["/bin/bash", "-c", "head -c 200000 /dev/zero | tr '\\0' a; echo err >&2"], { user: "agent", timeoutMs: 20_000, maxOutputBytes: 1000 });
      return { pass: r.exitCode === 0 && r.stdout.length === 1000 && r.stdoutTruncated && !r.stderrTruncated && r.stderr.trim() === "err", detail: { stdoutLen: r.stdout.length, stdoutTruncated: r.stdoutTruncated } };
    });

    await check("deadline kills the command", async () => {
      const r = await l.exec(["/bin/bash", "-c", "sleep 60 & sleep 60; echo never"], { user: "agent", timeoutMs: 2_000 });
      const left = await l.exec(["/bin/bash", "-c", "grep -l '^Uid:[[:space:]]*1000' /proc/[0-9]*/status 2>/dev/null | wc -l"], { user: "root", timeoutMs: 10_000 });
      return { pass: r.timedOut && r.durationMs < 12_000 && !r.stdout.includes("never") && left.stdout.trim() === "0", detail: { timedOut: r.timedOut, exitCode: r.exitCode, durationMs: r.durationMs, agentProcsLeft: left.stdout.trim() } };
    });

    await check("long-running command: poll, stdin, cancel kills process group", async () => {
      const started = await w.shell({ script: "sleep 300 & echo child=$!; echo ready; read line; echo got:$line; sleep 300", yield_time_ms: 3_000 });
      if (!started.running) return { pass: false, detail: { started } };
      const id = started.commandId;
      const before = await l.exec(["/bin/bash", "-c", "grep -l '^Uid:[[:space:]]*1000' /proc/[0-9]*/status 2>/dev/null | wc -l"], { user: "root", timeoutMs: 10_000 });
      const wrote = await w.write_command({ commandId: id, text: "hello\n", yield_time_ms: 3_000 });
      const polled = await w.poll_command({ commandId: id, yield_time_ms: 500 });
      const cancelled = await w.cancel_command({ commandId: id });
      const after = await l.exec(["/bin/bash", "-c", "grep -l '^Uid:[[:space:]]*1000' /proc/[0-9]*/status 2>/dev/null | wc -l"], { user: "root", timeoutMs: 10_000 });
      let unknownAfter = false;
      try {
        await w.poll_command({ commandId: id });
      } catch (error) {
        unknownAfter = (error as { code?: string }).code === "unknown_command";
      }
      return {
        pass:
          started.stdout.includes("ready") &&
          wrote.stdout.includes("got:hello") &&
          polled.running &&
          !cancelled.running &&
          cancelled.cancelled &&
          Number(before.stdout.trim()) >= 2 &&
          after.stdout.trim() === "0" &&
          unknownAfter,
        detail: {
          firstOutput: sanitize(started.stdout, 200),
          afterStdin: sanitize(wrote.stdout, 200),
          agentProcsBefore: before.stdout.trim(),
          agentProcsAfterCancel: after.stdout.trim(),
          cancelReceipt: { running: cancelled.running, cancelled: cancelled.cancelled, exitCode: cancelled.exitCode, elapsedMs: cancelled.elapsedMs },
        },
      };
    });

    await check("stdin close delivers EOF and command completes", async () => {
      const s = await w.shell({ script: "cat; echo; echo done-eof", yield_time_ms: 1_000 });
      if (!s.running) return { pass: false, detail: { s } };
      const r = await w.write_command({ commandId: s.commandId, text: "abc", close: true, yield_time_ms: 10_000 });
      return { pass: !r.running && r.exitCode === 0 && r.stdout === "abc\ndone-eof\n", detail: { stdout: r.stdout, exitCode: r.exitCode } };
    });

    await check("shell timeout_ms reports timedOut", async () => {
      const r = await w.shell({ script: "sleep 30", timeout_ms: 1_500, yield_time_ms: 15_000 });
      return { pass: !r.running && r.timedOut && r.elapsedMs < 12_000, detail: { exitCode: r.exitCode, timedOut: r.timedOut, elapsedMs: r.elapsedMs } };
    });

    await check("terminate is idempotent and cleans up the sandbox", async () => {
      await w.close();
      await w.close();
      await l.terminate();
      let execRejected = false;
      try {
        await l.exec(["true"], { user: "agent", timeoutMs: 5_000 });
      } catch {
        execRejected = true;
      }
      const client = new ModalClient();
      try {
        let code: number | null = null;
        for (let i = 0; i < 20 && code === null; i++) {
          const sb = await client.sandboxes.fromId(sandboxId);
          code = await sb.poll();
          if (code === null) await new Promise((r) => setTimeout(r, 1_000));
        }
        return { pass: execRejected && code !== null, detail: { execRejected, sandboxExitCode: code } };
      } finally {
        client.close();
      }
    });
  } catch (error) {
    checks.push({ name: "setup", pass: false, ms: Date.now() - t0, detail: { error: sanitize(error instanceof Error ? error.message : error) } });
    console.log(`FAIL setup ${sanitize(error instanceof Error ? error.message : error)}`);
  } finally {
    await ws?.close().catch(() => undefined);
    await lease?.terminate().catch(() => undefined);
  }

  const passed = checks.every((c) => c.pass) && checks.length > 0;
  const report = {
    schema: "procmem.modal-smoke/v1",
    ranAt: new Date().toISOString(),
    passed,
    provider: "modal",
    image: DEFAULT_MODAL_IMAGE,
    sandboxId,
    blockNetwork: true,
    secretsInjected: false,
    agentUid: 1000,
    setupMs,
    totalMs: Date.now() - t0,
    checks,
  };
  const out = path.resolve("reports/modal-smoke.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${passed ? "ALL PASSED" : "FAILED"} (${checks.filter((c) => c.pass).length}/${checks.length}) in ${report.totalMs}ms -> ${out}`);
  return passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(sanitize(error instanceof Error ? error.stack : error, 2000));
    process.exit(1);
  },
);
