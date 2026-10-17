/**
 * HOST-ONLY live smoke for the SDK OAuth refresh provider (src/sdk/oauth-refresh.ts).
 *
 * Proves, against an EXISTING approved grant (no new consent, no browser):
 *   1. two provider instances sharing one store, several concurrent getToken() calls each, starting from a forced
 *      expiry, perform exactly ONE real refresh-token grant (rotation) at the issuer;
 *   2. the rotated tokens are persisted, in the mcp-use CLI format with unknown fields preserved, to the CLI token
 *      file and (if it exists) its issuer-qualified alias, before any access token is used;
 *   3. an authenticated MCP tools/list against the parent succeeds with the refreshed access token.
 *
 * Arguments are file paths and URLs only. Tokens are never accepted on argv and never printed; the report holds only
 * statuses, timings, counts and booleans. This performs ONE real rotation of the grant: run it only when no other
 * writer (e.g. the mcp-use CLI) is using the same credential files.
 *
 *   npx tsx scripts/oauth-refresh-smoke.ts \
 *     --tokens <dir>/mcp-use-cli_<name>_tokens \
 *     --alias "<dir>/mcp-use-cli_<name>_tokens_https_3A_2F_2F<issuer-host>" \
 *     --client-info <dir>/mcp-use-cli_<name>_client_info \
 *     --parent-url https://<parent-host>/mcp \
 *     --issuer https://<issuer-host>/oauth2/token
 *
 * Optional: --resource <url> (default: the parent MCP URL), --report <path> (default reports/oauth-sdk-refresh.json),
 * --lock <path> (default .context/oauth-refresh-smoke.lock), --concurrency <n> (default 4 per instance).
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { errorText, originBoundFetch, trustedUrl } from "../src/sdk/live/security.js";
import {
  acquireFileLock,
  OAuthRefreshProvider,
  readSecretFile,
  writeSecretFileAtomic,
  type OAuthRefreshEvent,
  type OAuthTokens,
  type TokenStore,
  type TokenStoreLock,
} from "../src/sdk/oauth-refresh.js";

// ---------------------------------------------------------------------------------------------------------------
// Arguments (paths and URLs only)
// ---------------------------------------------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(a.slice(0, 40))}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${a}`);
    out[a.slice(2)] = v;
    i++;
  }
  const allowed = new Set(["tokens", "alias", "client-info", "parent-url", "issuer", "resource", "report", "lock", "concurrency"]);
  for (const k of Object.keys(out)) if (!allowed.has(k)) throw new Error(`unknown option --${k}`);
  for (const k of ["tokens", "client-info", "parent-url", "issuer"]) if (!out[k]) throw new Error(`--${k} is required`);
  // Refuse anything that looks like a raw credential instead of a path/URL.
  for (const [k, v] of Object.entries(out)) if (/^eyJ|^[A-Za-z0-9_-]{60,}$/.test(v)) throw new Error(`--${k} must be a path or URL, not a credential`);
  return out;
}

const fp = (s: string | undefined) => (s ? createHash("sha256").update(s).digest("hex") : undefined);

// ---------------------------------------------------------------------------------------------------------------
// mcp-use CLI token-file adapter (smoke only; the SDK's own FileTokenStore uses its own format)
// ---------------------------------------------------------------------------------------------------------------

type CliTokens = Record<string, unknown> & { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; token_type?: unknown; expires_in?: unknown };

async function readCli(path: string): Promise<CliTokens> {
  const raw = await readSecretFile(path);
  if (raw === null) throw new Error(`CLI token file not found: ${path}`);
  try {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
    return j as CliTokens;
  } catch {
    throw new Error(`CLI token file is not a JSON object: ${path}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) throw new Error(`refusing symlinked credential file ${path}`);
    return st.isFile();
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * TokenStore over the CLI token file (+ alias). The CLI format has no absolute expiry, so tokens loaded from disk
 * are treated as expired (forces exactly one real refresh) unless this process wrote them. The CLI format cannot
 * hold a quarantine flag, so a quarantine is recorded in a hash-only marker file next to the lock.
 */
