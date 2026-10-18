/**
 * The walter platform: serves the UI and its API from real artifacts.
 *
 *   GET  /                              the UI
 *   GET  /api/state                     MCP list, trees, evals and running jobs (built by view.ts)
 *   GET  /api/packs                     system types a new MCP can be built from
 *   POST /api/mcps                      { pack, name, url, token, notes } → test the connection, then mine, compile,
 *                                       deploy to Manufact and run evals as a job
 *   POST /api/mcps/:id/answer           { question, option } → settle the rule, rebuild, redeploy to Manufact, re-run evals
 *
 *   npx tsx walter/platform/server.ts [--port 4500]
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Knowledge } from "../compile/compile.js";
import { SystemClient } from "../mine/data.js";
import { makeBench } from "../mine/backtest.js";
import { settle } from "../mine/settle.js";
import { buildAndShip, connectionFor, evalsPath, knowledgePath, mineToKnowledge, readJson } from "../pipeline.js";
import { loadState, saveState, STATE_DIR } from "../state.js";
import { uiEvals, uiMcp, uiPacks, type Job, type Usage } from "./view.js";
import { DOMAINS, domainOf } from "../domains/index.js";

const UI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../mock-ui/index.html");
const jobs: Job[] = [];
const usageCache = new Map<string, { at: number; data: Usage | null }>();

async function usageOf(id: string): Promise<Usage | null> {
  const st = await loadState();
  const url = st.mcps?.[id]?.url;
  if (!url || !st.walterToken) return null;
  const c = usageCache.get(id);
  if (c && Date.now() - c.at < 10_000) return c.data;
  const data = await fetch(url + "/walter/usage", { headers: { authorization: `Bearer ${st.walterToken}` }, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? (r.json() as Promise<Usage>) : null), () => null);
  usageCache.set(id, { at: Date.now(), data: data ?? c?.data ?? null });
  return data ?? c?.data ?? null;
}

/** Every MCP walter knows: the built-in packs that have been mined, plus MCPs added from the UI (even mid-build). */
async function mcpIds(): Promise<string[]> {
  const st = await loadState();
  const files = await fs.readdir(path.join(STATE_DIR, "knowledge")).catch(() => [] as string[]);
  const mined = files.filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => f.slice(0, -5));
  const added = Object.entries(st.connections ?? {}).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt)).map(([id]) => id);
  return [...new Set([...Object.keys(DOMAINS).filter((id) => mined.includes(id)), ...mined, ...added])];
}

const jobFor = (id: string) => [...jobs].reverse().find((j) => j.mcp === id && (j.status === "running" || Date.now() - Date.parse(j.startedAt) < 10 * 60_000)) ?? null;

async function apiState() {
  const st = await loadState();
  const mcps = [], evals: Record<string, unknown> = {};
  for (const id of await mcpIds()) {
    const k = await readJson<Knowledge>(knowledgePath(id));
    if (!k && !st.connections?.[id]) continue;
    mcps.push(uiMcp(id, k, st, await usageOf(id), jobFor(id)));
    const e = k ? uiEvals(id, k, await readJson(evalsPath(id))) : null;
    if (e) evals[id] = e;
  }
  return { mcps, evals, system: st.system?.url ?? null };
}

function startJob(id: string, kind: string, work: (log: (s: string) => void, job: Job) => Promise<void>): Job {
  if (jobs.some((j) => j.mcp === id && j.status === "running")) throw new Error("a build is already running for this MCP");
  const job: Job = { id: randomUUID(), mcp: id, kind, status: "running", steps: [], startedAt: new Date().toISOString(), progress: 2 };
  jobs.push(job);
  const log = (text: string) => { job.steps.push({ at: new Date().toISOString(), text }); console.log(`[${id}] ${text}`); };
  (async () => {
    try {
      await work(log, job);
      job.status = "done";
      job.progress = 100;
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message;
      log(`failed: ${job.error}`);
    }
  })();
  return job;
}

/** Deploy steps move the progress bar after mining: compile → deploy → live → evals. */
function shipLog(log: (s: string) => void, job: Job) {
  return (s: string) => {
    log(s);
    job.progress = /^compiled/.test(s) ? 78 : /^deploying/.test(s) ? 82 : /accepted/.test(s) ? 86 : /^live at/.test(s) ? 92 : /^replaying/.test(s) ? 95 : job.progress;
  };
}

