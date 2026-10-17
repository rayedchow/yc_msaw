// Host-owned suite orchestrator. Runs as root inside the integration sandbox.
// For each case: start the host fixture (harness uid), start the child MCP
// server from the exact-tree stage dir with the production start command
// (agent uid), run the MCP case client (harness uid), then kill everything.
// Input JSON on stdin; one JSON result object on stdout.
import { spawn } from "node:child_process";
import net from "node:net";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import path from "node:path";

const input = JSON.parse(
  await new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
  }),
);

const NODE = process.execPath;
const baseEnv = { PATH: input.path, HOME: "/tmp", TMPDIR: "/tmp", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NO_COLOR: "1" };

function asUser(uid, argv, env) {
  const envArgs = Object.entries({ ...baseEnv, ...env }).map(([k, v]) => `${k}=${v}`);
  if (!input.uidSwitch) return { cmd: "/usr/bin/env", args: ["-i", ...envArgs, ...argv] };
  return {
    cmd: "/usr/bin/setpriv",
    args: [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all", "--", "/usr/bin/env", "-i", ...envArgs, ...argv],
  };
}

function launch(uid, argv, { env = {}, cwd, stdin } = {}) {
  const { cmd, args } = asUser(uid, argv, env);
  const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const logs = { out: "", err: "" };
  const cap = (k) => (d) => {
    if (logs[k].length < 64_000) logs[k] += d.toString("utf8");
  };
  child.stdout.on("data", cap("out"));
  child.stderr.on("data", cap("err"));
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin ?? "");
  const exited = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
  return { child, logs, exited };
}

function kill(p) {
  if (!p) return;
  try {
    process.kill(-p.child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

async function waitForPort(port, proc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  proc.exited.then((e) => (exited = e));
  while (Date.now() < deadline) {
    if (exited) return { ok: false, reason: `process exited (${exited.code ?? exited.signal}) before listening` };
    const ok = await new Promise((r) => {
      const s = net.connect({ port, host: "127.0.0.1" }, () => {
        s.destroy();
        r(true);
      });
      s.on("error", () => r(false));
    });
    if (ok) return { ok: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: false, reason: `not listening on ${port} after ${timeoutMs}ms` };
}

// Per-run child auth: a fresh Ed25519 key; the child gets only the public JWK (same
// contract the host publisher configures on Manufact). The client also receives
// deliberately invalid tokens that the child must reject.
const b64u = (b) => Buffer.from(b).toString("base64url");
function mint(privateKey, claims) {
  const input = `${b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT" }))}.${b64u(JSON.stringify(claims))}`;
  return `${input}.${b64u(sign(null, Buffer.from(input), privateKey))}`;
}
const auth = input.auth ? (() => {
  const kp = generateKeyPairSync("ed25519");
  const foreign = generateKeyPairSync("ed25519");
  const issuer = "procmem-validation";
  const audience = input.auth.audience;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: audience, sub: "validation-harness", tenant: "validation", scope: "integration:call", iat: now, nbf: now - 5, exp: now + 1800, jti: randomUUID() };
  return {
    env: { CHILD_AUTH_PUBLIC_JWK: JSON.stringify(kp.publicKey.export({ format: "jwk" })), CHILD_AUTH_ISSUER: issuer, CHILD_AUTH_AUDIENCE: audience },
    token: mint(kp.privateKey, claims),
    invalid: {
      foreign_key: mint(foreign.privateKey, claims),
      wrong_audience: mint(kp.privateKey, { ...claims, aud: `${audience}-other` }),
      expired: mint(kp.privateKey, { ...claims, iat: now - 600, exp: now - 60 }),
    },
  };
})() : null;

const tail = (s, n = 3000) => (s.length > n ? s.slice(-n) : s);
const results = [];
let port = 4300;
for (const c of input.cases) {
  const started = Date.now();
  const rec = { id: c.id, suite: c.suite, name: c.name, passed: false, failures: [], protocol: null, steps: [], fixture: null, childLogTail: "", durationMs: 0 };
  let fixture = null;
  let childProc = null;
  try {
    const env = {};
    let fixtureInfo = null;
    if (c.fixture) {
      const fport = port++;
      const fixtureToken = randomBytes(12).toString("hex");
      const adminToken = randomBytes(12).toString("hex");
      fixture = launch(input.harnessUid, [NODE, path.join(input.harnessDir, "fixtures", `${c.fixture.name}.mjs`)], {
        cwd: input.harnessDir,
        stdin: JSON.stringify({ ...c.fixture.config, port: fport, token: fixtureToken, adminToken }),
      });
      const up = await waitForPort(fport, fixture, 10_000);
      if (!up.ok) throw new Error(`fixture ${c.fixture.name}: ${up.reason}; ${tail(fixture.logs.err, 800)}`);
      fixtureInfo = { url: `http://127.0.0.1:${fport}`, token: fixtureToken, adminToken };
    }
    for (const [k, v] of Object.entries(c.env ?? {})) {
      env[k] = String(v).replaceAll("{{fixture.url}}", fixtureInfo?.url ?? "").replaceAll("{{fixture.token}}", fixtureInfo?.token ?? "");
    }
    const cport = port++;
    env.PORT = String(cport);
    env.HOST = "127.0.0.1";
    env.NODE_ENV = "production";
    if (auth) Object.assign(env, auth.env);
    childProc = launch(input.agentUid, [...input.startCommand, "--port", String(cport)], { cwd: input.stageDir, env });
    const up = await waitForPort(cport, childProc, 30_000);
    if (!up.ok) throw new Error(`child server: ${up.reason}`);
    const client = launch(input.harnessUid, [NODE, path.join(input.harnessDir, "case-client.mjs")], {
      cwd: input.harnessDir,
      stdin: JSON.stringify({
        url: `http://127.0.0.1:${cport}/mcp`,
        token: auth?.token ?? null,
        invalidTokens: auth && c.checkAuth !== false ? auth.invalid : null,
        checkAuth: Boolean(auth) && c.checkAuth !== false,
        declaredTools: input.declaredTools,
        steps: c.steps,
        fixture: fixtureInfo ? { url: fixtureInfo.url, adminToken: fixtureInfo.adminToken } : null,
        fixtureExpect: c.fixtureExpect ?? [],
      }),
    });
    const timer = setTimeout(() => kill(client), input.caseTimeoutMs ?? 90_000);
    const done = await client.exited;
    clearTimeout(timer);
    const line = client.logs.out.trim().split("\n").pop() ?? "";
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`case client produced no result (exit ${done.code ?? done.signal}): ${tail(client.logs.err, 1500)}`);
    }
    rec.protocol = parsed.protocol;
    rec.steps = parsed.steps;
    rec.fixture = parsed.fixture;
    rec.failures = parsed.failures;
    rec.passed = parsed.failures.length === 0;
  } catch (error) {
    rec.failures.push({ where: "harness", message: String(error?.message ?? error).slice(0, 2000) });
  } finally {
    kill(childProc);
    kill(fixture);
    if (childProc) rec.childLogTail = tail(`${childProc.logs.out}\n${childProc.logs.err}`, 2500);
    rec.durationMs = Date.now() - started;
    results.push(rec);
  }
}
process.stdout.write(`${JSON.stringify({ cases: results, passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length })}\n`);
process.exit(0);
