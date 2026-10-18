import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.js";

export interface PutObjectInput {
  tenantId: string;
  sha256: string;
  bytes: Buffer | Uint8Array;
  contentType: string;
}

export interface ObjectStoreClient {
  send(command: HeadObjectCommand | PutObjectCommand | DeleteObjectCommand | GetObjectCommand): Promise<unknown>;
}

let defaultClient: S3Client | null = null;
let injectedClient: ObjectStoreClient | null = null;

export function setObjectStoreClientForTests(client: ObjectStoreClient | null): void {
  injectedClient = client;
}

export async function putObject(input: PutObjectInput, client?: ObjectStoreClient): Promise<string> {
  const bucket = objectStoreBucket();
  const store = objectStoreClient(client);
  const key = binaryObjectKey(input.tenantId, input.sha256);

  if (await objectExists(store, bucket, key)) {
    return key;
  }

  await store.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: input.bytes,
    ContentType: input.contentType,
  }));
  return key;
}

export async function deleteObject(key: string, client?: ObjectStoreClient): Promise<void> {
  const bucket = objectStoreBucket();
  const store = objectStoreClient(client);
  await store.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function getSignedDownloadUrl(
  key: string,
  ttlSeconds: number,
  client?: S3Client,
): Promise<string> {
  const bucket = objectStoreBucket();
  const store = client ?? (objectStoreClient() as S3Client);
  const requestedTtl = Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : 60;
  const expiresIn = Math.min(Math.max(requestedTtl, 1), 15 * 60);
  return getSignedUrl(store, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

/**
 * SOURCE-LANE PATCH (binary lane): bounded reads for the source exporter. `headObject` returns the stored size;
 * `getObjectRange` reads one inclusive byte range so a large object is streamed chunk by chunk instead of
 * materialised whole. A short or over-long body is an error (never silently truncated bytes).
 */
export async function headObject(key: string, client?: ObjectStoreClient): Promise<{ size: number; contentType: string | null }> {
  const out = (await objectStoreClient(client).send(new HeadObjectCommand({ Bucket: objectStoreBucket(), Key: key }))) as Record<string, unknown>;
  const size = Number(out.ContentLength);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`object ${key}: HEAD returned no usable ContentLength`);
  return { size, contentType: typeof out.ContentType === "string" ? out.ContentType : null };
}

export async function getObjectRange(key: string, start: number, endInclusive: number, client?: ObjectStoreClient): Promise<Buffer> {
  const want = endInclusive - start + 1;
  if (!Number.isSafeInteger(start) || start < 0 || want <= 0) throw new Error(`object ${key}: invalid range ${start}-${endInclusive}`);
  const out = (await objectStoreClient(client).send(
    new GetObjectCommand({ Bucket: objectStoreBucket(), Key: key, Range: `bytes=${start}-${endInclusive}` }),
  )) as Record<string, unknown>;
  const bytes = await bodyBytes(out.Body);
  if (bytes.length !== want) throw new Error(`object ${key}: range ${start}-${endInclusive} returned ${bytes.length} bytes, expected ${want}`);
  return bytes;
}

/** The only key shape putObject writes; anything else is not this tenant's content-addressed object. */
export function isTenantBinaryObjectKey(tenantId: string, sha256: string, key: string): boolean {
  return /^[0-9a-f]{64}$/.test(sha256) && tenantId.length > 0 && !tenantId.includes("/") && key === binaryObjectKey(tenantId, sha256);
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const b = body as { transformToByteArray?: () => Promise<Uint8Array>; [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> };
  if (typeof b.transformToByteArray === "function") return Buffer.from(await b.transformToByteArray());
  if (typeof b[Symbol.asyncIterator] === "function") {
    const parts: Buffer[] = [];
    for await (const part of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(part));
    return Buffer.concat(parts);
  }
  throw new Error("object body is not readable");
}

function objectStoreBucket(): string {
  if (!env.AQUEDUCT_S3_BUCKET) {
    throw new Error("object store not configured: AQUEDUCT_S3_BUCKET is unset");
  }
  return env.AQUEDUCT_S3_BUCKET;
}

function objectStoreClient(client?: ObjectStoreClient): ObjectStoreClient {
  if (client) return client;
  if (injectedClient) return injectedClient;
  defaultClient ??= new S3Client({ region: env.AWS_REGION });
  return defaultClient;
}

function binaryObjectKey(tenantId: string, sha256: string): string {
  return `binary/${tenantId}/${sha256}`;
}

async function objectExists(client: ObjectStoreClient, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  const record = err && typeof err === "object" ? err as Record<string, unknown> : {};
  const status = Number(record.$metadata && typeof record.$metadata === "object"
    ? (record.$metadata as Record<string, unknown>).httpStatusCode
    : undefined);
  return status === 404 || record.name === "NotFound" || record.name === "NoSuchKey";
}
