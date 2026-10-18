/**
 * Coordinator regression (google-docs patch request 3): a stored multi-chunk
 * `gdocs_source_file_versions` row is exported as its stored chunk list, loaded
 * chunk by chunk, never re-materialised as one Buffer.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { db, query, ready, resetTenant } from "./harness.js";
import { versionRowToChange } from "../../../../src/source-lane/providers/google-docs/export-map.js";
import { getVersionRow, putSourceFile, SOURCE_CHUNK_BYTES, type SqlDatabase } from "../../../../src/source-lane/providers/google-docs/store.js";
import { SourcePublishClient } from "../../../../src/source-lane/export/publish-client.js";

const T = "tenant-gdocs-chunks";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  await ready;
  await resetTenant(T);
});

describe("google-docs export: chunk passthrough", () => {
  it("passes a 9 MiB stored file to the publisher as its two stored chunks", async () => {
    const bytes = Buffer.alloc(SOURCE_CHUNK_BYTES + 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) & 0xff;
    const path = "sources/google-docs/drive/f1/content.bin";
    const deps = { db: db as unknown as SqlDatabase };
    expect(await putSourceFile({ tenantId: T, path, fileId: "f1", kind: "binary", contentType: "application/octet-stream", bytes, sourceVersion: "7", sourceOrder: 7 }, deps)).toBe("created");
    const [{ id }] = await query<{ id: string }>(`SELECT id::text FROM gdocs_source_file_versions WHERE tenant_id = $1 AND path = $2`, [T, path]);
    const row = (await getVersionRow(T, id, deps))!;
    expect(row.chunks).toHaveLength(2);

    const change = await versionRowToChange(row, { tenantId: T, executor: db as never });
    expect(change.op).toBe("put");
    if (change.op !== "put") return;
    expect(change.content.length).toBe(0);
    expect(change.chunked).toMatchObject({ sha256: sha(bytes), size: bytes.length });
    expect(change.chunked!.chunks.map((c) => c.sha256)).toEqual(row.chunks);

    const uploaded: string[] = [];
    const client = new SourcePublishClient("http://127.0.0.1:1", "psb_x", (async (url: URL | string, init?: RequestInit) => {
      const body = Buffer.from(String(init!.body), "base64");
      uploaded.push(sha(body));
      expect(String(url)).toContain(sha(body));
      return new Response("{}", { status: 201 });
    }) as typeof fetch);
    const wire = await client.preparePutChunked({ op: "put", path, kind: "binary", contentType: change.contentType, capturedAt: String(change.capturedAt), sourceUpdatedAt: null }, change.chunked!);
    expect(uploaded).toEqual(row.chunks);
    expect(wire).toMatchObject({ sha256: sha(bytes), size: bytes.length, chunks: row.chunks });
  });
});
