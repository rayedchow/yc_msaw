import { sql } from "drizzle-orm";
import type { DeviceContext } from "./devices.js";
import { backfillResetAckResult, sanitizeLocalSourceReceiptError, sourceSyncReceiptResult, validateLocalSourceSyncReceipt } from "./receipts.js";
import { isRecord, query, validDate, type ImessageDb, type ImessageExecutor } from "./util.js";

/**
 * Durable Messages agent commands (GET /command, POST /command/ack) and their source-sync runs.
 *
 * Donor (gigabrain imessage-ingest.ts) kept ONE command in the user's token metadata and an
 * admin key chose the user. Here commands are rows addressed to one device binding, requested
 * by a verified yc_msaw principal of that tenant (internal route), delivered oldest-first to
 * that device only, and acknowledged exactly once: acking an unknown, foreign or already
 * settled id is the donor's `{ok:true, ignored:true}` and changes nothing. A newer request of
 * the same type supersedes a still-pending one (the donor overwrote it).
 * `messages_source_sync` creates a source_sync_runs row; the ack's receipt is validated with the
 * donor's local receipt rules before the run completes (otherwise it fails with the reason).
 */

export const MESSAGES_BACKFILL_RESET_COMMAND = "messages_backfill_reset";
export const MESSAGES_SOURCE_SYNC_COMMAND = "messages_source_sync";
export type ImessageCommandType = typeof MESSAGES_BACKFILL_RESET_COMMAND | typeof MESSAGES_SOURCE_SYNC_COMMAND;

export class CommandError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "device_revoked",
    message: string,
  ) {
    super(message);
  }
}

interface CommandRow {
  id: string;
  tenant_id: string;
  binding_id: string;
  type: ImessageCommandType;
  status: string;
  payload: Record<string, unknown>;
  source_sync_run_id: string | null;
  requested_by: string;
  requested_at: string | Date;
  acknowledged_at: string | Date | null;
  ack_status: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

const COMMAND_COLUMNS = sql.raw(
  "id::text AS id, tenant_id, binding_id, type, status, payload, source_sync_run_id::text AS source_sync_run_id, requested_by, requested_at, acknowledged_at, ack_status, result, error",
);

function iso(v: string | Date | null): string | null {
  return v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
}

/** The shape the bundled Mac agent reads from GET /command (donor pendingMessagesAgentCommand). */
export function wireCommand(row: CommandRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestedAt: iso(row.requested_at),
    ...(row.type === MESSAGES_SOURCE_SYNC_COMMAND
      ? { sourceSyncRunId: row.source_sync_run_id, coverageFrom: row.payload.coverageFrom ?? null, coverageTo: row.payload.coverageTo }
      : row.payload.backfillDays !== undefined
        ? { backfillDays: row.payload.backfillDays }
        : {}),
  };
}

