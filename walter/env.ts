/** Loads .env (if present) into process.env without overriding, and maps MANUFACT_API_KEY to the CLI's MCP_USE_API_KEY. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve(".env");
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
process.env.MCP_USE_API_KEY ??= process.env.MANUFACT_API_KEY;
