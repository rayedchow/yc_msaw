import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { setConnectionStatus } from "../db/connections.js";
import { emitOutboxEvent } from "../outbox/writer.js";
import { disableTaskSchedules } from "../queue/sweeper.js";

type DbExecutor = Pick<typeof db, "execute">;

export type CredentialFailureClass = "permanent" | "transient" | "unknown";

export interface PermanentCredentialFailureInput {
  tenantId: string;
  provider: string;
  taskKinds: string[];
  error: unknown;
}

export function classifyCredentialFailure(err: unknown): CredentialFailureClass {
  const status = statusCode(err);
  const message = errorMessage(err);
  const lower = message.toLowerCase();
  const code = errorCode(err);

  if (status === 429) return "transient";
  // SOURCE-LANE PATCH (legacy Docs durable floor): Google reports per-user and project quota as 403
  // (userRateLimitExceeded, rateLimitExceeded, quotaExceeded, dailyLimitExceeded). That is a rate limit, not a
  // revoked grant: it must not mark the connection errored and disable every Google schedule.
  if ((err as { name?: unknown } | null)?.name === "GoogleRateLimitError") return "transient";
  if (typeof status === "number" && status >= 500 && status <= 599) return "transient";
  if (isNetworkOrTimeout(err, lower)) return "transient";

  if (status === 401 || status === 403) return "permanent";
  if (code === "invalid_grant" || code === "unauthorized_client") return "permanent";
  if (code === "invalid_auth" || code === "token_revoked") return "permanent";
  if (lower.includes("invalid_grant") || lower.includes("unauthorized_client")) return "permanent";
  if (lower.includes("invalid_auth") || lower.includes("token_revoked")) return "permanent";
  if (lower.includes("missing token") || /no .*token found/.test(lower)) return "permanent";
  if (isGranolaRefresh4xx(err, lower, status)) return "permanent";

  return "unknown";
}

export async function handlePermanentCredentialFailure(
  input: PermanentCredentialFailureInput,
  executor: DbExecutor = db,
): Promise<void> {
  const error = sanitizeCredentialErrorMessage(input.error);
  const shouldEmit = await shouldEmitCredentialFailedEvent(input, executor);
  await setConnectionStatus(input.tenantId, input.provider, "error", undefined, executor);
  for (const kind of [...new Set(input.taskKinds)]) {
    await disableTaskSchedules(input.tenantId, kind, executor);
  }
  if (shouldEmit) {
    await emitOutboxEvent({
      tenantId: input.tenantId,
      eventType: "connection.credential_failed",
      payload: { provider: input.provider, error },
      orderingKey: `${input.tenantId}:${input.provider}`,
    }, executor);
  }
}

export function sanitizeCredentialErrorMessage(err: unknown): string {
  return redactSecrets(errorMessage(err)).slice(0, 1000);
}

function statusCode(err: unknown): number | null {
  if (err && typeof err === "object") {
    const value = (err as { status?: unknown; statusCode?: unknown }).status
      ?? (err as { status?: unknown; statusCode?: unknown }).statusCode;
    if (typeof value === "number") return value;
  }
  const match = errorMessage(err).match(/\((\d{3})\)/);
  return match ? Number(match[1]) : null;
}

function errorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const value = (err as { code?: unknown; errorCode?: unknown }).code
    ?? (err as { code?: unknown; errorCode?: unknown }).errorCode;
  return typeof value === "string" ? value.toLowerCase() : null;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isNetworkOrTimeout(err: unknown, lowerMessage: string): boolean {
  const name = errorName(err).toLowerCase();
  return name === "aborterror"
    || name === "timeouterror"
    || lowerMessage.includes("timeout")
    || lowerMessage.includes("timed out")
    || lowerMessage.includes("fetch failed")
    || lowerMessage.includes("network")
    || lowerMessage.includes("econnreset")
    || lowerMessage.includes("econnrefused")
    || lowerMessage.includes("etimedout")
    || lowerMessage.includes("enotfound")
    || lowerMessage.includes("eai_again");
}

function isGranolaRefresh4xx(err: unknown, lowerMessage: string, status: number | null): boolean {
  const name = errorName(err).toLowerCase();
  const isGranolaOauth = name === "granolaoautherror" || lowerMessage.includes("granola oauth failed");
  return isGranolaOauth && typeof status === "number" && status >= 400 && status <= 499;
}

async function shouldEmitCredentialFailedEvent(
  input: Pick<PermanentCredentialFailureInput, "tenantId" | "provider">,
  executor: DbExecutor,
): Promise<boolean> {
  const rows = (await executor.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM connections
      WHERE tenant_id = ${input.tenantId}
        AND provider = ${input.provider}
        AND status <> 'error'
    ) AS should_emit
  `)) as unknown as Array<{ should_emit: boolean }>;
  return rows[0]?.should_emit === true;
}

function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(access_token|refresh_token|id_token|client_secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/"(access_token|refresh_token|id_token|client_secret)"\s*:\s*"[^"]*"/gi, "\"$1\":\"[REDACTED]\"");
}
