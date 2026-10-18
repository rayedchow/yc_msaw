/** Local platform state (.walter/state.json): deployed URLs, secrets for the demo system, build outputs. Gitignored. */
import { promises as fs } from "node:fs";
import path from "node:path";

export const STATE_DIR = path.resolve(".walter");
const FILE = path.join(STATE_DIR, "state.json");

export interface WalterState {
  system?: { url?: string; mcpUrl?: string; serverId?: string; token?: string; deployedAt?: string };
  walterToken?: string;
  mcps?: Record<string, { url?: string; mcpUrl?: string; serverId?: string; version?: number; hash?: string; webUrl?: string; deployedAt?: string; history?: { version: number; hash: string; at: string }[] }>;
}

export async function loadState(): Promise<WalterState> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as WalterState;
  } catch {
    return {};
  }
}

export async function saveState(s: WalterState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}