export function adminCommand(row: CommandRow): Record<string, unknown> {
  return {
    ...wireCommand(row),
    bindingId: row.binding_id,
    requestedBy: row.requested_by,
    acknowledgedAt: iso(row.acknowledged_at),
    ...(row.ack_status ? { ackStatus: row.ack_status } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function parseBackfillDays(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "all") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 36_500) throw new CommandError("invalid_input", "backfillDays must be an integer 1-36500, \"all\" or null");
  return n;
}

export async function requestImessageCommand(
  database: ImessageDb,
  input: { tenantId: string; bindingId: string; body: unknown; requestedBy: string; now?: Date },
): Promise<{ command: Record<string, unknown>; superseded: string[] }> {
  const body = isRecord(input.body) ? input.body : {};
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : MESSAGES_BACKFILL_RESET_COMMAND;
  if (type !== MESSAGES_BACKFILL_RESET_COMMAND && type !== MESSAGES_SOURCE_SYNC_COMMAND) throw new CommandError("invalid_input", `Unsupported command type: ${type}`);
  const now = input.now ?? new Date();
  let payload: Record<string, unknown> = {};
  let coverage: { from: string | null; to: string } | null = null;
  if (type === MESSAGES_SOURCE_SYNC_COMMAND) {
    const to = body.coverageTo === undefined ? now : validDate(body.coverageTo);
    const from = body.coverageFrom === undefined || body.coverageFrom === null ? null : validDate(body.coverageFrom);
    if (!to) throw new CommandError("invalid_input", "coverageTo must be a valid timestamp");
    if (body.coverageFrom !== undefined && body.coverageFrom !== null && !from) throw new CommandError("invalid_input", "coverageFrom must be a valid timestamp or null (all history)");
    if (from && from.getTime() >= to.getTime()) throw new CommandError("invalid_input", "coverageFrom must be before coverageTo");
    coverage = { from: from?.toISOString() ?? null, to: to.toISOString() };
    payload = { coverageFrom: coverage.from, coverageTo: coverage.to };
  } else {
    const days = parseBackfillDays(body.backfillDays);
    if (days !== undefined) payload = { backfillDays: days };
  }

  return database.transaction(async (tx) => {
    const device = (await query<{ status: string }>(tx, sql`SELECT status FROM imessage_devices WHERE tenant_id = ${input.tenantId} AND binding_id = ${input.bindingId} FOR UPDATE`))[0];
    if (!device) throw new CommandError("not_found", "iMessage device not found for this tenant");
    if (device.status !== "active") throw new CommandError("device_revoked", "iMessage device is revoked");
    const superseded = await query<{ id: string; source_sync_run_id: string | null }>(
      tx,
      sql`UPDATE imessage_device_commands SET status = 'superseded', acknowledged_at = now(), error = 'superseded by a newer command'
          WHERE tenant_id = ${input.tenantId} AND binding_id = ${input.bindingId} AND type = ${type} AND status = 'pending'
          RETURNING id::text AS id, source_sync_run_id::text AS source_sync_run_id`,
    );
    for (const s of superseded) {
      if (s.source_sync_run_id) {
        await tx.execute(sql`UPDATE source_sync_runs SET status = 'failed', phase = 'superseded', failed_at = now(), updated_at = now(),
                               error_message = 'superseded by a newer iMessage source sync request'
                             WHERE id = ${s.source_sync_run_id}::uuid AND status IN ('queued', 'running')`);
      }
    }
    let runId: string | null = null;
    if (coverage) {
      runId = (
        await query<{ id: string }>(
          tx,
          sql`INSERT INTO source_sync_runs (user_id, provider, status, phase, requested_by, coverage_from, coverage_to, metadata)
              VALUES (${input.tenantId}, 'imessage', 'queued', 'awaiting_local_receipt', ${input.requestedBy.slice(0, 512)},
                      ${coverage.from}::timestamptz, ${coverage.to}::timestamptz, ${JSON.stringify({ bindingId: input.bindingId })}::jsonb)
              RETURNING id::text AS id`,
        )
      )[0]!.id;
    }
    const row = (
      await query<CommandRow>(
        tx,
        sql`INSERT INTO imessage_device_commands (tenant_id, binding_id, type, payload, source_sync_run_id, requested_by)
            VALUES (${input.tenantId}, ${input.bindingId}, ${type}, ${JSON.stringify(payload)}::jsonb, ${runId}::uuid, ${input.requestedBy.slice(0, 512)})
            RETURNING ${COMMAND_COLUMNS}`,
      )
    )[0]!;
    return { command: adminCommand(row), superseded: superseded.map((s) => s.id) };
  });
}

/** GET /command: the device's oldest pending command, or null. */
export async function nextImessageCommand(executor: ImessageExecutor, device: DeviceContext): Promise<Record<string, unknown> | null> {
  const row = (
    await query<CommandRow>(
      executor,
      sql`SELECT ${COMMAND_COLUMNS} FROM imessage_device_commands
          WHERE tenant_id = ${device.tenantId} AND binding_id = ${device.bindingId} AND status = 'pending'
          ORDER BY requested_at, id LIMIT 1`,
    )
  )[0];
  return row ? wireCommand(row) : null;
}

export async function listImessageCommands(executor: ImessageExecutor, tenantId: string, bindingId: string, limit = 50): Promise<Record<string, unknown>[]> {
  const found = await query<CommandRow>(
    executor,
    sql`SELECT ${COMMAND_COLUMNS} FROM imessage_device_commands WHERE tenant_id = ${tenantId} AND binding_id = ${bindingId}
        ORDER BY requested_at DESC, id DESC LIMIT ${Math.max(1, Math.min(200, limit))}`,
  );
  return found.map(adminCommand);
}

interface RunRow {
  id: string;
  user_id: string;
  provider: string;
  status: string;
  coverage_from: string | Date | null;
  coverage_to: string | Date;
}

/** POST /command/ack. Returns the donor response shape. */
export async function ackImessageCommand(
  database: ImessageDb,
  device: DeviceContext,
  body: unknown,
): Promise<{ ok: true; ignored?: true; command?: Record<string, unknown>; run?: Record<string, unknown> }> {
  const b = isRecord(body) ? body : {};
  const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : "";
  if (!id) throw new CommandError("invalid_input", "id is required");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: true, ignored: true };
  return database.transaction(async (tx) => {
    const current = (
      await query<CommandRow>(
        tx,
        sql`SELECT ${COMMAND_COLUMNS} FROM imessage_device_commands
            WHERE id = ${id}::uuid AND tenant_id = ${device.tenantId} AND binding_id = ${device.bindingId} FOR UPDATE`,
      )
    )[0];
    if (!current) return { ok: true, ignored: true };
    if (current.status !== "pending") return { ok: true, ignored: true, command: wireCommand(current) };

    const status = b.status === "failed" ? "failed" : "completed";
    const sanitizedError = sanitizeLocalSourceReceiptError(b.error);
    let result: Record<string, unknown> | undefined;
    let runOut: Record<string, unknown> | undefined;
    if (current.type === MESSAGES_SOURCE_SYNC_COMMAND) {
      result = sourceSyncReceiptResult(b.result);
      if (current.source_sync_run_id) runOut = await recordSourceSyncReceipt(tx, current.source_sync_run_id, device.tenantId, status, b.result, result, sanitizedError);
    } else {
      result = backfillResetAckResult(b.result);
    }
    const updated = (
      await query<CommandRow>(
        tx,
        sql`UPDATE imessage_device_commands
            SET status = ${status}, ack_status = ${status}, acknowledged_at = now(),
                result = ${result === undefined ? null : JSON.stringify(result)}::jsonb, error = ${sanitizedError}
            WHERE id = ${id}::uuid
            RETURNING ${COMMAND_COLUMNS}`,
      )
    )[0]!;
    return { ok: true, command: { ...wireCommand(updated), acknowledgedAt: iso(updated.acknowledged_at), ...(result ? { result } : {}), ...(sanitizedError ? { error: sanitizedError } : {}) }, ...(runOut ? { run: runOut } : {}) };
  });
}

