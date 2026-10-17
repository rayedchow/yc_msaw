/**
 * Reproduces the stock `mcp-use deploy --no-github` managed-archive selection
 * (@mcp-use/cli deploy.js): skip any path component in its excluded-name set,
 * skip .env*, OS metadata and symlinks, and apply the ROOT .gitignore only.
 * Asserts the server's runtime sources are uploaded and secrets are not.
 *
 *   npx tsx scripts/check-deploy-tree.ts
 *   npx tsx scripts/check-deploy-tree.ts --stage <empty dir>
 *
 * The stock CLI has no deploy-specific ignore file (only the root .gitignore),
 * so `.github/workflows/*` is part of the managed upload. If Manufact's managed
 * repository refuses workflow files, `--stage` writes the exact same selection
 * minus `.github/` (plus the existing server link .mcp-use/cloud/link.json) into
 * a directory that can be deployed with `npx mcp-use deploy <dir> --no-github ...`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";

// Copied from @mcp-use/cli/dist/commands/deploy.js (Te) — keep in sync when upgrading the CLI.
const EXCLUDED = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".vercel", ".cache", ".parcel-cache", ".pytest_cache", ".ruff_cache", ".mypy_cache", "__pycache__", ".venv", "venv", "coverage", ".nyc_output", ".output", "out", "target", ".mcp-use"]);
const OS_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const root = process.cwd();
const ig = ignore().add(await fs.readFile(path.join(root, ".gitignore"), "utf8").catch(() => ""));

const included: string[] = [];
async function walk(rel: string): Promise<void> {
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (EXCLUDED.has(e.name) || e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (ig.ignores(`${p}/`)) continue;
      await walk(p);
    } else if (e.isFile()) {
      if (OS_FILES.has(e.name) || e.name.startsWith(".env") || ig.ignores(p)) continue;
      included.push(p);
    }
  }
}
await walk("");

const set = new Set(included);
const mustInclude = ["index.ts", "package.json", "package-lock.json", "tsconfig.json", "src/app.ts", "src/server.ts", "src/daily/builder.ts", "src/harness/index.ts", "src/harness/orchestrator.ts", "src/store/modal-objects.ts", "src/sandbox/modal.ts", "src/customer/index.ts", "src/auth/index.ts", "src/traces/index.ts"];
const missing = mustInclude.filter((f) => !set.has(f));
const leaked = included.filter((f) => /(^|\/)\.env(\.|$)/.test(f) || f.startsWith(".context/") || f.startsWith(".data/") || /\.(pem|key)$/.test(f));
// Every relative import under src/ must resolve to an uploaded file.
const unresolved: string[] = [];
for (const f of included.filter((f) => (f.startsWith("src/") || f === "index.ts") && f.endsWith(".ts"))) {
  const text = await fs.readFile(path.join(root, f), "utf8");
  for (const m of text.matchAll(/(?:from\s+|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]!)).replace(/\.js$/, ".ts");
    if (!set.has(target) && !set.has(`${target}/index.ts`)) unresolved.push(`${f} -> ${m[1]}`);
  }
}
const workflowFiles = included.filter((f) => f.startsWith(".github/"));
const report = { files: included.length, missing, leaked, unresolved, workflowFilesUploaded: workflowFiles };
console.log(JSON.stringify(report, null, 2));
if (missing.length || leaked.length || unresolved.length) process.exit(1);

const stageIndex = process.argv.indexOf("--stage");
if (stageIndex > 0) {
  const stage = path.resolve(process.argv[stageIndex + 1] ?? "");
  if (!process.argv[stageIndex + 1] || stage === root || stage.startsWith(`${root}${path.sep}`)) {
    throw new Error("--stage needs a directory outside the project");
  }
  const existing = await fs.readdir(stage).catch(() => [] as string[]);
  if (existing.length) throw new Error(`--stage directory ${stage} must be empty`);
  for (const f of included.filter((f) => !f.startsWith(".github/"))) {
    await fs.mkdir(path.dirname(path.join(stage, f)), { recursive: true });
    await fs.copyFile(path.join(root, f), path.join(stage, f));
  }
  const link = path.join(root, ".mcp-use", "cloud", "link.json");
  const hasLink = await fs.access(link).then(() => true, () => false);
  if (hasLink) {
    await fs.mkdir(path.join(stage, ".mcp-use", "cloud"), { recursive: true });
    await fs.copyFile(link, path.join(stage, ".mcp-use", "cloud", "link.json"));
  }
  console.log(JSON.stringify({ staged: stage, files: included.length - workflowFiles.length, excluded: workflowFiles, serverLinkCopied: hasLink }, null, 2));
}
