/**
 * The build pipeline shared by the CLI phases and the platform: compile knowledge → deploy to Manufact → wait for the
 * new version to be live → replay history through the hosted MCP → write evals.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compile, type Knowledge } from "./compile/compile.js";
import { deployToManufact, isLinked, runLocal, waitForDeployment } from "./deploy/project.js";
import { connectMcp } from "./mcp-client.js";
import { SystemClient } from "./mine/data.js";
import { summarizeReplays } from "./evals/replay.js";
import { domainOf } from "./domains/index.js";
import { loadState, saveState, STATE_DIR, type WalterState } from "./state.js";
import type { Domain } from "./domains/types.js";
import { aggregateReplay, mine } from "./mine/miner.js";
import { backtestRule } from "./mine/backtest.js";
import { MODELS, usage } from "./llm.js";

export const knowledgePath = (mcp: string) => path.join(STATE_DIR, "knowledge", `${mcp}.json`);
export const evalsPath = (mcp: string) => path.join(STATE_DIR, "evals", `${mcp}.json`);
export const ORG = () => process.env.MANUFACT_ORG_SLUG ?? "org-ec5ae13b-z5isn";

export async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, "utf8")) as T; } catch { return null; }
}

/** The system an MCP talks to: its own connection if one was added from the UI, else the GurtAI systems host. */
export function connectionFor(state: WalterState, id: string): { url: string; token: string } {
  const c = state.connections?.[id];
  if (c) return { url: c.url, token: c.token };
  if (!state.system?.url || !state.system.token) throw new Error("GurtAI system is not deployed (phase 1)");
  return { url: state.system.url, token: state.system.token };
}

/** Mine one system with the Fireworks miner and write .walter/knowledge/<id>.json. */
export async function mineToKnowledge(domain: Domain, id: string, opts: { name?: string; client: SystemClient; model?: string; maxSteps?: number; log?: (s: string) => void; onStep?: (step: number) => void }) {
  const started = Date.now();
  const r = await mine(domain, opts.client, { model: opts.model ?? MODELS.kimi, maxSteps: opts.maxSteps ?? 60, log: (s) => { opts.log?.(s); const n = /^step (\d+)/.exec(s); if (n) opts.onStep?.(Number(n[1])); } });
  const all = r.rules;
  const results = all.map((rule) => ({ rule, result: backtestRule(r.bench, rule, all) }));
  const replay = aggregateReplay(r.bench, all);
  // Short, stable ids for people and agents (prefix + n); the miner's own id is kept as the slug.
  const prefix = { sales: "R", erp: "F", mail: "M" }[domain.id] ?? "R";
  const ids = new Map(results.map(({ rule }, i) => [rule.id, `${prefix}${i + 1}`]));
  const k = {
    mcp: id, pack: domain.id, ...(opts.name ? { name: opts.name } : {}), version: 1, system: opts.client.baseUrl, model: opts.model ?? MODELS.kimi, minedAt: new Date().toISOString(), steps: r.steps, seconds: Math.round((Date.now() - started) / 1000), usage: { ...usage },
    summary: r.summary,
    rules: results.map(({ rule, result }) => ({ ...rule, id: ids.get(rule.id)!, slug: rule.id, short: (rule.short ?? "").slice(0, 22), train: result.train, heldOut: result.heldOut, months: result.months, change: result.change ?? null, counterexamples: result.counterexamples.slice(0, 10), error: result.error ?? null, applies: result.applies, fallback: domain.kinds[rule.kind]?.combine !== "set" && result.applies.n === result.applies.of })),
    questions: r.questions.map((q) => ({ ...q, rule_id: ids.get(q.rule_id) ?? q.rule_id })),
    replay,
  };
  await fs.mkdir(path.dirname(knowledgePath(id)), { recursive: true });
  await fs.writeFile(knowledgePath(id), JSON.stringify(k, null, 2));
  await fs.writeFile(knowledgePath(id).replace(/\.json$/, ".transcript.json"), JSON.stringify(r.transcript, null, 2));
  return { knowledge: k as unknown as Knowledge, steps: r.steps };
}

export async function buildAndShip(k: Knowledge, opts: { deploy?: boolean; log?: (s: string) => void; note?: string } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const state = await loadState();
  const conn = connectionFor(state, k.mcp);
  const name = `gurtai-${k.mcp}`;
  const dir = path.join(STATE_DIR, "projects", name);
  const { hash, tools } = await compile(k, dir, name);
  log(`compiled ${name} v${k.version ?? 1} (${hash}): ${tools.join(", ")}`);
  const admin = state.walterToken ?? randomBytes(18).toString("base64url");
  const env = { GURTAI_URL: conn.url, GURTAI_TOKEN: conn.token, WALTER_TOKEN: admin };

  let mcpUrl: string, stop = () => {};
  if (opts.deploy === false) {
    const local = await runLocal(dir, env, 4431);
    mcpUrl = local.url + "/mcp"; stop = local.stop;
  } else {
    const t0 = Date.now();
    log("deploying to Manufact");
    const r = await deployToManufact(dir, name, env, { isNew: !isLinked(dir), org: ORG() });
    if (!r.ok) throw new Error(`deploy failed: ${r.log.slice(-800)}`);
    log(`deployment ${(r.raw as any).deploymentId} accepted, waiting for v${k.version ?? 1} to go live`);
    const live = await waitForDeployment(String((r.raw as any).serverId), { since: t0, expectHash: hash });
    if (live.status !== "running" || !live.mcpUrl) throw new Error(`deployment ${live.status}: ${JSON.stringify(live.raw?.failureMeta ?? live.raw?.error ?? null)}`);
    log(`live at ${live.mcpUrl} after ${Math.round((Date.now() - t0) / 1000)}s`);
    mcpUrl = live.mcpUrl;
    const fresh = await loadState();
    const prev = fresh.mcps?.[k.mcp];
    fresh.mcps = { ...(fresh.mcps ?? {}), [k.mcp]: { url: live.url, mcpUrl, serverId: (r.raw as any).serverId, webUrl: (r.raw as any).webUrl, version: k.version ?? 1, hash, deployedAt: new Date().toISOString(),
      history: [...(prev?.history ?? []).filter((h) => h.hash !== hash), { version: k.version ?? 1, hash, at: new Date().toISOString() }] } };
    await saveState({ ...fresh, walterToken: admin });
  }

  try {
    log("replaying history through the MCP");
    const mcp = await connectMcp(mcpUrl, {}, "walter-evals");
    const domain = domainOf(k.pack ?? k.mcp);
    const data = await domain.fetchData(new SystemClient(conn.url, conn.token));
    const t0 = Date.now();
    const cases = await domain.replay(mcp, data);
    const summary = summarizeReplays(cases);
    await mcp.close();
    const out = { mcp: k.mcp, version: k.version ?? 1, hash, mcpUrl, ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), summary, cases };
    await fs.mkdir(path.dirname(evalsPath(k.mcp)), { recursive: true });
    await fs.writeFile(evalsPath(k.mcp), JSON.stringify(out, null, 2));
    for (const s of summary) log(`evals ${s.tool}: ${s.ok}/${s.n} (learned ${s.learned.ok}/${s.learned.n}, held-out ${s.heldOut.ok}/${s.heldOut.n})`);
    return out;
  } finally {
    stop();
  }
}
