import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { CoverageReport, DbExecutor } from "./types.js";

/**
 * Personal owner scopes (drizzle/10400_personal_owner_scopes.sql).
 *
 * Granola, Zoom, Cursor and WhatsApp/Instagram personal are one person's account. The donor lanes keep exactly one
 * credential, one lane state and one raw-id space per runtime tenant, and the runtime tenant is the whole yc_msaw
 * organization. So two members could not both connect, and rows could not be told apart by owner. Each verified
 * principal therefore gets its own runtime tenant per organization, the *scope tenant*:
 *
 *   segment     = "@u-" + sha256("procmem.personal-owner/v1\n" + tenantNs + "\n" + issuer + "\n" + subject)[0:24]
 *   scopeTenant = tenantNs + "." + segment without "@"
 *
 * - The donor lanes run in the scope tenant unchanged: their tokens, state, catalog, schedules, OAuth state,
 *   webhooks and dedupe keys are isolated per member.
 * - The exporter publishes a scope with its parent's binding, under `sources/<provider>/<segment>/<rest>`.
 * - yc_msaw derives the same segment from the verified principal and serves that subtree to it alone.
 * - The scope id contains ".", so it fails TENANT_RE: no internal route can name it directly, and it can never
 *   equal a yc_msaw tenant namespace. The segment starts with "@", which none of these providers' own path layouts
 *   can produce (`<slug>-meeting-<hash>`, `_raw`, `ca_<hex>`, %-encoded account ids). So no data captured before
 *   scopes existed (the parent tenant, unsegmented paths) can ever sit under a segment.
 * - The owner comes only from the forwarded principal, which yc_msaw verified (internal app middleware).
 */

/** Runtime integration id -> its source directory, for every connect-owned personal integration. */
export const PERSONAL_CONNECT_INTEGRATIONS: Readonly<Record<string, string>> = {
  granola: "granola",
  zoom: "zoom",
  cursor_background_agents: "cursor-agents",
  whatsapp_personal: "whatsapp-personal",
  instagram_personal: "instagram-personal",
};

/** Device lanes whose devices are enrolled into the enrolling member's owner scope (source directory = provider). */
export const PERSONAL_DEVICE_PROVIDERS: readonly string[] = ["imessage", "coding-sessions", "office-audio"];

/** Source directories a scope tenant may publish (plus modules flagged `ownerScoped`, e.g. personal Nango sources). */
export const PERSONAL_SCOPE_DIRS: ReadonlySet<string> = new Set([...Object.values(PERSONAL_CONNECT_INTEGRATIONS), ...PERSONAL_DEVICE_PROVIDERS]);

/** Every directory a scope tenant may publish with this registry's modules. */
export function ownerScopedDirs(modules: ReadonlyArray<{ id: string; ownerScoped?: boolean }>): ReadonlySet<string> {
  return new Set([...PERSONAL_SCOPE_DIRS, ...modules.filter((m) => m.ownerScoped).map((m) => m.id)]);
}

export const SEGMENT_RE = /^@u-[0-9a-f]{24}$/;
export const COVERAGE_SCOPE_PREFIX = "owner:";

export interface OwnerIdentity {
  tenantNs: string;
  issuer: string;
  subject: string;
}

export interface PersonalScope {
  scopeTenantId: string;
  parentTenantId: string;
  segment: string;
}

export function personalSegment(who: OwnerIdentity): string {
  const digest = createHash("sha256").update(`procmem.personal-owner/v1\n${who.tenantNs}\n${who.issuer}\n${who.subject}`).digest("hex");
  return `@u-${digest.slice(0, 24)}`;
}

export function scopeTenantIdOf(parentTenantId: string, segment: string): string {
  return `${parentTenantId}.${segment.slice(1)}`;
}

