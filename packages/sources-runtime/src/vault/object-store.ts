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
