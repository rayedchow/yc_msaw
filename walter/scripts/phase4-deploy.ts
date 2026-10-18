/**
 * Phase 4: compile the mined knowledge, deploy the MCP to Manufact (company-owned), wait until the new version is
 * live, then replay past work through the hosted MCP and write .walter/evals/<mcp>.json.
 *
 *   npx tsx walter/scripts/phase4-deploy.ts [--mcp sales|erp|mail] [knowledge.json] [--no-deploy]
 */
import { promises as fs } from "node:fs";
import type { Knowledge } from "../compile/compile.js";
import { buildAndShip, knowledgePath } from "../pipeline.js";

const i = process.argv.indexOf("--mcp");
const mcp = i > 0 ? process.argv[i + 1]! : "sales";
const file = process.argv.slice(2).find((a, j, all) => !a.startsWith("--") && all[j - 1] !== "--mcp") ?? knowledgePath(mcp);
const k = JSON.parse(await fs.readFile(file, "utf8")) as Knowledge;
const out = await buildAndShip(k, { deploy: !process.argv.includes("--no-deploy") });
for (const c of out.cases.filter((c) => !c.ok).slice(0, 10)) console.log("  ✗", c.tool, c.month, c.label, "expected", c.expected, "got", c.got);
