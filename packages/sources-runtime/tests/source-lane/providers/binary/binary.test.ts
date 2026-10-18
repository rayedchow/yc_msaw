/**
 * Binary lane: donor binary_documents rows (captured by the real intakeBinaryDocument into a fake S3 through
 * the real object-store client path) exported by the production extraTables mappers. PGlite runs the real
 * migration plan, so 9600's version-capture and journal triggers fire for real. Synthetic bytes only.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

vi.hoisted(() => {
  process.env.AQUEDUCT_S3_BUCKET = "binary-lane-test";
});

import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { intakeBinaryDocument, tombstoneBinaryDocument } from "../../../../src/integrations/binary/intake.js";
import { setObjectStoreClientForTests, getObjectRange } from "../../../../src/vault/object-store.js";
import { BINARY_CHUNK_BYTES, s3BinaryObjectReader } from "../../../../src/integrations/binary/source-bytes.js";
import { binaryCoverage, createBinaryProvider } from "../../../../src/source-lane/providers/binary/index.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { SOURCE_PROVIDERS } from "../../../../src/source-lane/providers/index.js";
import { SourcePublishClient } from "../../../../src/source-lane/export/publish-client.js";
import type { ExtraTableExport, SourceFileChange, SourcePutFile } from "../../../../src/source-lane/core/types.js";

const pg = new PGlite();
const db = drizzle(pg);
const ready = (async () => {
  for (const file of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
})();
const query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pg.query<T>(text, params)).rows;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** S3 double for the SDK commands object-store.ts sends; records every ranged read. */
class FakeS3 {
  objects = new Map<string, Buffer>();
  reads: Array<{ key: string; bytes: number }> = [];
  failures = 0;
  async send(cmd: unknown): Promise<unknown> {
    if (this.failures > 0 && !(cmd instanceof PutObjectCommand)) {
      this.failures--;
      throw Object.assign(new Error("SlowDown: please reduce your request rate"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    }
    const input = (cmd as { input: Record<string, any> }).input;
    const obj = this.objects.get(input.Key);
    if (cmd instanceof PutObjectCommand) {
      this.objects.set(input.Key, Buffer.from(input.Body));
      return {};
    }
    if (!obj) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    if (cmd instanceof HeadObjectCommand) return { ContentLength: obj.length, ContentType: "application/octet-stream" };
    if (cmd instanceof GetObjectCommand) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(String(input.Range));
      if (!m) throw new Error("test S3 only serves ranged reads");
      const body = obj.subarray(Number(m[1]), Math.min(obj.length, Number(m[2]) + 1));
      this.reads.push({ key: input.Key, bytes: body.length });
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    throw new Error("unexpected command");
  }
}

const s3 = new FakeS3();
const provider = createBinaryProvider(s3BinaryObjectReader());
const [docsExport, versionsExport] = provider.extraTables as [ExtraTableExport, ExtraTableExport];
const T = "tenant-binary-a";

/** Published state per path, plus the exporter's per-row path ledger; drained from the real journal. */
let files: Map<string, { bytes: Buffer; put: SourcePutFile }>;
let ledger: Map<string, string[]>;
let lastDeletes: SourceFileChange[];

async function materialize(put: SourcePutFile): Promise<Buffer> {
  if (!put.chunked) return put.content;
  const parts: Buffer[] = [];
  for (const c of put.chunked.chunks) parts.push(await put.chunked.load(c.sha256));
  return Buffer.concat(parts);
}

async function drain(tenant = T): Promise<{ errors: string[] }> {
  const journal = await query<{ id: string; table_name: string; row_key: string; op: string; enqueued_at: Date }>(
    `SELECT id::text, table_name, row_key, op, enqueued_at FROM source_lane_journal WHERE tenant_id = $1 ORDER BY id`, [tenant]);
  const errors: string[] = [];
  lastDeletes = [];
  const seen = new Set<string>();
  for (const j of journal) {
    const k = `${j.table_name}|${j.row_key}`;
    if (seen.has(k)) { await query(`DELETE FROM source_lane_journal WHERE id = $1`, [j.id]); continue; }
    seen.add(k);
    const table = j.table_name === "binary_documents" ? docsExport : j.table_name === "binary_document_versions" ? versionsExport : null;
    if (!table) { await query(`DELETE FROM source_lane_journal WHERE id = $1`, [j.id]); continue; }
    try {
      const changes = await table.map({ tenantId: tenant, executor: db as never }, j.row_key, { op: j.op as never, enqueuedAt: j.enqueued_at.toISOString() }, ledger.get(k) ?? []);
      const produced: string[] = [];
      for (const c of changes) {
        if (c.op === "put") { files.set(c.path, { bytes: await materialize(c), put: c }); produced.push(c.path); }
        else { files.delete(c.path); lastDeletes.push(c); }
      }
      // Paths this row no longer produces (the exporter's move handling) go away too.
      if (changes.some((c) => c.op === "put")) for (const p of ledger.get(k) ?? []) if (!produced.includes(p)) files.delete(p);
      ledger.set(k, produced);
      await query(`DELETE FROM source_lane_journal WHERE tenant_id = $1 AND table_name = $2 AND row_key = $3`, [tenant, j.table_name, j.row_key]);
    } catch (err) {
      errors.push(String((err as Error).message));
    }
  }
  return { errors };
}

function intake(input: { externalId: string; bytes: Buffer; mimeType?: string; versionRef?: string; provider?: "drive-pdf" | "upload" | "slack" | "gmail-attachment"; tenantId?: string }) {
  return intakeBinaryDocument({
    tenantId: input.tenantId ?? T,
    provider: input.provider ?? "drive-pdf",
    externalId: input.externalId,
    fetchBytes: async () => input.bytes,
    mimeType: input.mimeType ?? "application/pdf",
    versionRef: input.versionRef ?? null,
    sourceUpdatedAt: "2026-10-01T12:00:00Z",
    authorEmail: "author@example.test",
    sourceAcl: { provider: "drive-pdf", fileId: input.externalId },
    acceptAnyMimeType: input.mimeType != null && input.mimeType !== "application/pdf",
    executor: db as never,
  });
}

const under = (prefix: string) => [...files.keys()].filter((p) => p.startsWith(prefix)).sort();

beforeEach(async () => {
  await ready;
  setObjectStoreClientForTests(s3);
  s3.objects.clear();
  s3.reads = [];
  s3.failures = 0;
  files = new Map();
  ledger = new Map();
  await pg.exec(`DELETE FROM binary_documents; DELETE FROM source_lane_journal;`);
});

describe("binary lane: exact bytes", () => {
  it("exports non-UTF-8 PDF bytes exactly, with metadata and an immutable version file", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x0a]);
    const r = await intake({ externalId: "drive-file-1", bytes, versionRef: "rev-1" });
    expect(r.status).toBe("stored");
    expect(await drain()).toEqual({ errors: [] });
    const base = "sources/binary/drive-pdf/drive-file-1";
    expect(under(base)).toEqual([`${base}/current.pdf`, `${base}/meta.json`, expect.stringMatching(new RegExp(`^${base}/versions/\\d{8}T\\d{6}Z-${sha(bytes).slice(0, 16)}\\.pdf$`))]);
    const current = files.get(`${base}/current.pdf`)!;
    expect(current.bytes.equals(bytes)).toBe(true);
    expect(current.put).toMatchObject({ kind: "binary", contentType: "application/pdf", sourceVersion: { ref: "rev-1" } });
    expect(current.put.chunked).toMatchObject({ sha256: sha(bytes), size: bytes.length });
    const meta = JSON.parse(files.get(`${base}/meta.json`)!.bytes.toString("utf8"));
    expect(meta).toMatchObject({ provider: "drive-pdf", sha256: sha(bytes), sizeBytes: bytes.length, parseStatus: "pending", textExtraction: "not performed by the source-only runtime", bytes: { state: "exported", chunks: 1 }, sourceAcl: { fileId: "drive-file-1" } });
    expect(files.get(under(`${base}/versions/`)[0]!)!.bytes.equals(bytes)).toBe(true);
  });

