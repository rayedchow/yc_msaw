/**
 * Phase 4: compile the mined knowledge, deploy the MCP to Manufact (company-owned), wait until the new version is
 * live, then replay past work through the hosted MCP and write .walter/evals/<mcp>.json.
 *
 *   npx tsx walter/scripts/phase4-deploy.ts [knowledge.json] [--no-deploy]
 */
import { promises as fs } from "node:fs";
import type { Knowledge } from "../compile/compile.js";
import { buildAndShip, knowledgePath } from "../pipeline.js";

const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? knowledgePath("sales");
const k = JSON.parse(await fs.readFile(file, "utf8")) as Knowledge;
const out = await buildAndShip(k, { deploy: !process.argv.includes("--no-deploy") });
for (const c of out.cases.filter((c) => !c.ok).slice(0, 10)) console.log("  ✗", c.tool, c.month, c.label, "expected", c.expected, "got", c.got);