async function answer(id: string, qIndex: number, option: number): Promise<Job> {
  const k = await readJson<Knowledge>(knowledgePath(id));
  const q = k?.questions[qIndex];
  if (!k || !q || q.answer) throw new Error("no such open question");
  const choice = q.options[option];
  if (!choice) throw new Error("no such option");
  return startJob(id, "answer", async (log, job) => {
    log(`answer: "${choice}"`);
    job.progress = 20;
    const conn = connectionFor(await loadState(), id);
    const domain = domainOf(k.pack ?? id);
    const bench = makeBench(domain, await domain.fetchData(new SystemClient(conn.url, conn.token)));
    const s = await settle(bench, k, qIndex, choice);
    log(`${s.action} ${s.rule.id}: ${s.note}`);
    const version = (k.version ?? 1) + 1;
    k.rules = k.rules.map((r) => (r.id === s.rule.id ? s.rule : r));
    k.questions[qIndex] = { ...q, answer: choice, answeredAt: new Date().toISOString() };
    k.version = version;
    k.changelog = [...(k.changelog ?? []), { version, note: `${s.rule.id}: ${s.note || s.action}`, at: new Date().toISOString() }];
    await fs.writeFile(knowledgePath(id), JSON.stringify(k, null, 2));
    await buildAndShip(k, { log: shipLog(log, job) });
    log(`v${version} live`);
  });
}

const slug = (s: string) => s.toLowerCase().replace(/^gurtai\s+/, "").replace(/\bmcp\b/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** A new MCP from the UI: check the connection first, then mine → compile → deploy → evals in the background. */
async function create(body: { pack?: string; name?: string; url?: string; token?: string; notes?: string }): Promise<{ id: string; job: Job }> {
  const domain = domainOf(String(body.pack ?? ""));
  const name = String(body.name ?? "").trim();
  if (name.length < 3) throw new Error("give the MCP a name");
  const st = await loadState();
  const id = slug(name) || domain.id;
  const taken = new Set(await mcpIds());
  if (taken.has(id) || DOMAINS[id]) throw new Error(`an MCP called "${id}" already exists; pick another name`);
  let url = String(body.url ?? "").trim().replace(/\/+$/, "");
  let token = String(body.token ?? "").trim();
  if (!url && st.system?.url) url = st.system.url;
  if (!/^https?:\/\//.test(url)) throw new Error("the system URL must start with http:// or https://");
  if (!token && st.system?.url && url === st.system.url.replace(/\/+$/, "")) token = st.system.token ?? "";
  if (!token) throw new Error("this system needs an API token");
  // Fail fast on a bad URL or token, before any mining starts.
  const client = new SystemClient(url, token);
  try {
    await Promise.race([domain.fetchData(client), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 60s")), 60_000))]);
  } catch (e) {
    throw new Error(`could not read ${domain.systems[0]} at ${url}: ${(e as Error).message.slice(0, 200)}`);
  }
  st.connections = { ...(st.connections ?? {}), [id]: { pack: domain.id, name, url, token, notes: String(body.notes ?? "").slice(0, 20_000), createdAt: new Date().toISOString() } };
  await saveState(st);
  const job = startJob(id, "create", async (log, job) => {
    log(`connected to ${domain.systems[0]}; mining its history with Kimi`);
    job.progress = 5;
    let rules = 0;
    const { knowledge } = await mineToKnowledge(domain, id, {
      name, client,
      onStep: (n) => { job.progress = Math.min(75, 5 + Math.round((n / 60) * 70)); },
      log: (s) => {
        if (/save_rule/.test(s)) log(`rule ${++rules} saved`);
        else if (/ask_question/.test(s)) log("asked a question history can't settle");
      },
    });
    log(`mined ${knowledge.rules.length} rules and ${knowledge.questions.length} question${knowledge.questions.length === 1 ? "" : "s"}`);
    await buildAndShip(knowledge, { log: shipLog(log, job) });
    log("live");
  });
  return { id, job };
}

async function readBody(req: http.IncomingMessage) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 4500;
http.createServer(async (req, res) => {
  const send = (status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (req.method === "OPTIONS") return send(204, "", "text/plain");
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(200, await fs.readFile(UI, "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/state") return send(200, await apiState());
    if (req.method === "GET" && url.pathname === "/api/packs") return send(200, { packs: uiPacks((await loadState()).system?.url ?? null) });
    if (req.method === "POST" && url.pathname === "/api/mcps") return send(202, await create(await readBody(req)));
    const m = /^\/api\/mcps\/([a-z0-9-]+)\/answer$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const { question, option } = await readBody(req);
      return send(202, await answer(m[1]!, Number(question), Number(option)));
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(400, { error: (e as Error).message });
  }
}).listen(port, () => console.log(`walter on http://localhost:${port}`));
