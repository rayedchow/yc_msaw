import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";
import { rowsOf } from "./store.js";
import { enqueueJiraIssueHint } from "./sweep.js";

/**
 * Nango `forward` webhooks for Jira (provider webhooks relayed by Nango after
 * the donor handler verified the HMAC signature). They are only an
 * accelerant: the issue id they name is queued for a refresh BY ID through the
 * tenant's own grant, so nothing in the body is stored or trusted as data, and
 * the periodic relative-JQL delta still covers every update a lost webhook
 * missed. The tenant comes from the server-side connections table (the
 * connection id + integration the delivery names must map to exactly one
 * active Jira connection), never from the payload.
 */

export interface JiraForwardResult {
  handled: boolean;
  queued: number;
  reason?: string;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Issue id named by a Jira webhook body (issue, comment and attachment events all carry `issue.id`). */
export function jiraWebhookIssueId(body: unknown): string | null {
  const b = rec(body);
  const id = str(rec(b?.issue)?.id) ?? str(rec(b?.attachment)?.issueId) ?? str(rec(rec(b?.comment)?.issue)?.id);
  return id && /^\d{1,20}$/u.test(id) ? id : null;
}

export async function handleJiraForwardWebhook(db: DbExecutor, payload: Record<string, unknown>): Promise<JiraForwardResult> {
  if (str(payload.type)?.toLowerCase() !== "forward") return { handled: false, queued: 0, reason: "not a forward webhook" };
  const from = str(payload.from) ?? str(payload.provider);
  if (from?.toLowerCase() !== "jira") return { handled: false, queued: 0, reason: "not a jira delivery" };
  const connectionId = str(payload.connectionId);
  const providerConfigKey = str(payload.providerConfigKey) ?? "jira";
  if (!connectionId) return { handled: true, queued: 0, reason: "no connection id" };
  const tenants = rowsOf<{ tenant_id: string }>(
    await db.execute(sql`
      SELECT DISTINCT tenant_id FROM connections
      WHERE provider = 'jira' AND status = 'active'
        AND (external_account_id = ${connectionId} OR metadata->>'nangoConnectionId' = ${connectionId})
        AND COALESCE(metadata->>'providerConfigKey', 'jira') = ${providerConfigKey}
    `),
  );
  if (tenants.length !== 1) return { handled: true, queued: 0, reason: tenants.length ? "connection maps to several tenants" : "no active jira connection for this delivery" };
  const issueId = jiraWebhookIssueId(payload.payload);
  if (!issueId) return { handled: true, queued: 0, reason: "no issue id in the forwarded body" };
  return { handled: true, queued: await enqueueJiraIssueHint(db, tenants[0]!.tenant_id, { connectionId, issueId }) };
}
