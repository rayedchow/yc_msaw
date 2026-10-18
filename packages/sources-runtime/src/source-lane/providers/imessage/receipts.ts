import { createHash } from "node:crypto";

/**
 * Local source-sync receipts and local status, ported from gigabrain@5448774e:
 *  - brain/src/routes/imessage-ingest.ts: localMessagesSyncStatus, sourceSyncReceiptResult
 *    and their copy*Field helpers (allow-listed numbers/enums/ids only; free text hashed);
 *  - brain/src/jobs/local-source-sync-receipts.ts: validateLocalSourceSyncReceipt,
 *    normalizeLocalSourceSyncReceipt, sanitizeReceiptMetadata, sanitizeLocalSourceReceiptError
 *    (provider fixed to "imessage"; coding_sessions receipts are not handled here).
 */

// ----------------------------------------------------------------- copy helpers (imessage-ingest.ts)

function copyStringEnumField(target: Record<string, unknown>, key: string, source: Record<string, unknown>, sourceKeys: string[], allowed: string[]) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    const raw = source[sourceKey];
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (allowed.includes(value)) target[key] = value;
    return;
  }
}

function copyUuidField(target: Record<string, unknown>, key: string, source: Record<string, unknown>, sourceKeys: string[]) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    const value = source[sourceKey];
    if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) {
      target[key] = value.trim().toLowerCase();
    } else {
      target[key] = "";
    }
    return;
  }
}

function copyProviderField(target: Record<string, unknown>, source: Record<string, unknown>, sourceKeys: string[]) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    if (source[sourceKey] === "imessage") target.provider = "imessage";
    return;
  }
}

function copyIsoField(target: Record<string, unknown>, key: string, source: Record<string, unknown>, sourceKeys: string[]) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    const value = source[sourceKey];
    if (value === null && key === "coverageFrom") {
      target[key] = null;
      return;
    }
    if (typeof value !== "string" || !value.trim()) {
      target[key] = "";
      return;
    }
    const date = new Date(value.trim());
    target[key] = Number.isNaN(date.getTime()) ? "" : date.toISOString();
    return;
  }
}

function copyScopeKindField(target: Record<string, unknown>, source: Record<string, unknown>, sourceKeys: string[]) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    const value = source[sourceKey];
    if (value === "all_chats" || value === "selected_chats") target.scopeKind = value;
    return;
  }
}

function copyWatermarkField(target: Record<string, unknown>, key: string, source: Record<string, unknown>, sourceKeys: string[]) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    const value = stringOrNull(source[sourceKey]);
    target[key] = value ? receiptWatermark(value) : null;
    return;
  }
}

function copyStringField(target: Record<string, unknown>, key: string, source: Record<string, unknown>, sourceKeys: string[], maxLength: number) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    const value = source[sourceKey];
    const text = typeof value === "string" && value.trim() ? value.trim() : null;
    target[key] = text ? text.slice(0, maxLength) : null;
    return;
  }
}

function copyNumberField(target: Record<string, unknown>, key: string, source: Record<string, unknown>, sourceKeys: string[]) {
  for (const sourceKey of sourceKeys) {
    if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) continue;
    target[key] = numberOrNull(source[sourceKey]);
    return;
  }
}