/** Cheap syntactic test: only scope tenants contain a dot (TENANT_RE has none). */
export function isScopeTenantId(tenantId: string): boolean {
  return tenantId.includes(".");
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

/** Scopes never change once written, so a process caches them. */
const cache = new Map<string, PersonalScope | null>();
const MAX_CACHE = 10_000;

function remember(id: string, v: PersonalScope | null): void {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(id, v);
}

/** The caller's scope (created on first use). The identity is the forwarded, verified principal. */
export async function ensurePersonalScope(db: DbExecutor, who: OwnerIdentity): Promise<PersonalScope> {
  const segment = personalSegment(who);
  const scopeTenantId = scopeTenantIdOf(who.tenantNs, segment);
  await db.execute(sql`
    INSERT INTO source_lane_personal_scopes (scope_tenant_id, parent_tenant_id, segment, owner_issuer, owner_subject)
    VALUES (${scopeTenantId}, ${who.tenantNs}, ${segment}, ${who.issuer}, ${who.subject})
    ON CONFLICT DO NOTHING
  `);
  const row = rows<{ owner_issuer: string; owner_subject: string; parent_tenant_id: string }>(
    await db.execute(sql`SELECT owner_issuer, owner_subject, parent_tenant_id FROM source_lane_personal_scopes WHERE scope_tenant_id = ${scopeTenantId}`),
  )[0];
  // A digest collision with another principal would hand it this member's scope: refuse instead.
  if (!row || row.owner_issuer !== who.issuer || row.owner_subject !== who.subject || row.parent_tenant_id !== who.tenantNs) {
    throw new Error("personal scope belongs to another principal");
  }
  const scope = { scopeTenantId, parentTenantId: who.tenantNs, segment };
  remember(scopeTenantId, scope);
  return scope;
}

/** The caller's scope if it exists (never creates one). */
export async function findPersonalScope(db: DbExecutor, who: OwnerIdentity): Promise<PersonalScope | null> {
  const scope = await personalScopeOf(db, scopeTenantIdOf(who.tenantNs, personalSegment(who)));
  if (!scope) return null;
  const row = rows<{ owner_issuer: string; owner_subject: string }>(
    await db.execute(sql`SELECT owner_issuer, owner_subject FROM source_lane_personal_scopes WHERE scope_tenant_id = ${scope.scopeTenantId}`),
  )[0];
  return row && row.owner_issuer === who.issuer && row.owner_subject === who.subject ? scope : null;
}

/** The scope a runtime tenant id names, or null for an ordinary (organization) tenant. */
export async function personalScopeOf(db: DbExecutor, tenantId: string): Promise<PersonalScope | null> {
  if (!isScopeTenantId(tenantId)) return null;
  if (cache.has(tenantId)) return cache.get(tenantId)!;
  const row = rows<{ parent_tenant_id: string; segment: string }>(
    await db.execute(sql`SELECT parent_tenant_id, segment FROM source_lane_personal_scopes WHERE scope_tenant_id = ${tenantId}`),
  )[0];
  const scope = row ? { scopeTenantId: tenantId, parentTenantId: row.parent_tenant_id, segment: row.segment } : null;
  // Only a found scope is cached: a scope created later by another process must become visible.
  if (scope) remember(tenantId, scope);
  return scope;
}

export async function personalScopesOf(db: DbExecutor, parentTenantId: string): Promise<PersonalScope[]> {
  try {
    return rows<{ scope_tenant_id: string; segment: string }>(
      await db.execute(sql`SELECT scope_tenant_id, segment FROM source_lane_personal_scopes WHERE parent_tenant_id = ${parentTenantId} ORDER BY scope_tenant_id`),
    ).map((r) => ({ scopeTenantId: r.scope_tenant_id, parentTenantId, segment: r.segment }));
  } catch (error) {
    // A schema without migration 10400 (a lane test applying only its own migrations) has no scopes. Every path that
    // creates or serves a scope still needs the table and fails without it.
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

function isUndefinedTable(error: unknown): boolean {
  for (let e: unknown = error, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

/**
 * Scope-local wire path (what the donor lanes and provider mappers produce) -> the published path. Only the
 * scope's personal directories may be published; anything else throws (the exporter dead-letters the row).
 */
export function scopePublicPath(scope: PersonalScope, path: string, dirs: ReadonlySet<string> = PERSONAL_SCOPE_DIRS): string {
  const m = /^sources\/([^/]+)\/(.+)$/.exec(path);
  if (!m || !dirs.has(m[1]!)) throw new Error(`personal scope may not publish ${path.split("/").slice(0, 2).join("/")}`);
  return `sources/${m[1]}/${scope.segment}/${m[2]}`;
}

/** Whether a scope-local wire path is inside one of the scope's publishable directories. */
export function inScopeDirs(path: string, dirs: ReadonlySet<string> = PERSONAL_SCOPE_DIRS): boolean {
  const m = /^sources\/([^/]+)\/./.exec(path);
  return !!m && dirs.has(m[1]!);
}

/** Published path -> scope-local path (null when the path is not inside this scope's segment). */
export function scopeLocalPath(scope: PersonalScope, path: string): string | null {
  const m = /^sources\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
  if (!m || m[2] !== scope.segment) return null;
  return `sources/${m[1]}/${m[3]}`;
}

/**
 * Record that a device binding enrolled now belongs to `scope` (its registry row and data live there). Refused when
 * the binding is already recorded for another scope: a binding id is never re-pointed at another member.
 */
export async function registerPersonalDevice(db: DbExecutor, scope: PersonalScope, provider: string, bindingId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO source_lane_personal_devices (parent_tenant_id, provider, binding_id, scope_tenant_id)
    VALUES (${scope.parentTenantId}, ${provider}, ${bindingId}, ${scope.scopeTenantId})
    ON CONFLICT DO NOTHING
  `);
  const row = rows<{ scope_tenant_id: string }>(
    await db.execute(sql`SELECT scope_tenant_id FROM source_lane_personal_devices WHERE parent_tenant_id = ${scope.parentTenantId} AND provider = ${provider} AND binding_id = ${bindingId}`),
  )[0];
  if (!row || row.scope_tenant_id !== scope.scopeTenantId) throw new Error("device binding is enrolled for another member");
}

const deviceCache = new Map<string, string>();

/**
 * The runtime tenant holding a device binding's registry row and data: its owner scope, or the organization tenant
 * for a device enrolled before owner scopes. `parentTenantId` and `bindingId` come from the verified device key or
 * the service-authenticated internal URL, never from a payload.
 */
export async function deviceDataTenant(db: DbExecutor, parentTenantId: string, provider: string, bindingId: string): Promise<string> {
  const key = `${parentTenantId}\n${provider}\n${bindingId}`;
  const hit = deviceCache.get(key);
  if (hit) return hit;
  const row = rows<{ scope_tenant_id: string }>(
    await db.execute(sql`SELECT scope_tenant_id FROM source_lane_personal_devices WHERE parent_tenant_id = ${parentTenantId} AND provider = ${provider} AND binding_id = ${bindingId}`),
  )[0];
  if (!row) return parentTenantId; // not cached: an enrolment in another process may record it later
  if (deviceCache.size >= MAX_CACHE) deviceCache.delete(deviceCache.keys().next().value!);
  deviceCache.set(key, row.scope_tenant_id);
  return row.scope_tenant_id;
}

/** Tenants whose devices a principal's device list shows: the organization tenant (legacy) and the caller's scope. */
export async function deviceListTenants(db: DbExecutor, who: OwnerIdentity): Promise<string[]> {
  const scope = await findPersonalScope(db, who);
  return scope ? [who.tenantNs, scope.scopeTenantId] : [who.tenantNs];
}

/** yc_msaw accepts at most 500 coverage entries and 256 KiB per heartbeat (src/sources/http.ts StatusReportSchema). */
export const HEARTBEAT_LIMITS = { maxReports: 480, maxBytes: 200 * 1024 };

const STATE_RANK: Record<string, number> = { complete: 0, pending: 1, partial: 2, blocked: 3 };

/**
 * Fit owner-scoped coverage into one heartbeat next to the organization's own reports (kept whole: they carry the
 * collector's health and are sent first). When the members' reports do not fit, each member's reports of a provider
 * collapse into one worst-state summary; summaries that still do not fit are left out, which yc_msaw shows that owner
 * as "unreported", never as complete. A heartbeat over the limit would be refused whole (owner evidence included).
 */
export function boundOwnerCoverage(org: CoverageReport[], scoped: CoverageReport[], limits = HEARTBEAT_LIMITS): CoverageReport[] {
  const size = (r: CoverageReport[]) => Buffer.byteLength(JSON.stringify(r), "utf8");
  const all = [...org, ...scoped];
  if (all.length <= limits.maxReports && size(all) <= limits.maxBytes) return all;
  const groups = new Map<string, CoverageReport[]>();
  for (const r of scoped) {
    const owner = r.scope.slice(0, r.scope.indexOf("/") + 1); // "owner:<segment>/"
    const k = `${owner}\n${r.provider}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = [...org];
  let bytes = size(out);
  for (const [k, rs] of groups) {
    const [owner, provider] = k.split("\n") as [string, string];
    const worst = rs.reduce((a, b) => ((STATE_RANK[b.state] ?? 0) > (STATE_RANK[a.state] ?? 0) ? b : a));
    const summary: CoverageReport = {
      provider,
      scope: `${owner}summary`,
      state: worst.state,
      reason: `${rs.length} coverage report(s) summarized to fit the heartbeat; worst: ${worst.scope.slice(owner.length)}${worst.reason ? ` (${worst.reason.slice(0, 300)})` : ""}`,
      ...(rs.some((r) => r.lastSuccessAt) ? { lastSuccessAt: rs.map((r) => r.lastSuccessAt ?? "").sort().at(-1)! } : {}),
    };
    const add = Buffer.byteLength(JSON.stringify(summary), "utf8") + 1;
    if (out.length + 1 > limits.maxReports || bytes + add > limits.maxBytes) break;
    out.push(summary);
    bytes += add;
  }
  return out;
}

/** Drop the process cache (tests). */
export function resetPersonalScopeCache(): void {
  cache.clear();
  deviceCache.clear();
}
