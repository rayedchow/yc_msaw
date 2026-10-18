import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { putObject } from "../../vault/object-store.js";
import { redactProviderPayload } from "../../vault/redaction.js";

export type BinaryDocumentProvider = "drive-pdf" | "upload" | "slack" | "gmail-attachment";
/** `stored` = bytes captured for a non-PDF type with no parse pipeline (raw capture only). */
export type BinaryDocumentParseStatus = "pending" | "parsed" | "failed_fetch" | "failed_unsupported" | "stored";

export interface BinaryObjectStore {
  putObject(input: {
    tenantId: string;
    sha256: string;
    bytes: Buffer | Uint8Array;
    contentType: string;
  }): Promise<string>;
}

export interface BinaryDocumentExecutor {
  execute(query: unknown): Promise<unknown>;
}

export interface IntakeBinaryDocumentInput {
  tenantId: string;
  provider: BinaryDocumentProvider;
  externalId: string;
  fetchBytes: () => Promise<Buffer | Uint8Array | ArrayBuffer>;
  mimeType: string;
  versionRef?: string | null;
  sourceUpdatedAt?: string | Date | null;
  authorEmail?: string | null;
  sourceAcl?: unknown;
  /**
   * PDF-only by default (the parse pipeline). When true, bytes are stored for
   * any mime type; non-PDF rows land as parse_status `stored` (raw capture,
   * no parser). Used by the Slack attachment lane.
   */
  acceptAnyMimeType?: boolean;
  /**
   * Mime types whose BYTES this intake will fetch and store. Defaults to the
   * original PDF-only lane; callers with a wider byte scope (e.g. gmail
   * attachments) pass their own allowlist. Anything outside the set is
   * recorded as a metadata-only `failed_unsupported` row - never silently
   * dropped, never fetched. `acceptAnyMimeType` bypasses the allowlist.
   */
  supportedMimeTypes?: ReadonlySet<string>;
  objectStore?: BinaryObjectStore;
  executor?: BinaryDocumentExecutor;
}

export interface IntakeBinaryDocumentResult {
  status: "skipped" | "stored" | "failed_fetch" | "failed_unsupported";
  id?: string;
  sha256?: string;
  storageKey?: string;
  sizeBytes?: number;
}

const PDF_MIME = "application/pdf";
const DEFAULT_SUPPORTED_MIMES: ReadonlySet<string> = new Set([PDF_MIME]);
const DRIVE_METADATA_DENYLIST = new Set(["thumbnailLink", "webContentLink", "exportLinks"]);

const defaultObjectStore: BinaryObjectStore = { putObject };