  it("exports an empty upload as a zero-byte file", async () => {
    await intake({ externalId: "empty-note", bytes: Buffer.alloc(0), mimeType: "text/plain", provider: "upload" });
    expect(await drain()).toEqual({ errors: [] });
    const f = files.get("sources/binary/upload/empty-note/current.txt")!;
    expect(f.bytes.length).toBe(0);
    expect(f.put.chunked).toMatchObject({ sha256: sha(Buffer.alloc(0)), size: 0, chunks: [] });
  });

  it("streams a >8 MiB object in bounded ranges and publishes its chunks exactly", async () => {
    const bytes = Buffer.alloc(2 * BINARY_CHUNK_BYTES + 3);
    for (let i = 0; i < bytes.length; i += 997) bytes[i] = (i * 31) & 0xff;
    await intake({ externalId: "big", bytes, versionRef: "v9" });
    expect(await drain()).toEqual({ errors: [] });
    expect(Math.max(...s3.reads.map((r) => r.bytes))).toBeLessThanOrEqual(BINARY_CHUNK_BYTES);
    const put = files.get("sources/binary/drive-pdf/big/current.pdf")!.put;
    expect(put.chunked!.chunks.map((c) => c.size)).toEqual([BINARY_CHUNK_BYTES, BINARY_CHUNK_BYTES, 3]);

    const uploaded: Buffer[] = [];
    const client = new SourcePublishClient("http://127.0.0.1:1", "psb_x", (async (_url: URL | string, init?: RequestInit) => {
      uploaded.push(Buffer.from(String(init!.body), "base64"));
      return new Response("{}", { status: 201 });
    }) as typeof fetch);
    const wire = await client.preparePutChunked({ op: "put", path: put.path, kind: "binary", contentType: put.contentType, capturedAt: String(put.capturedAt), sourceUpdatedAt: null }, put.chunked!);
    expect(Buffer.concat(uploaded).equals(bytes)).toBe(true);
    expect(wire).toMatchObject({ sha256: sha(bytes), size: bytes.length });
  });

