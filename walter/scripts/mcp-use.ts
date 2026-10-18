/** Runs the mcp-use CLI with walter's .env (MANUFACT_API_KEY) and hides emails. npx tsx walter/scripts/mcp-use.ts <args> */
import "../env.js";
import { spawnSync } from "node:child_process";
import path from "node:path";

const bin = path.resolve("node_modules/.bin/mcp-use");
const r = spawnSync(bin, process.argv.slice(2), { encoding: "utf8", env: process.env });
process.stdout.write((r.stdout + r.stderr).replace(/"email":"[^"]*"/g, '"email":"…"'));
process.exit(r.status ?? 1);
