/**
 * Linear provider (lane in src/integrations/linear/lane.ts, port of gigabrain f74c62ca8). Current state per
 * object, tombstoned on remove / archive / trash / absence from a full listing:
 *
 *   sources/linear/<org>/issues/<IDENT>.{json,md}             (moves when an issue changes team/identifier)
 *   sources/linear/<org>/comments/<issueIdent|_>/<commentId>.json
 *   sources/linear/<org>/projects/<slug>-<id8>.json
 *   sources/linear/<org>/cycles/<teamKey>-<number>.json
 */
import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourceProviderModule } from "../../core/types.js";
import { slugify } from "../../../lib/utils.js";
import { LINEAR_FULL_PASS_SECONDS, LINEAR_SYNC_FREQUENCY_SECONDS } from "../../../integrations/linear/lane.js";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const seg = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");

export function linearPaths(org: string, resource: string, objectId: string, payload: Record<string, any>): string[] {
  const base = `sources/linear/${seg(org)}`;
  switch (resource) {
    case "issue": {
      const ident = typeof payload.identifier === "string" ? payload.identifier : objectId;
      return [`${base}/issues/${seg(ident)}.json`, `${base}/issues/${seg(ident)}.md`];
    }
    case "comment":
      return [`${base}/comments/${seg(payload.issue?.identifier ?? "_")}/${seg(objectId)}.json`];
    case "project":
      return [`${base}/projects/${slugify(String(payload.name ?? "project")).slice(0, 60)}-${seg(objectId.slice(0, 8))}.json`];
    default:
      return [`${base}/cycles/${seg(String(payload.team?.key ?? "team"))}-${seg(String(payload.number ?? objectId))}.json`];
  }
}

export function renderLinearIssue(issue: Record<string, any>): string {
  const labels = (issue.labels?.nodes ?? []).map((l: any) => l.name).join(", ");
  const rows: Array<[string, unknown]> = [
    ["Status", issue.state?.name], ["Priority", issue.priorityLabel], ["Assignee", issue.assignee?.name ?? issue.assignee?.email], ["Creator", issue.creator?.name ?? issue.creator?.email],
    ["Team", issue.team ? `${issue.team.name} (${issue.team.key})` : null], ["Project", issue.project?.name], ["Labels", labels || null], ["Parent", issue.parent?.identifier],
    ["Created", issue.createdAt], ["Updated", issue.updatedAt], ["URL", issue.url],
  ];
  const meta = rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `- ${k}: ${String(v)}`).join("\n");
  const children = (issue.children?.nodes ?? []).map((c: any) => `- ${c.identifier} ${c.title}${c.state?.name ? ` (${c.state.name})` : ""}`).join("\n");
  const relations = (issue.relations?.nodes ?? []).map((r: any) => `- ${r.type}: ${r.relatedIssue?.identifier} ${r.relatedIssue?.title ?? ""}`).join("\n");
  return [`# ${issue.identifier ?? ""} ${issue.title ?? ""}`.trim(), "", meta, "", "## Description", "", issue.description?.trim() || "_No description._",
    ...(children ? ["", "## Sub-issues", "", children] : []), ...(relations ? ["", "## Relations", "", relations] : []), "", "Comments: ../comments/" + (issue.identifier ?? "_") + "/"].join("\n") + "\n";
}