export async function intakeBinaryDocument(input: IntakeBinaryDocumentInput): Promise<IntakeBinaryDocumentResult> {
  const executor = input.executor ?? db;
  const existing = await findBinaryDocument(input.tenantId, input.provider, input.externalId, executor);
  if (
    existing
    && input.versionRef != null
    && existing.version_ref === input.versionRef
  ) {
    return {
      status: "skipped",
      id: existing.id,
      sha256: existing.sha256 ?? undefined,
      storageKey: existing.storage_key ?? undefined,
      sizeBytes: existing.size_bytes == null ? undefined : Number(existing.size_bytes),
    };
  }

  const sourceAcl = normalizeSourceAcl(input.sourceAcl);
  const sourceUpdatedAt = dateOrNull(input.sourceUpdatedAt);
  const authorEmail = cleanString(input.authorEmail);
  const versionRef = cleanString(input.versionRef);
  const mimeType = cleanMimeType(input.mimeType);
  const supportedMimeTypes = input.supportedMimeTypes ?? DEFAULT_SUPPORTED_MIMES;

  if (!supportedMimeTypes.has(mimeType) && input.acceptAnyMimeType !== true) {
    console.warn(
      `[binary] skipping unsupported binary document ${input.provider}:${input.externalId} for tenant ${input.tenantId}; mime_type=${mimeType || "unknown"}`,
    );
    const row = await upsertBinaryDocument({
      tenantId: input.tenantId,
      provider: input.provider,
      externalId: input.externalId,
      sha256: null,
      mimeType: mimeType || input.mimeType || "application/octet-stream",
      sizeBytes: null,
      storageKey: null,
      versionRef,
      sourceUpdatedAt,
      authorEmail,
      sourceAcl,
      parseStatus: "failed_unsupported",
    }, executor);
    return { status: "failed_unsupported", id: row.id };
  }

  let bytes: Buffer;
  try {
    bytes = toBuffer(await input.fetchBytes());
  } catch (err) {
    console.warn(
      `[binary] failed to fetch binary document ${input.provider}:${input.externalId} for tenant ${input.tenantId}: ${errorMessage(err)}`,
    );
    const row = await upsertBinaryDocument({
      tenantId: input.tenantId,
      provider: input.provider,
      externalId: input.externalId,
      sha256: null,
      mimeType,
      sizeBytes: null,
      storageKey: null,
      versionRef,
      sourceUpdatedAt,
      authorEmail,
      sourceAcl,
      parseStatus: "failed_fetch",
    }, executor);
    return { status: "failed_fetch", id: row.id };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = await (input.objectStore ?? defaultObjectStore).putObject({
    tenantId: input.tenantId,
    sha256,
    bytes,
    contentType: mimeType || "application/octet-stream",
  });
  const row = await upsertBinaryDocument({
    tenantId: input.tenantId,
    provider: input.provider,
    externalId: input.externalId,
    sha256,
    mimeType: mimeType || "application/octet-stream",
    sizeBytes: bytes.byteLength,
    storageKey,
    versionRef,
    sourceUpdatedAt,
    authorEmail,
    sourceAcl,
    parseStatus: mimeType === PDF_MIME ? "pending" : "stored",
  }, executor);

  return { status: "stored", id: row.id, sha256, storageKey, sizeBytes: bytes.byteLength };
}

export async function tombstoneBinaryDocument(
  input: { tenantId: string; provider: BinaryDocumentProvider; externalId: string; executor?: BinaryDocumentExecutor },
): Promise<number> {
  const executor = input.executor ?? db;
  const rows = await executor.execute(sql`
    UPDATE binary_documents
    SET tombstoned_at = COALESCE(tombstoned_at, now()), updated_at = now()
    WHERE tenant_id = ${input.tenantId}
      AND provider = ${input.provider}
      AND external_id = ${input.externalId}
      AND tombstoned_at IS NULL
    RETURNING id
  `);
  return rowsFrom<{ id: string }>(rows).length;
}

interface BinaryDocumentRow {
  id: string;
  sha256: string | null;
  storage_key: string | null;
  version_ref: string | null;
  parse_status: BinaryDocumentParseStatus;
  size_bytes: number | string | null;
}

interface UpsertBinaryDocumentInput {
  tenantId: string;
  provider: BinaryDocumentProvider;
  externalId: string;
  sha256: string | null;
  mimeType: string;
  sizeBytes: number | null;
  storageKey: string | null;
  versionRef: string | null;
  sourceUpdatedAt: Date | null;
  authorEmail: string | null;
  sourceAcl: Record<string, unknown>;
  parseStatus: BinaryDocumentParseStatus;
}

async function findBinaryDocument(
  tenantId: string,
  provider: BinaryDocumentProvider,
  externalId: string,
  executor: BinaryDocumentExecutor,
): Promise<BinaryDocumentRow | null> {
  const rows = await executor.execute(sql`
    SELECT id, sha256, storage_key, version_ref, parse_status, size_bytes
    FROM binary_documents
    WHERE tenant_id = ${tenantId}
      AND provider = ${provider}
      AND external_id = ${externalId}
    LIMIT 1
  `);
  return rowsFrom<BinaryDocumentRow>(rows)[0] ?? null;
}

async function upsertBinaryDocument(
  input: UpsertBinaryDocumentInput,
  executor: BinaryDocumentExecutor,
): Promise<{ id: string }> {
  const rows = await executor.execute(sql`
    INSERT INTO binary_documents (
      tenant_id,
      provider,
      external_id,
      sha256,
      mime_type,
      size_bytes,
      storage_key,
      version_ref,
      source_updated_at,
      author_email,
      source_acl,
      parse_status
    )
    VALUES (
      ${input.tenantId},
      ${input.provider},
      ${input.externalId},
      ${input.sha256},
      ${input.mimeType},
      ${input.sizeBytes},
      ${input.storageKey},
      ${input.versionRef},
      ${input.sourceUpdatedAt ? input.sourceUpdatedAt.toISOString() : null}::timestamptz,
      ${input.authorEmail},
      ${JSON.stringify(input.sourceAcl)}::jsonb,
      ${input.parseStatus}
    )
    ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET
      sha256 = EXCLUDED.sha256,
      mime_type = EXCLUDED.mime_type,
      size_bytes = EXCLUDED.size_bytes,
      storage_key = EXCLUDED.storage_key,
      version_ref = EXCLUDED.version_ref,
      source_updated_at = EXCLUDED.source_updated_at,
      author_email = EXCLUDED.author_email,
      source_acl = EXCLUDED.source_acl,
      parse_status = EXCLUDED.parse_status,
      tombstoned_at = NULL,
      updated_at = now()
    RETURNING id
  `);
  return rowsFrom<{ id: string }>(rows)[0] ?? { id: "" };
}

function normalizeSourceAcl(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { permissions: scrubDeniedDriveMetadata(redactProviderPayload("google-docs", value)) };
  }
  if (value == null) return {};
  if (!isRecord(value)) throw new Error("sourceAcl must be an object or permissions array");
  return scrubDeniedDriveMetadata(redactProviderPayload("google-docs", value)) as Record<string, unknown>;
}

function scrubDeniedDriveMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubDeniedDriveMetadata);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (DRIVE_METADATA_DENYLIST.has(key)) continue;
    out[key] = scrubDeniedDriveMetadata(child);
  }
  return out;
}

function rowsFrom<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (isRecord(value) && Array.isArray(value.rows)) return value.rows as T[];
  return [];
}

function toBuffer(value: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

function cleanMimeType(value: string): string {
  return value.trim().toLowerCase().split(";")[0]?.trim() ?? "";
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateOrNull(value: string | Date | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