function receiptWatermark(value: string): string {
  if (/^sha256:[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Donor localMessagesSyncStatus: what the Mac reports about its local scan (no chat names or content). */
export function localMessagesSyncStatus(value: unknown, now: Date = new Date()): Record<string, unknown> {
  const record = plainRecord(value) ?? {};
  const result: Record<string, unknown> = { version: 1, reportedAt: now.toISOString() };
  copyStringEnumField(result, "status", record, ["status"], ["running", "paused", "complete", "failed"]);
  copyStringEnumField(result, "scopeKind", record, ["scopeKind"], ["all_chats", "selected_chats"]);
  copyNumberField(result, "selectedChatCount", record, ["selectedChatCount", "chatCount"]);
  copyNumberField(result, "estimatedTotalMessages", record, ["estimatedTotalMessages", "totalMessages"]);
  copyNumberField(result, "scannedMessages", record, ["scannedMessages"]);
  copyNumberField(result, "sentMessages", record, ["sentMessages"]);
  copyNumberField(result, "storedMessages", record, ["storedMessages"]);
  copyNumberField(result, "updatedMessages", record, ["updatedMessages"]);
  copyNumberField(result, "skippedMessages", record, ["skippedMessages"]);
  copyNumberField(result, "queuedMessages", record, ["queuedMessages", "queueDepth"]);
  copyNumberField(result, "ratePerMinute", record, ["ratePerMinute"]);
  copyNumberField(result, "etaSeconds", record, ["etaSeconds"]);
  copyUuidField(result, "deviceId", record, ["deviceId"]);
  copyStringField(result, "agentVersion", record, ["agentVersion"], 64);
  copyStringField(result, "agentChannel", record, ["agentChannel"], 64);
  copyIsoField(result, "startedAt", record, ["startedAt"]);
  copyIsoField(result, "updatedAt", record, ["updatedAt"]);
  copyIsoField(result, "finishedAt", record, ["finishedAt"]);
  return result;
}

/** Donor sourceSyncReceiptResult: the allow-listed receipt kept on the command. */
export function sourceSyncReceiptResult(value: unknown): Record<string, unknown> {
  const record = plainRecord(value) ?? {};
  const result: Record<string, unknown> = { exhausted: record.exhausted === true, capHit: record.capHit === true };
  copyNumberField(result, "receiptVersion", record, ["receiptVersion"]);
  copyUuidField(result, "sourceSyncRunId", record, ["sourceSyncRunId"]);
  copyProviderField(result, record, ["provider"]);
  copyNumberField(result, "pendingMessages", record, ["pendingMessages", "pendingCount"]);
  copyNumberField(result, "failedMessages", record, ["failedMessages", "failedCount", "errors"]);
  copyNumberField(result, "scannedMessages", record, ["scannedMessages"]);
  copyNumberField(result, "sentMessages", record, ["sentMessages"]);
  copyNumberField(result, "chatsSeen", record, ["chatsSeen"]);
  copyNumberField(result, "queueDepth", record, ["queueDepth"]);
  copyWatermarkField(result, "highWatermark", record, ["highWatermark"]);
  copyIsoField(result, "coverageFrom", record, ["coverageFrom"]);
  copyIsoField(result, "coverageTo", record, ["coverageTo"]);
  copyScopeKindField(result, record, ["scopeKind"]);
  copyWatermarkField(result, "scopeHash", record, ["scopeHash"]);
  copyUuidField(result, "deviceId", record, ["deviceId"]);
  copyStringField(result, "agentVersion", record, ["agentVersion"], 64);
  copyStringField(result, "agentChannel", record, ["agentChannel"], 64);
  return result;
}

/**
 * A bounded, allow-listed copy of a free-form ack `result` for non-receipt commands
 * (backfill reset). The donor stored the device's object verbatim; only counters,
 * booleans and short identifiers are kept here so no message content reaches the server.
 */
export function backfillResetAckResult(value: unknown): Record<string, unknown> | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(record).slice(0, 50)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean" || v === null) out[key] = v;
  }
  return out;
}

// ----------------------------------------------------------------- receipt validation (local-source-sync-receipts.ts)

export interface LocalSourceSyncReceipt {
  receiptVersion: number;
  sourceSyncRunId: string;
  provider: "imessage" | null;
  coverageFrom: string | null;
  coverageFromProvided: boolean;
  coverageTo: string;
  highWatermark: string;
  exhausted: boolean;
  capHit: boolean;
  scannedCount: number | null;
  uploadedCount: number | null;
  skippedCount: number | null;
  pendingCount: number | null;
  pendingCountProvided: boolean;
  failedCount: number | null;
  failedCountProvided: boolean;
  metadata: Record<string, unknown>;
}

export interface ReceiptRun {
  id: string;
  provider: string;
  coverageFrom: string | null;
  coverageTo: string;
}

export type LocalSourceReceiptValidation = { ok: true; receipt: LocalSourceSyncReceipt } | { ok: false; reason: string; receipt: LocalSourceSyncReceipt };

export function validateLocalSourceSyncReceipt(input: { run: ReceiptRun; result: unknown }): LocalSourceReceiptValidation {
  const receipt = normalizeLocalSourceSyncReceipt(input.result);
  if (receipt.sourceSyncRunId !== input.run.id) return { ok: false, reason: "receipt sourceSyncRunId does not match source sync run", receipt };
  if (receipt.provider !== "imessage" || input.run.provider !== "imessage") return { ok: false, reason: "receipt provider does not match source sync run", receipt };
  if (receipt.receiptVersion < 1) return { ok: false, reason: "receiptVersion is required", receipt };
  if (!receipt.highWatermark) return { ok: false, reason: "highWatermark is required", receipt };
  if (!receipt.exhausted) return { ok: false, reason: "local source did not report exhausted=true", receipt };
  if (receipt.capHit) return { ok: false, reason: "local source reported capHit=true", receipt };
  if (!receipt.pendingCountProvided || receipt.pendingCount === null) return { ok: false, reason: "valid pending count is required", receipt };
  if (!receipt.failedCountProvided || receipt.failedCount === null) return { ok: false, reason: "valid failed count is required", receipt };
  if (receipt.pendingCount > 0) return { ok: false, reason: `local source has ${receipt.pendingCount} pending item(s)`, receipt };
  if (receipt.failedCount > 0) return { ok: false, reason: `local source has ${receipt.failedCount} failed item(s)`, receipt };
  const coverageTo = parseIso(receipt.coverageTo);
  const requiredTo = parseIso(input.run.coverageTo);
  if (!coverageTo || !requiredTo || coverageTo.getTime() < requiredTo.getTime()) return { ok: false, reason: "receipt coverageTo does not cover requested cutoff", receipt };
  if (input.run.coverageFrom) {
    if (!receipt.coverageFromProvided) return { ok: false, reason: "receipt coverageFrom is required for bounded sync", receipt };
    if (receipt.coverageFrom === null) return { ok: true, receipt };
    const coverageFrom = parseIso(receipt.coverageFrom);
    const requiredFrom = parseIso(input.run.coverageFrom);
    if (!coverageFrom || !requiredFrom || coverageFrom.getTime() > requiredFrom.getTime()) return { ok: false, reason: "receipt coverageFrom starts after requested coverage", receipt };
  } else if (receipt.coverageFromProvided && receipt.coverageFrom !== null) {
    // An all-history request is only covered by an all-history receipt.
    return { ok: false, reason: "receipt coverageFrom is bounded but the run requested all history", receipt };
  }
  return { ok: true, receipt };
}

function normalizeLocalSourceSyncReceipt(value: unknown): LocalSourceSyncReceipt {
  const record = plainRecord(value) ?? {};
  const nested = plainRecord(record.receipt) ?? record;
  const pendingCountKeys = ["pendingCount", "pendingItems", "pendingMessages", "pendingSessions", "pendingUploads", "remaining"];
  const failedCountKeys = ["failedCount", "failedItems", "failedMessages", "failedSessions", "failedUploads", "errors"];
  const coverageFromProvided = Object.prototype.hasOwnProperty.call(nested, "coverageFrom");
  return {
    receiptVersion: firstNumber(nested, ["receiptVersion", "version"]) ?? 0,
    sourceSyncRunId: receiptString(nested.sourceSyncRunId) ?? "",
    provider: nested.provider === "imessage" ? "imessage" : null,
    coverageFrom: coverageFromProvided ? isoStringOrEmpty(nested.coverageFrom, { allowNull: true }) : null,
    coverageFromProvided,
    coverageTo: isoStringOrEmpty(nested.coverageTo),
    highWatermark: watermarkValue(nested.highWatermark) ?? "",
    exhausted: nested.exhausted === true || nested.done === true,
    capHit: nested.capHit === true || nested.capped === true,
    scannedCount: firstNumber(nested, ["scannedCount", "scannedMessages", "localFilesSeen", "sessionsSeen"]),
    uploadedCount: firstNumber(nested, ["uploadedCount", "uploadedSessions", "sentMessages", "sessionsUploaded"]),
    skippedCount: firstNumber(nested, ["skippedCount", "skippedSessions", "skippedMessages"]),
    pendingCount: firstNumber(nested, pendingCountKeys),
    pendingCountProvided: hasAnyKey(nested, pendingCountKeys),
    failedCount: firstNumber(nested, failedCountKeys),
    failedCountProvided: hasAnyKey(nested, failedCountKeys),
    metadata: sanitizeReceiptMetadata(nested),
  };
}

function sanitizeReceiptMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "agentVersion", "parserVersion", "providers", "fullInventory", "chatsSeen", "scannedMessages", "sentMessages",
    "localFilesSeen", "filesDiscovered", "filesParsed", "parseErrors", "sessionsSeen", "sessionsEligible",
    "uploadedSessions", "sessionsUploaded", "skippedSessions", "queueDepth", "manifestHash", "scopeKind",
    "scopeHash", "coverageFrom", "coverageTo", "highWatermark",
  ];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = record[key];
    if (value == null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if ((key === "highWatermark" || key === "manifestHash" || key === "scopeHash") && typeof value === "string") {
      out[key] = watermarkValue(value);
    } else if (key === "coverageFrom" || key === "coverageTo") {
      out[key] = isoStringOrEmpty(value, { allowNull: true }) || "invalid";
    } else if (typeof value === "string") {
      out[key] = safeMetadataStringValue(value);
    } else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 25)
        .map((item) => {
          if (typeof item === "string") return safeMetadataStringValue(item);
          if (typeof item === "number" && Number.isFinite(item)) return item;
          if (typeof item === "boolean" || item === null) return item;
          return watermarkValue(JSON.stringify(item));
        })
        .filter((item) => item !== null);
    }
  }
  // JSON has no undefined: drop absent keys so the stored metadata is exactly what was reported.
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

