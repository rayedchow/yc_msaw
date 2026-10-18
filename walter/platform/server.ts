/**
 * The walter platform: serves the UI and its API from real artifacts.
 *
 *   GET  /                              the UI
 *   GET  /api/state                     MCP list, trees, evals and running jobs (built by view.ts)
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
import { buildAndShip, evalsPath, knowledgePath, readJson } from "../pipeline.js";
import { loadState } from "../state.js";
import { uiEvals, uiMcp, type Job, type Usage } from "./view.js";
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

async function apiState() {
  const st = await loadState();
  const mcps = [], evals: Record<string, unknown> = {};
  for (const id of Object.keys(DOMAINS)) {
    const k = await readJson<Knowledge>(knowledgePath(id));
    if (!k) continue;
    const job = [...jobs].reverse().find((j) => j.mcp === id && (j.status === "running" || Date.now() - Date.parse(j.startedAt) < 10 * 60_000)) ?? null;
    mcps.push(uiMcp(id, k, st, await usageOf(id), job));
    const e = uiEvals(id, k, await readJson(evalsPath(id)));
    if (e) evals[id] = e;
  }
  return { mcps, evals, system: st.system?.url ?? null };
}

async function answer(id: string, qIndex: number, option: number): Promise<Job> {
  if (jobs.some((j) => j.mcp === id && j.status === "running")) throw new Error("a build is already running for this MCP");
  const k = await readJson<Knowledge>(knowledgePath(id));
  const q = k?.questions[qIndex];
  if (!k || !q || q.answer) throw new Error("no such open question");
  const choice = q.options[option];
  if (!choice) throw new Error("no such option");
  const job: Job = { id: randomUUID(), mcp: id, kind: "answer", status: "running", steps: [], startedAt: new Date().toISOString() };
  jobs.push(job);
  const log = (text: string) => { job.steps.push({ at: new Date().toISOString(), text }); console.log(`[${id}] ${text}`); };
  (async () => {
    try {
      log(`answer: "${choice}"`);
      const st = await loadState();
      const domain = domainOf(id);
      const bench = makeBench(domain, await domain.fetchData(new SystemClient(st.system!.url!, st.system!.token!)));
      const s = await settle(bench, k, qIndex, choice);
      log(`${s.action} ${s.rule.id}: ${s.note}`);
      const version = (k.version ?? 1) + 1;
      k.rules = k.rules.map((r) => (r.id === s.rule.id ? s.rule : r));
      k.questions[qIndex] = { ...q, answer: choice, answeredAt: new Date().toISOString() };
      k.version = version;
      k.changelog = [...(k.changelog ?? []), { version, note: `${s.rule.id}: ${s.note || s.action}`, at: new Date().toISOString() }];
      await fs.writeFile(knowledgePath(id), JSON.stringify(k, null, 2));
      await buildAndShip(k, { log });
      job.status = "done";
      log(`v${version} live`);
    } catch (e) {
      job.status = "failed";
      job.error = (e as Error).message;
      log(`failed: ${job.error}`);
    }
  })();
  return job;
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
    const m = /^\/api\/mcps\/([a-z0-9-]+)\/answer$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { question, option } = JSON.parse(body || "{}");
      return send(202, await answer(m[1]!, Number(question), Number(option)));
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(400, { error: (e as Error).message });
  }
}).listen(port, () => console.log(`walter on http://localhost:${port}`));
