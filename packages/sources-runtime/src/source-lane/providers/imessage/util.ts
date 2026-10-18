import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { db } from "../../../db/client.js";

/** Database handle the iMessage receiver needs: statements plus transactions (donor drizzle client or a test instance). */
export type ImessageDb = Pick<typeof db, "execute" | "transaction">;
export type ImessageExecutor = Pick<typeof db, "execute">;

export function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) return (result as { rows: T[] }).rows;
  return [];
}

export async function query<T>(executor: ImessageExecutor, statement: SQL): Promise<T[]> {
  return rows<T>(await executor.execute(statement));
}

/** Serializes every iMessage write of one tenant (ingest, contacts, projection) inside the current transaction. */
export async function lockTenant(executor: ImessageExecutor, tenantId: string): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`imessage-ingest:${tenantId}`}, 0))`);
}

export function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function boundedString(value: unknown, maxLength: number): string | null {
  const text = stringValue(value);
  return text ? text.slice(0, maxLength) : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Donor stableJson (gigabrain imessage-ingest.ts): key-sorted JSON, undefined members dropped. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function sanitizeString(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\\u0000/g, "").replace(LONE_SURROGATE, "�");
}

/**
 * Donor sanitizeForJsonb (PostgreSQL jsonb rejects NUL), extended to object keys and
 * to unpaired UTF-16 surrogates, which jsonb also rejects; either would otherwise
 * fail the whole batch and leave the uploader retrying it forever.
 */
export function sanitizeForJsonb(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeForJsonb);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      result[sanitizeString(key)] = sanitizeForJsonb(entry);
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function jsonb(value: unknown): SQL {
  return sql`${JSON.stringify(sanitizeForJsonb(value))}::jsonb`;
}

export function validDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isoOrNull(value: unknown): string | null {
  return validDate(value)?.toISOString() ?? null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
