// Builds the standalone trace page: dist/app.js (esbuild) and dist/trace.css
// (the AEye stylesheets in cascade order, then the local layer).
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const css = [
  "src/styles/aeye-globals.css",
  "src/aeye/web/components/agent-activity/agent-activity.css",
  "src/aeye/web/components/build-trace.css",
  "src/aeye/web/components/workspace/live-agent-files.css",
  "src/aeye/web/components/workspace/workspace-panel-modes.css",
  "src/styles/local.css",
];
await mkdir(path.join(root, "dist"), { recursive: true });
await build({
  entryPoints: [path.join(root, "src/main.tsx")],
  outfile: path.join(root, "dist/app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
const parts = await Promise.all(css.map(async (file) => `/* ${file} */\n${await readFile(path.join(root, file), "utf8")}`));
await writeFile(path.join(root, "dist/trace.css"), parts.join("\n"));
console.log("built dist/app.js and dist/trace.css");
