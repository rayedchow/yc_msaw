/**
 * LOCAL TEST PUBLISHER child entry: imports a staged integration repo's index.ts (mcp-use MCPServer default export)
 * and listens on loopback. Used for host-authored frozen adapters in the matrix (labelled local test transport).
 *   tsx eval/crm/child-main.ts <stagedRepoDir>   (env: PORT, HOST, CHILD_AUTH_*, adapter env)
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
if (!dir) throw new Error("usage: child-main.ts <repoDir>");
process.chdir(dir);
const mod = (await import(pathToFileURL(path.join(dir, "index.ts")).href)) as { default: { listen(port: number, opts?: { host?: string }): Promise<{ url?: string; port?: number } | void> } };
const port = Number(process.env.PORT ?? 0);
const bound = await mod.default.listen(port, { host: process.env.HOST ?? "127.0.0.1" });
process.stdout.write(`CHILD_LISTENING ${JSON.stringify(bound ?? { port })}\n`);