  it("reads exact inclusive ranges and refuses a chunk whose stored bytes changed", async () => {
    const bytes = Buffer.from("0123456789abcdef");
    await intake({ externalId: "ranged", bytes, mimeType: "text/plain", provider: "upload" });
    const key = `binary/${T}/${sha(bytes)}`;
    expect((await getObjectRange(key, 3, 6)).toString()).toBe("3456");
    await expect(getObjectRange(key, 10, 40)).rejects.toThrow(/returned 6 bytes, expected 31/);
    await drain();
    const put = files.get("sources/binary/upload/ranged/current.txt")!.put;
    s3.objects.set(key, Buffer.from("0123456789abcdeX"));
    await expect(put.chunked!.load(put.chunked!.chunks[0]!.sha256)).rejects.toThrow(/changed in the object store/);
  });
});

describe("binary lane: retries, history, deletion", () => {
  it("leaves a transient object-store failure in the journal, then exports on retry without re-scanning", async () => {
    const bytes = Buffer.from("%PDF-retry");
    await intake({ externalId: "flaky", bytes });
    s3.failures = 2;
    const first = await drain();
    expect(first.errors.length).toBeGreaterThan(0);
    expect(first.errors[0]).toMatch(/SlowDown/);
    expect(files.has("sources/binary/drive-pdf/flaky/current.pdf")).toBe(false);
    expect((await binaryCoverage({ tenantId: T, executor: db as never }))[0]).toMatchObject({ state: "partial" });
    const [v] = await query<{ manifest_error: string; manifest_attempts: number }>(`SELECT manifest_error, manifest_attempts FROM binary_document_versions WHERE external_id = 'flaky'`);
    expect(v!.manifest_error).toMatch(/^transient: /);

    expect(await drain()).toEqual({ errors: [] });
    expect(files.get("sources/binary/drive-pdf/flaky/current.pdf")!.bytes.equals(bytes)).toBe(true);
    expect(await query(`SELECT 1 FROM source_lane_journal`)).toEqual([]);
    expect((await binaryCoverage({ tenantId: T, executor: db as never }))[0]).toMatchObject({ state: "complete", counts: { stored: 1, refused: 0 } });

    // Metadata-only change: re-journaled, but the checkpointed manifest is reused (only the publish load reads).
    s3.reads = [];
    await query(`UPDATE binary_documents SET parse_status = 'parsed' WHERE external_id = 'flaky'`);
    expect(await drain()).toEqual({ errors: [] });
    expect(s3.reads).toHaveLength(1);
    expect(JSON.parse(files.get("sources/binary/drive-pdf/flaky/meta.json")!.bytes.toString()).parseStatus).toBe("parsed");
  });

  it("keeps every replaced byte state as history, withdraws everything on tombstone and restores on recapture", async () => {
    const v1 = Buffer.from("%PDF-1 first");
    const v2 = Buffer.from("%PDF-1 second, longer");
    await intake({ externalId: "doc", bytes: v1, versionRef: "1" });
    await drain();
    await query(`UPDATE binary_document_versions SET captured_at = captured_at - interval '1 hour'`);
    await drain();
    expect((await intake({ externalId: "doc", bytes: v1, versionRef: "1" })).status).toBe("skipped");
    await intake({ externalId: "doc", bytes: v2, versionRef: "2" });
    expect(await drain()).toEqual({ errors: [] });
    const base = "sources/binary/drive-pdf/doc";
    expect(files.get(`${base}/current.pdf`)!.bytes.equals(v2)).toBe(true);
    const history = under(`${base}/versions/`);
    expect(history).toHaveLength(2);
    expect(history.map((p) => files.get(p)!.bytes.toString())).toEqual([v1.toString(), v2.toString()]);

    expect(await tombstoneBinaryDocument({ tenantId: T, provider: "drive-pdf", externalId: "doc", executor: db as never })).toBe(1);
    expect(await drain()).toEqual({ errors: [] });
    expect(under(base)).toEqual([]);
    expect(new Set(lastDeletes.map((d) => d.op === "delete" && d.reason))).toEqual(new Set(["binary_tombstoned"]));

    await intake({ externalId: "doc", bytes: v2, versionRef: "2b" });
    expect(await drain()).toEqual({ errors: [] });
    expect(under(base)).toHaveLength(4);
    expect(files.get(`${base}/current.pdf`)!.bytes.equals(v2)).toBe(true);
  });

  it("deletes every exported path when the donor row is purged", async () => {
    await intake({ externalId: "gone", bytes: Buffer.from("%PDF-gone") });
    await drain();
    expect(under("sources/binary/drive-pdf/gone")).toHaveLength(3);
    await query(`DELETE FROM binary_documents WHERE external_id = 'gone'`);
    expect(await drain()).toEqual({ errors: [] });
    expect(under("sources/binary/drive-pdf/gone")).toEqual([]);
    expect(lastDeletes.every((d) => d.op === "delete" && d.reason === "binary_row_deleted")).toBe(true);
  });
});

