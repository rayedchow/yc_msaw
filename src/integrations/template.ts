import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** templates/integration in this checkout (shipped with the product, read at runtime). */
export const TEMPLATES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates/integration");

async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (abs: string, rel: string) => {
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.set(r, await fs.readFile(path.join(abs, e.name)));
    }
  };
  await walk(dir, "");
  return out;
}

export interface ChildTemplateVars {
  slug: string;
  title: string;
  description: string;
  upstreamName: string;
}

const VAR_VALUE_RE = /^[^\n\r"\\{}`<>]{1,200}$/;

/** Generic child repository scaffold (mcp-use v2 server) with {{vars}} substituted. */
export async function childTemplateFiles(vars: ChildTemplateVars, root = TEMPLATES_ROOT): Promise<Map<string, string>> {
  for (const [k, v] of Object.entries(vars)) {
    if (!VAR_VALUE_RE.test(v)) throw new Error(`Template variable ${k} contains unsupported characters`);
  }
  const files = await readTree(path.join(root, "child"));
  const out = new Map<string, string>();
  for (const [rel, bytes] of files) {
    let text = bytes.toString("utf8");
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
    out.set(rel, text);
  }
  return out;
}

/** Sealed harness files (suite orchestrator, MCP case client, API fixtures) for <layout.harnessDir>. */
export async function harnessFiles(root = TEMPLATES_ROOT): Promise<Map<string, Buffer>> {
  return readTree(path.join(root, "harness"));
}

/** Host-owned helpers the agent uid executes (fsop.mjs) for <layout.toolsDir>. */
export async function toolFiles(root = TEMPLATES_ROOT): Promise<Map<string, Buffer>> {
  return readTree(path.join(root, "tools"));
}

/** Names of host fixtures available to suites (templates/integration/harness/fixtures/<name>.mjs). */
export async function fixtureNames(root = TEMPLATES_ROOT): Promise<string[]> {
  const files = await readTree(path.join(root, "harness", "fixtures"));
  return [...files.keys()].filter((k) => k.endsWith(".mjs")).map((k) => k.slice(0, -4)).sort();
}

/** Overlay files for a template directory (e.g. demo/notify-hub/initial). */
export async function overlayFiles(relDir: string, root = TEMPLATES_ROOT): Promise<Map<string, string>> {
  const files = await readTree(path.join(root, relDir));
  return new Map([...files].map(([k, v]) => [k, v.toString("utf8")]));
}