class CliTokenStore implements TokenStore {
  #known: { accessFp: string; expiresAt: number; obtainedAt?: number } | undefined;
  constructor(
    readonly primary: string,
    readonly alias: string | undefined,
    readonly lockPath: string,
    readonly quarantinePath: string,
  ) {}

  async load(): Promise<OAuthTokens | null> {
    const j = await readCli(this.primary);
    if (typeof j.access_token !== "string" || typeof j.token_type !== "string") throw new Error("CLI token file lacks access_token/token_type");
    const t: OAuthTokens = { accessToken: j.access_token, tokenType: j.token_type, expiresAt: 0 };
    if (typeof j.refresh_token === "string") t.refreshToken = j.refresh_token;
    if (typeof j.id_token === "string") t.idToken = j.id_token;
    if (typeof j.scope === "string") t.scope = j.scope;
    if (this.#known && this.#known.accessFp === fp(t.accessToken)) {
      t.expiresAt = this.#known.expiresAt;
      if (this.#known.obtainedAt !== undefined) t.obtainedAt = this.#known.obtainedAt;
    }
    const q = await readSecretFile(this.quarantinePath).catch(() => null);
    if (q) {
      try {
        const m = JSON.parse(q) as { code?: string; at?: number; refreshFp?: string };
        if (m.refreshFp && m.refreshFp === fp(t.refreshToken) && typeof m.code === "string" && typeof m.at === "number") t.quarantine = { code: m.code, at: m.at };
      } catch {
        // ignore malformed marker
      }
    }
    return t;
  }

  async save(t: OAuthTokens): Promise<void> {
    if (t.quarantine) {
      await writeSecretFileAtomic(this.quarantinePath, JSON.stringify({ code: t.quarantine.code, at: t.quarantine.at, refreshFp: fp(t.refreshToken) }));
      return;
    }
    const merge = (j: CliTokens): CliTokens => {
      const out: CliTokens = { ...j, access_token: t.accessToken, token_type: t.tokenType };
      if (t.refreshToken) out.refresh_token = t.refreshToken;
      if (t.idToken) out.id_token = t.idToken;
      if (t.obtainedAt !== undefined && t.expiresAt > t.obtainedAt) out.expires_in = Math.round((t.expiresAt - t.obtainedAt) / 1000);
      if (t.scope !== undefined && "scope" in j) out.scope = t.scope;
      return out;
    };
    // Primary first, then the issuer-qualified alias the CLI also reads (only if it already exists).
    await writeSecretFileAtomic(this.primary, JSON.stringify(merge(await readCli(this.primary))));
    if (this.alias && (await exists(this.alias))) await writeSecretFileAtomic(this.alias, JSON.stringify(merge(await readCli(this.alias))));
    this.#known = { accessFp: fp(t.accessToken)!, expiresAt: t.expiresAt, ...(t.obtainedAt !== undefined ? { obtainedAt: t.obtainedAt } : {}) };
    await unlink(this.quarantinePath).catch(() => undefined);
  }

  acquireLock(options: { timeoutMs: number; signal?: AbortSignal }): Promise<TokenStoreLock> {
    return acquireFileLock(this.lockPath, options);
  }
}

// ---------------------------------------------------------------------------------------------------------------

async function resolveTokenEndpoint(issuerArg: string): Promise<string> {
  const u = trustedUrl(issuerArg, {}, "--issuer");
  if (u.pathname !== "/" && u.pathname !== "") return u.toString();
  const metaUrl = new URL("/.well-known/oauth-authorization-server", u);
  const res = await fetch(metaUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`authorization server metadata returned HTTP ${res.status}`);
  const meta = (await res.json()) as { issuer?: string; token_endpoint?: string };
  if (typeof meta.token_endpoint !== "string") throw new Error("metadata has no token_endpoint");
  const te = trustedUrl(meta.token_endpoint, {}, "token_endpoint");
  if (te.origin !== u.origin) throw new Error("metadata token_endpoint is on a different origin than the issuer");
  return te.toString();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const tokensPath = resolve(args.tokens!);
  const aliasPath = args.alias ? resolve(args.alias) : undefined;
  const parentMcp = trustedUrl(args["parent-url"]!, {}, "--parent-url");
  const resource = args.resource ?? parentMcp.toString();
  trustedUrl(resource, {}, "--resource");
  const tokenEndpoint = await resolveTokenEndpoint(args.issuer!);
  const reportPath = resolve(args.report ?? "reports/oauth-sdk-refresh.json");
  const lockPath = resolve(args.lock ?? ".context/oauth-refresh-smoke.lock");
  const quarantinePath = `${lockPath}.quarantine.json`;
  const perInstance = Math.max(1, Math.min(16, Number(args.concurrency ?? 4) || 4));

  const clientInfoRaw = await readSecretFile(resolve(args["client-info"]!));
  if (clientInfoRaw === null) throw new Error("client_info file not found");
  const clientInfo = JSON.parse(clientInfoRaw) as { client_id?: unknown; token_endpoint_auth_method?: unknown; issuer?: unknown };
  if (typeof clientInfo.client_id !== "string" || !clientInfo.client_id) throw new Error("client_info has no client_id");
  if (clientInfo.token_endpoint_auth_method !== "none") throw new Error("client_info is not a public client (token_endpoint_auth_method must be none); this smoke never handles client secrets");
  if (typeof clientInfo.issuer === "string" && new URL(clientInfo.issuer).origin !== new URL(tokenEndpoint).origin) throw new Error("client_info issuer does not match --issuer");
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  const report: Record<string, unknown> = {
    at: new Date().toISOString(),
    parentMcpUrl: parentMcp.toString(),
    tokenEndpoint,
    resource,
    clientAuthMethod: "none",
    aliasConfigured: !!aliasPath,
  };
  const errors: string[] = [];
  const events: OAuthRefreshEvent[] = [];
  // Both provider instances share one store object (it remembers the expiry of tokens it wrote, which the CLI
  // format cannot hold); refreshes are still serialized by the store's lock file.
  const store = new CliTokenStore(tokensPath, aliasPath, lockPath, quarantinePath);
  const mk = () =>
    new OAuthRefreshProvider({
      tokenEndpoint,
      clientId: clientInfo.client_id as string,
      resource,
      store,
      onEvent: (e) => events.push(e),
    });
  const a = mk();
  const b = mk();
  const scrub = (s: string) => b.scrub(a.scrub(s));
  const before = fp(((await readCli(tokensPath)).refresh_token as string | undefined) ?? undefined);

  // 1. Forced refresh (store reports expiresAt 0) with concurrent callers on two instances.
  let token: string | undefined;
  const t0 = Date.now();
  try {
    const settled = await Promise.allSettled([...Array.from({ length: perInstance }, () => a.getToken()), ...Array.from({ length: perInstance }, () => b.getToken())]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    const results = settled.map((r) => (r as PromiseFulfilledResult<string>).value);
    token = results[0];
    const ok = events.find((e) => e.type === "refresh_succeeded");
    report.refresh = {
      ok: true,
      durationMs: Date.now() - t0,
      concurrentCalls: results.length,
      distinctTokens: new Set(results).size,
      networkRefreshes: events.filter((e) => e.type === "refresh_succeeded").length,
      refreshAttempts: events.filter((e) => e.type === "refresh_started").length,
      adoptedFromStore: a.status().adoptedCount + b.status().adoptedCount,
      rotated: ok?.type === "refresh_succeeded" ? ok.rotated : null,
      expiresInSec: ok?.type === "refresh_succeeded" ? Math.round((ok.expiresAt - Date.now()) / 1000) : null,
    };
  } catch (e) {
    errors.push(scrub(errorText(e)));
    report.refresh = { ok: false, durationMs: Date.now() - t0, code: (e as { code?: string }).code ?? "error" };
  }
  report.events = events.map((e) => ({ type: e.type, ...("code" in e ? { code: e.code } : {}), ...("rotated" in e ? { rotated: e.rotated } : {}) }));

  // 2. Persistence in CLI format (fingerprint comparisons only).
  try {
    const primary = await readCli(tokensPath);
    const primaryFp = fp(primary.refresh_token as string | undefined);
    const persisted: Record<string, unknown> = {
      primaryUpdated: token !== undefined && primary.access_token === token,
      primaryRefreshRotated: !!before && primaryFp !== before,
      primaryMode: ((await lstat(tokensPath)).mode & 0o777).toString(8),
      primaryKeys: Object.keys(primary).sort(),
    };
    if (aliasPath && (await exists(aliasPath))) {
      const alias = await readCli(aliasPath);
      persisted.aliasUpdated = token !== undefined && alias.access_token === token && fp(alias.refresh_token as string | undefined) === primaryFp;
      persisted.aliasKeys = Object.keys(alias).sort();
      persisted.aliasMode = ((await lstat(aliasPath)).mode & 0o777).toString(8);
    } else persisted.aliasUpdated = null;
    report.persisted = persisted;
  } catch (e) {
    errors.push(scrub(errorText(e)));
  }

  // 3. Authenticated tools/list against the parent with the provider as the per-request credential.
  if (token) {
    const t1 = Date.now();
    const client = new Client({ name: "procmem-oauth-refresh-smoke", version: "0.1.0" }, { capabilities: {} });
    try {
      const transport = new StreamableHTTPClientTransport(parentMcp, { fetch: originBoundFetch(parentMcp.origin, a.getToken) });
      await client.connect(transport);
      const { tools } = await client.listTools();
      report.toolsList = { ok: true, toolCount: tools.length, durationMs: Date.now() - t1 };
    } catch (e) {
      errors.push(scrub(errorText(e)));
      report.toolsList = { ok: false, durationMs: Date.now() - t1 };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  report.providerStatus = { a: a.status(), b: b.status() };
  report.errors = errors;
  await a.dispose();
  await b.dispose();

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (scrub(json) !== json) throw new Error("refusing to write a report that contains a credential");
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, json);

  const r = report.refresh as { ok?: boolean; networkRefreshes?: number; distinctTokens?: number } | undefined;
  const p = report.persisted as { primaryUpdated?: boolean; aliasUpdated?: boolean | null } | undefined;
  const tl = report.toolsList as { ok?: boolean; toolCount?: number } | undefined;
  const pass = !!r?.ok && r.networkRefreshes === 1 && r.distinctTokens === 1 && !!p?.primaryUpdated && p.aliasUpdated !== false && !!tl?.ok;
  process.stdout.write(
    `oauth refresh smoke: ${pass ? "PASS" : "FAIL"} refresh=${r?.ok ? "ok" : "failed"} networkRefreshes=${r?.networkRefreshes ?? 0} distinctTokens=${r?.distinctTokens ?? 0} ` +
      `primaryUpdated=${p?.primaryUpdated ?? false} aliasUpdated=${p?.aliasUpdated ?? "n/a"} toolsList=${tl?.ok ? `ok(${tl.toolCount})` : "failed"} report=${reportPath}\n`,
  );
  return pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // Configuration errors only (no credential has been loaded into a provider yet, or messages are scrubbed above).
    process.stderr.write(`oauth refresh smoke: ERROR ${errorText(e).replace(/eyJ[A-Za-z0-9._-]+/g, "[REDACTED]").slice(0, 300)}\n`);
    process.exit(2);
  },
);
