import { createHash } from "node:crypto";
import { getObjectRange, headObject, isTenantBinaryObjectKey, type ObjectStoreClient } from "../../vault/object-store.js";

/**
 * Exact-bytes transport from the donor S3 binary store to the source exporter. An object is read in 8 MiB
 * ranges (the yc_msaw blob limit), never as one Buffer: one pass builds and verifies the chunk manifest
 * against the recorded sha256, the publish pass reloads each chunk by range and re-verifies it.
 */

export const BINARY_CHUNK_BYTES = 8 * 1024 * 1024;

export interface BinaryChunk {
  sha256: string;
  size: number;
}

export interface BinaryObjectReader {
  head(key: string): Promise<{ size: number }>;
  range(key: string, start: number, endInclusive: number): Promise<Buffer>;
}

export function s3BinaryObjectReader(client?: ObjectStoreClient): BinaryObjectReader {
  return {
    head: (key) => headObject(key, client),
    range: (key, start, end) => getObjectRange(key, start, end, client),
  };
}

/** A permanent integrity failure: retrying cannot produce the recorded bytes, so the version is refused. */
export class BinaryIntegrityError extends Error {
  constructor(readonly code: "storage_key_not_tenant_scoped" | "object_missing" | "size_mismatch" | "sha256_mismatch", message: string) {
    super(message);
  }
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function assertTenantObject(tenantId: string, sha256: string, storageKey: string): void {
  if (!isTenantBinaryObjectKey(tenantId, sha256, storageKey)) {
    throw new BinaryIntegrityError("storage_key_not_tenant_scoped", "storage_key is not this tenant's content-addressed object for the recorded sha256");
  }
}

/** Builds the chunk manifest of `storageKey`, verifying size (when recorded) and the whole-object sha256. */
export async function buildChunkManifest(
  reader: BinaryObjectReader,
  input: { tenantId: string; storageKey: string; sha256: string; sizeBytes: number | null },
): Promise<BinaryChunk[]> {
  assertTenantObject(input.tenantId, input.sha256, input.storageKey);
  let size: number;
  try {
    size = (await reader.head(input.storageKey)).size;
  } catch (err) {
    if (isNotFound(err)) throw new BinaryIntegrityError("object_missing", "stored object is missing from the object store");
    throw err;
  }
  if (input.sizeBytes != null && size !== input.sizeBytes) {
    throw new BinaryIntegrityError("size_mismatch", `stored object is ${size} bytes, binary_documents recorded ${input.sizeBytes}`);
  }
  const whole = createHash("sha256");
  const chunks: BinaryChunk[] = [];
  for (let start = 0; start < size; start += BINARY_CHUNK_BYTES) {
    const bytes = await reader.range(input.storageKey, start, Math.min(size, start + BINARY_CHUNK_BYTES) - 1);
    whole.update(bytes);
    chunks.push({ sha256: sha(bytes), size: bytes.length });
  }
  if (whole.digest("hex") !== input.sha256) throw new BinaryIntegrityError("sha256_mismatch", "stored object bytes do not hash to the recorded sha256");
  return chunks;
}

/** Loader for SourceChunkedContent: chunk i is re-read by its byte range and checked against its manifest sha. */
export function chunkLoader(reader: BinaryObjectReader, storageKey: string, chunks: readonly BinaryChunk[]): (chunkSha256: string) => Promise<Buffer> {
  const offsets = new Map<string, { start: number; size: number }>();
  let at = 0;
  for (const c of chunks) {
    if (!offsets.has(c.sha256)) offsets.set(c.sha256, { start: at, size: c.size });
    at += c.size;
  }
  return async (chunkSha256) => {
    const where = offsets.get(chunkSha256);
    if (!where) throw new Error(`chunk ${chunkSha256.slice(0, 12)} is not in the manifest of ${storageKey}`);
    const bytes = await reader.range(storageKey, where.start, where.start + where.size - 1);
    if (sha(bytes) !== chunkSha256) throw new BinaryIntegrityError("sha256_mismatch", `chunk ${chunkSha256.slice(0, 12)} changed in the object store`);
    return bytes;
  };
}

function isNotFound(err: unknown): boolean {
  const r = err && typeof err === "object" ? (err as Record<string, any>) : {};
  return r.$metadata?.httpStatusCode === 404 || r.name === "NotFound" || r.name === "NoSuchKey";
}
