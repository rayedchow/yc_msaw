/**
 * Packages the walter MCP as a self-contained mcp-use project: walter's own sources (it mines, compiles and deploys
 * from inside the server), the fleet snapshot (knowledge, deploy links, no secrets), the MCP App views and prompts.
 * Secrets (Fireworks, Manufact, GurtAI system, WorkOS) are passed as Manufact env vars at deploy time.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TSCONFIG } from "../deploy/project.js";
import { WALTER_DIR } from "../paths.js";
import { loadState, STATE_DIR } from "../state.js";
import { snapshotFleet } from "./fleet.js";

const SOURCES = ["agents", "compile", "control/fleet.ts", "control/server.ts", "deploy/project.ts", "domains", "evals", "integrations", "mine", "env.ts", "llm.ts", "mcp-client.ts", "paths.ts", "pipeline.ts", "state.ts"];

const PACKAGE = JSON.stringify({
  name: "walter", version: "1.0.0", description: "walter: company MCPs that know how your company actually uses its systems", type: "module", private: true, license: "UNLICENSED", engines: { node: ">=22" },
  scripts: { dev: "mcp-use dev", build: "mcp-use build", start: "mcp-use start" },
  dependencies: { "mcp-use": "2.10.0", zod: "4.6.7", "@modelcontextprotocol/client": "2.3.1", react: "19.3.1", "react-dom": "19.3.1" },
  devDependencies: { "@types/node": "24.19.2", "@types/react": "19.3.0", typescript: "5.9.3" },
}, null, 2) + "\n";

const INDEX = `// walter MCP entry. boot.ts runs first so walter's code finds its bundled sources.
import "./src/boot.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Fleet, seedFromSnapshot } from "./src/walter/control/fleet.ts";
import { createWalterServer } from "./src/walter/control/server.ts";

const dir = path.resolve("fleet");
await seedFromSnapshot(dir);
const snapshot = JSON.parse(await fs.readFile(path.join(dir, "fleet.json"), "utf8"));
const auth = process.env.WALTER_AUTH !== "none" && !!process.env.MCP_USE_OAUTH_WORKOS_SUBDOMAIN;

const { hash } = JSON.parse(await fs.readFile(path.join(dir, "build.json"), "utf8"));

export default createWalterServer(new Fleet(snapshot), { auth, hash });
`;

const BOOT = `import path from "node:path";
process.env.WALTER_DIR ??= path.resolve("src/walter");
process.env.WALTER_REPO ??= process.cwd();
`;

async function copyTree(from: string, to: string) {
  const st = await fs.stat(from);
  if (st.isDirectory()) {
    for (const f of await fs.readdir(from)) await copyTree(path.join(from, f), path.join(to, f));
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  let text = await fs.readFile(from, "utf8");
  // bundle-friendly relative imports (fragments and templates are read as text and keep theirs)
  if (from.endsWith(".ts") && !from.endsWith(".fragment.ts") && !from.endsWith(".template.ts")) text = text.replace(/from "(\.{1,2}\/[^"]+)\.js"/g, 'from "$1.ts"');
  await fs.writeFile(to, text);
}

export async function writeWalterProject(dir: string): Promise<{ mcps: number; hash: string }> {
  const link = await fs.readFile(path.join(dir, ".mcp-use/cloud/link.json"), "utf8").catch(() => null);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  if (link) { await fs.mkdir(path.join(dir, ".mcp-use/cloud"), { recursive: true }); await fs.writeFile(path.join(dir, ".mcp-use/cloud/link.json"), link); }
  await fs.writeFile(path.join(dir, "package.json"), PACKAGE);
  const ts = JSON.parse(TSCONFIG);
  ts.compilerOptions.jsx = "react-jsx";
  ts.include = ["index.ts", "src/boot.ts", "src/walter/**/*.ts", "views/**/*"];
  ts.exclude = ["src/walter/**/*.fragment.ts", "src/walter/**/*.template.ts"];
  await fs.writeFile(path.join(dir, "tsconfig.json"), JSON.stringify(ts, null, 2) + "\n");
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules\n.mcp-use/build\n.mcp-use/cache\ndist\n.walter\n");
  await fs.writeFile(path.join(dir, "index.ts"), INDEX);
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src/boot.ts"), BOOT);
  for (const s of SOURCES) await copyTree(path.join(WALTER_DIR, s), path.join(dir, "src/walter", s));
  await copyTree(path.join(WALTER_DIR, "control/views"), path.join(dir, "views"));

  // fleet snapshot: what each company MCP knows, plus what walter needs to rebuild them (no secrets)
  const snapshot = (await snapshotFleet()).filter((m) => m.template);
  const st = await loadState();
  const fleetDir = path.join(dir, "fleet");
  await fs.mkdir(path.join(fleetDir, "knowledge"), { recursive: true });
  await fs.writeFile(path.join(fleetDir, "fleet.json"), JSON.stringify(snapshot, null, 2));
  const links: Record<string, unknown> = {}, mcps: Record<string, unknown> = {};
  for (const m of snapshot) {
    await fs.copyFile(path.join(STATE_DIR, "knowledge", `${m.id}.json`), path.join(fleetDir, "knowledge", `${m.id}.json`));
    const l = await fs.readFile(path.join(STATE_DIR, "projects", `gurtai-${m.id}`, ".mcp-use/cloud/link.json"), "utf8").catch(() => null);
    if (l) links[`gurtai-${m.id}`] = JSON.parse(l);
    mcps[m.id] = st.mcps?.[m.id];
  }
  await fs.writeFile(path.join(fleetDir, "links.json"), JSON.stringify(links, null, 2));
  await fs.writeFile(path.join(fleetDir, "mcps.json"), JSON.stringify(mcps, null, 2));
  // build hash over everything that ships, so a deploy can wait for exactly this build
  const h = createHash("sha256").update(process.env.MCP_USE_OAUTH_WORKOS_SUBDOMAIN ?? "no-auth"); // auth setting is part of the build
  for (const f of await listFiles(dir)) if (!f.includes("/.mcp-use/")) h.update(f).update(await fs.readFile(f));
  const hash = h.digest("hex").slice(0, 12);
  await fs.writeFile(path.join(fleetDir, "build.json"), JSON.stringify({ hash }));
  return { mcps: snapshot.length, hash };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...(await listFiles(p))); } else out.push(p);
  }
  return out.sort();
}