export const linearObjectsExport: ExtraTableExport = {
  table: "linear_objects",
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
    const [r] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
      SELECT o.resource, o.object_id, o.payload::text AS payload_text, o.provider_updated_at, o.observed_at, o.deleted, o.deleted_reason,
             COALESCE(c.organization_key, o.organization_id) AS org
      FROM linear_objects o JOIN linear_connections c ON c.id = o.connection_id
      WHERE o.tenant_id = ${ctx.tenantId} AND o.id = ${key}
    `));
    if (!r) return prev.map((path) => ({ op: "delete" as const, path, deletedAt: j.enqueuedAt, reason: "object_row_deleted", capturedAt: j.enqueuedAt }));
    const payload = JSON.parse(String(r.payload_text)) as Record<string, any>;
    const paths = linearPaths(String(r.org), String(r.resource), String(r.object_id), payload);
    const capturedAt = new Date(String(r.observed_at)).toISOString();
    const updated = r.provider_updated_at ? new Date(String(r.provider_updated_at)).toISOString() : null;
    const provenance = { runtime: "linear source lane", port: "askshepherd/gigabrain@f74c62ca8db7911c819c174bab9a2a34a2a52fc1 brain/src/linear", externalId: String(r.object_id), resource: String(r.resource) };
    if (r.deleted) return paths.map((path) => ({ op: "delete" as const, path, deletedAt: updated ?? capturedAt, reason: String(r.deleted_reason ?? "deleted"), capturedAt, provenance }));
    return paths.map((path) => ({
      op: "put" as const, path, kind: path.endsWith(".md") ? "projection" as const : "raw" as const, contentType: path.endsWith(".md") ? "text/markdown" : "application/json",
      content: Buffer.from(path.endsWith(".md") ? renderLinearIssue(payload) : String(r.payload_text), "utf8"), sourceUpdatedAt: updated, capturedAt, provenance,
    }));
  },
};

export async function linearCoverage(ctx: ExportContext, now = new Date()): Promise<CoverageReport[]> {
  const conns = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`SELECT id, organization_id, organization_key, status, status_reason, last_webhook_at FROM linear_connections WHERE tenant_id = ${ctx.tenantId}`));
  if (!conns.length) return [{ provider: "linear", scope: "connections", state: "pending", reason: "no Linear connection" }];
  const out: CoverageReport[] = [];
  for (const c of conns) {
    const scope = `org:${c.organization_key ?? c.organization_id}`;
    if (c.status !== "active") {
      out.push({ provider: "linear", scope, state: "blocked", reason: `connection ${c.status}${c.status_reason ? `: ${c.status_reason}` : ""}` });
      continue;
    }
    const cursors = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`SELECT * FROM linear_cursors WHERE connection_id = ${String(c.id)}`));
    for (const res of ["issue", "comment", "project", "cycle"]) {
      const cur = cursors.find((x) => x.resource === res);
      const full = cur?.last_full_at ? now.getTime() - Date.parse(String(cur.last_full_at)) <= 2 * LINEAR_FULL_PASS_SECONDS * 1000 : false;
      const fresh = cur?.last_success_at ? now.getTime() - Date.parse(String(cur.last_success_at)) <= 3 * LINEAR_SYNC_FREQUENCY_SECONDS * 1000 : false;
      const state: CoverageReport["state"] = !cur ? "pending" : cur.status === "blocked" ? "blocked" : full && fresh && !cur.last_error ? "complete" : "partial";
      out.push({
        provider: "linear", scope: `${scope}:${res}s`, state,
        reason: state === "complete"
          ? `current state of every ${res} (incl. archived) from a full listing within ${LINEAR_FULL_PASS_SECONDS / 3600 * 2} h plus deltas; edit history = observed snapshots only`
          : String(cur?.last_error ?? (cur ? "full listing in progress" : "not synced yet")),
        ...(cur?.last_success_at ? { lastSuccessAt: new Date(String(cur.last_success_at)).toISOString() } : {}),
      });
    }
    out.push({ provider: "linear", scope: `${scope}:webhook`, state: c.last_webhook_at ? "complete" : "partial", reason: c.last_webhook_at ? `signed deliveries received (last ${new Date(String(c.last_webhook_at)).toISOString()})` : "no signed webhook delivery yet: changes arrive by 5-minute polling" });
  }
  return out;
}

export const linearProvider: SourceProviderModule = {
  id: "linear",
  eventSources: ["linear"],
  mirrorRoots: [],
  connectionProviders: ["linear"],
  extraTables: [linearObjectsExport],
  coverage: (ctx) => linearCoverage(ctx),
};
