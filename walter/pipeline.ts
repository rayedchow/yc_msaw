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
import { loadState, saveState, STATE_DIR } from "./state.js";

export const knowledgePath = (mcp: string) => path.join(STATE_DIR, "knowledge", `${mcp}.json`);
export const evalsPath = (mcp: string) => path.join(STATE_DIR, "evals", `${mcp}.json`);
export const ORG = () => process.env.MANUFACT_ORG_SLUG ?? "org-ec5ae13b-z5isn";

export async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, "utf8")) as T; } catch { return null; }
}

export async function buildAndShip(k: Knowledge, opts: { deploy?: boolean; log?: (s: string) => void; note?: string } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const state = await loadState();
  if (!state.system?.url || !state.system.token) throw new Error("GurtAI system is not deployed (phase 1)");
  const name = `gurtai-${k.mcp}`;
  const dir = path.join(STATE_DIR, "projects", name);
  const { hash, tools } = await compile(k, dir, name);
  log(`compiled ${name} v${k.version ?? 1} (${hash}): ${tools.join(", ")}`);
  const admin = state.walterToken ?? randomBytes(18).toString("base64url");
  const env = { GURTAI_URL: state.system.url, GURTAI_TOKEN: state.system.token, WALTER_TOKEN: admin };

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
    const domain = domainOf(k.mcp);
    const data = await domain.fetchData(new SystemClient(state.system.url, state.system.token));
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
