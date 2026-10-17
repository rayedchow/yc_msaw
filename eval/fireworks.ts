/**
 * Fireworks credential loading and validation for the eval harness.
 *
 * The key is read from .env into process memory only. It is never logged, never written to disk,
 * never put in process.env, and only ever sent to api.fireworks.ai (here and via Pi's runtime key).
 */
import { readFile } from "node:fs/promises";

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export const MODEL_ALIASES: Record<string, string> = {
  kimi: "accounts/fireworks/models/kimi-k3",
  glm: "accounts/fireworks/models/glm-5p3",
  minimax: "accounts/fireworks/models/minimax-m3",
};

export function resolveModelId(nameOrId: string): string {
  return MODEL_ALIASES[nameOrId] ?? nameOrId;
}

export function shortModelName(id: string): string {
  return id.split("/").pop() ?? id;
}

/** Tiny .env parser: KEY=VALUE lines, optional `export`, optional surrounding quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2] ?? "";
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

export async function loadFireworksKey(envPath: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    throw new Error(`Cannot read ${envPath}; put FIREWORKS_API_KEY=... there (mode 0600).`);
  }
  const key = parseDotEnv(text).FIREWORKS_API_KEY;
  if (!key) throw new Error(`FIREWORKS_API_KEY missing from ${envPath}.`);
  return key;
}

export class FireworksAuthError extends Error {
  constructor(readonly status: number) {
    super(
      `Fireworks rejected the API key (HTTP ${status}). Check FIREWORKS_API_KEY in .env ` +
        `(regenerate at https://app.fireworks.ai/settings/users/api-keys). No model calls were made.`,
    );
    this.name = "FireworksAuthError";
  }
}

/**
 * One cheap request (GET /models, not billed) that both validates the key and lists live model ids.
 * Throws FireworksAuthError on 401/403 so callers can abort before any charged call.
 */
export async function validateFireworksKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ modelIds: string[] }> {
  const res = await fetchImpl(`${FIREWORKS_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) throw new FireworksAuthError(res.status);
  if (!res.ok) throw new Error(`Fireworks GET /models failed with HTTP ${res.status}.`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const modelIds = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  return { modelIds };
}

/** Remove anything that looks like a credential from a value destined for a report. */
export function sanitize<T>(value: T, secrets: readonly string[] = []): T {
  const json = JSON.stringify(value, (k, v: unknown) => {
    if (/authorization|api[-_]?key|token|secret|password|cookie/i.test(k) && typeof v === "string") return "[redacted]";
    return v;
  });
  let s = json;
  for (const secret of secrets) if (secret && secret.length >= 8) s = s.split(secret).join("[redacted]");
  s = s.replace(/fw_[A-Za-z0-9]{16,}/g, "[redacted]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [redacted]");
  return JSON.parse(s) as T;
}