describe("binary lane: scope and integrity", () => {
  it("never reads another tenant's object through a forged storage_key", async () => {
    const theirs = Buffer.from("%PDF-other tenant secret");
    await intake({ externalId: "theirs", bytes: theirs, tenantId: "tenant-binary-b" });
    await intake({ externalId: "mine", bytes: Buffer.from("%PDF-mine") });
    await query(`UPDATE binary_documents SET sha256 = $1, storage_key = $2, size_bytes = $3 WHERE tenant_id = $4 AND external_id = 'mine'`,
      [sha(theirs), `binary/tenant-binary-b/${sha(theirs)}`, theirs.length, T]);
    s3.reads = [];
    expect(await drain()).toEqual({ errors: [] });
    expect(s3.reads.filter((r) => r.key.includes("tenant-binary-b"))).toEqual([]);
    expect(files.has("sources/binary/drive-pdf/mine/current.pdf")).toBe(false);
    expect([...files.values()].some((f) => f.bytes.equals(theirs))).toBe(false);
    expect(JSON.parse(files.get("sources/binary/drive-pdf/mine/meta.json")!.bytes.toString()).bytes).toEqual({ state: "refused", reason: "storage_key_not_tenant_scoped" });
    const cov = await binaryCoverage({ tenantId: T, executor: db as never });
    expect(cov[0]).toMatchObject({ state: "partial", counts: { refused: 1 } });
    // The other tenant's rows are invisible to this tenant's mappers.
    const [other] = await query<{ id: string }>(`SELECT id::text FROM binary_documents WHERE tenant_id = 'tenant-binary-b'`);
    expect(await docsExport.map({ tenantId: T, executor: db as never }, other!.id, { op: "INSERT", enqueuedAt: new Date().toISOString() }, [])).toEqual([]);
  });

  it("refuses objects that are missing or do not match the recorded size / sha256", async () => {
    const a = Buffer.from("%PDF-a");
    const b = Buffer.from("%PDF-b");
    await intake({ externalId: "missing", bytes: a });
    await intake({ externalId: "tampered", bytes: b });
    s3.objects.delete(`binary/${T}/${sha(a)}`);
    s3.objects.set(`binary/${T}/${sha(b)}`, Buffer.from("%PDF-X"));
    expect(await drain()).toEqual({ errors: [] });
    const state = (id: string) => JSON.parse(files.get(`sources/binary/drive-pdf/${id}/meta.json`)!.bytes.toString()).bytes;
    expect(state("missing")).toEqual({ state: "refused", reason: "object_missing" });
    expect(state("tampered")).toEqual({ state: "refused", reason: "sha256_mismatch" });
    expect(under("sources/binary/drive-pdf/").filter((p) => !p.endsWith("meta.json"))).toEqual([]);
  });

  it("leaves Gmail attachments and Slack files to their own lanes and records fetch failures metadata-only", async () => {
    await intake({ externalId: "msg-1:part-2", bytes: Buffer.from("x"), provider: "gmail-attachment", mimeType: "image/png" });
    await intake({ externalId: "F123", bytes: Buffer.from("y"), provider: "slack", mimeType: "image/png" });
    await intakeBinaryDocument({ tenantId: T, provider: "drive-pdf", externalId: "unfetchable", mimeType: "application/pdf", fetchBytes: async () => { throw new Error("403"); }, executor: db as never });
    expect(await drain()).toEqual({ errors: [] });
    expect([...files.keys()]).toEqual(["sources/binary/drive-pdf/unfetchable/meta.json"]);
    const cov = await binaryCoverage({ tenantId: T, executor: db as never });
    expect(cov).toEqual([expect.objectContaining({ scope: "provider:drive-pdf", state: "partial", reason: expect.stringMatching(/1 fetch failure/) })]);
  });

  it("is registered, reports pending with no captures, and owns its journal tables", async () => {
    expect(await binaryCoverage({ tenantId: T, executor: db as never })).toEqual([expect.objectContaining({ state: "pending" })]);
    const registry = new SourceProviderRegistry(SOURCE_PROVIDERS);
    expect(registry.extraTable("binary_documents")?.provider.id).toBe("binary");
    expect(registry.extraTable("binary_document_versions")?.provider.id).toBe("binary");
  });
});