function safeMetadataStringValue(value: string): string {
  const raw = value.trim();
  if (/^[a-zA-Z0-9._:+-]{1,200}$/.test(raw)) return raw;
  return watermarkValue(raw) ?? "";
}

function watermarkValue(value: unknown): string | null {
  const raw = receiptString(value);
  if (!raw) return null;
  if (/^sha256:[a-f0-9]{64}$/i.test(raw)) return raw.toLowerCase();
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/** Donor sanitizeLocalSourceReceiptError: device error text is never stored, only its hash. */
export function sanitizeLocalSourceReceiptError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = value instanceof Error ? value.message : String(value);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const existing = /^local source error sha256:([a-f0-9]{64})$/i.exec(trimmed);
  if (existing) return `local source error sha256:${existing[1]!.toLowerCase()}`;
  return `local source error sha256:${createHash("sha256").update(trimmed).digest("hex")}`;
}

function hasAnyKey(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = receiptNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function receiptNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
}

function isoStringOrEmpty(value: unknown): string;
function isoStringOrEmpty(value: unknown, opts: { allowNull: true }): string | null;
function isoStringOrEmpty(value: unknown, opts: { allowNull?: boolean } = {}): string | null {
  if (value === null && opts.allowNull) return null;
  const raw = receiptString(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function receiptString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_000) : null;
}

function parseIso(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