async function recordSourceSyncReceipt(
  tx: ImessageExecutor,
  runId: string,
  tenantId: string,
  status: "completed" | "failed",
  rawResult: unknown,
  sanitizedResult: Record<string, unknown>,
  error: string | null,
): Promise<Record<string, unknown>> {
  const run = (
    await query<RunRow>(tx, sql`SELECT id::text AS id, user_id, provider, status, coverage_from, coverage_to FROM source_sync_runs WHERE id = ${runId}::uuid FOR UPDATE`)
  )[0];
  if (!run || run.user_id !== tenantId || run.provider !== "imessage") throw new Error("iMessage source sync run not found for tenant");
  if (run.status === "completed") return { id: run.id, status: run.status };
  if (run.status !== "queued" && run.status !== "running") return { id: run.id, status: run.status };
  if (status === "failed") {
    await tx.execute(sql`UPDATE source_sync_runs SET status = 'failed', phase = 'observer_failed', failed_at = now(), updated_at = now(),
                          error_message = ${error || "iMessage observer source sync failed"},
                          metadata = metadata || ${JSON.stringify({ observerReceipt: sanitizedResult })}::jsonb
                        WHERE id = ${runId}::uuid`);
    return { id: run.id, status: "failed", phase: "observer_failed" };
  }
  const validation = validateLocalSourceSyncReceipt({
    run: { id: run.id, provider: run.provider, coverageFrom: iso(run.coverage_from), coverageTo: iso(run.coverage_to)! },
    result: rawResult,
  });
  if (!validation.ok) {
    await tx.execute(sql`UPDATE source_sync_runs SET status = 'failed', phase = 'invalid_local_receipt', failed_at = now(), updated_at = now(),
                          error_message = ${validation.reason},
                          metadata = metadata || ${JSON.stringify({ localReceipt: validation.receipt.metadata, receiptCoverageFrom: validation.receipt.coverageFrom, receiptCoverageTo: validation.receipt.coverageTo, receiptHighWatermarkHash: validation.receipt.highWatermark })}::jsonb
                        WHERE id = ${runId}::uuid`);
    return { id: run.id, status: "failed", phase: "invalid_local_receipt", reason: validation.reason };
  }
  const r = validation.receipt;
  const completion = {
    receiptVersion: r.receiptVersion,
    sourceSyncRunId: r.sourceSyncRunId,
    provider: r.provider,
    coverageFrom: r.coverageFrom,
    coverageTo: r.coverageTo,
    highWatermark: r.highWatermark,
    scannedCount: r.scannedCount,
    uploadedCount: r.uploadedCount,
    skippedCount: r.skippedCount,
    pendingCount: r.pendingCount,
    failedCount: r.failedCount,
  };
  await tx.execute(sql`UPDATE source_sync_runs SET status = 'completed', phase = 'local_receipt', exhausted = true, cap_hit = false,
                        completed_at = now(), updated_at = now(), result = ${JSON.stringify(completion)}::jsonb,
                        metadata = metadata || ${JSON.stringify({ localReceipt: r.metadata, observerReceiptAt: new Date().toISOString() })}::jsonb
                      WHERE id = ${runId}::uuid`);
  return { id: run.id, status: "completed", phase: "local_receipt", result: completion };
}
