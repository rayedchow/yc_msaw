import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { intakeBinaryDocument, tombstoneBinaryDocument, type BinaryDocumentParseStatus, type BinaryDocumentProvider } from "../../../src/integrations/binary/intake.js";

interface FakeBinaryRow {
  id: string;
  tenant_id: string;
  provider: BinaryDocumentProvider;
  external_id: string;
  sha256: string | null;
  mime_type: string;
  size_bytes: number | null;
  storage_key: string | null;
  version_ref: string | null;
  source_updated_at: Date | null;
  author_email: string | null;
  source_acl: Record<string, unknown>;
  parse_status: BinaryDocumentParseStatus;
  tombstoned_at: Date | null;
}

class FakeBinaryExecutor {
  rows = new Map<string, FakeBinaryRow>();
  nextId = 1;

  async execute(query: unknown): Promise<unknown> {
    const parts = sqlParts(query).join(" ");
    const params = sqlParams(query);
    if (parts.includes("SELECT id, sha256, storage_key, version_ref, parse_status, size_bytes")) {
      const [tenantId, provider, externalId] = params as [string, "drive-pdf" | "upload", string];
      const row = this.rows.get(key(tenantId, provider, externalId));
      return row ? [row] : [];
    }
    if (parts.includes("INSERT INTO binary_documents")) {
      const [
        tenantId,
        provider,
        externalId,
        sha256,
        mimeType,
        sizeBytes,
        storageKey,
        versionRef,
        sourceUpdatedAt,
        authorEmail,
        sourceAclJson,
        parseStatus,
      ] = params as [
        string,
        "drive-pdf" | "upload",
        string,
        string | null,
        string,
        number | null,
        string | null,
        string | null,
        Date | null,
        string | null,
        string,
        BinaryDocumentParseStatus,
      ];
      const rowKey = key(tenantId, provider, externalId);
      const existing = this.rows.get(rowKey);
      const row: FakeBinaryRow = {
        id: existing?.id ?? `bd-${this.nextId++}`,
        tenant_id: tenantId,
        provider,
        external_id: externalId,
        sha256,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        storage_key: storageKey,
        version_ref: versionRef,
        source_updated_at: sourceUpdatedAt,
        author_email: authorEmail,
        source_acl: JSON.parse(sourceAclJson) as Record<string, unknown>,
        parse_status: parseStatus,
        tombstoned_at: null,
      };
      this.rows.set(rowKey, row);
      return [{ id: row.id }];
    }
    if (parts.includes("UPDATE binary_documents") && parts.includes("SET tombstoned_at")) {
      const [tenantId, provider, externalId] = params as [string, "drive-pdf" | "upload", string];
      const row = this.rows.get(key(tenantId, provider, externalId));
      if (!row || row.tombstoned_at) return [];
      row.tombstoned_at = new Date("2026-07-01T00:00:00Z");
      return [{ id: row.id }];
    }
    throw new Error(`Unhandled SQL in fake executor: ${parts}`);
  }
}

describe("intakeBinaryDocument", () => {
  let executor: FakeBinaryExecutor;
  let putObjectMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    executor = new FakeBinaryExecutor();
    putObjectMock = vi.fn(async ({ tenantId, sha256 }: { tenantId: string; sha256: string }) => `binary/${tenantId}/${sha256}`);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("skips fetch when the stored version_ref is equal", async () => {
    executor.rows.set(key("t1", "drive-pdf", "file-1"), {
      id: "bd-existing",
      tenant_id: "t1",
      provider: "drive-pdf",
      external_id: "file-1",
      sha256: "sha-old",
      mime_type: "application/pdf",
      size_bytes: 10,
      storage_key: "binary/t1/sha-old",
      version_ref: "md5-1",
      source_updated_at: null,
      author_email: null,
      source_acl: {},
      parse_status: "pending",
      tombstoned_at: null,
    });
    const fetchBytes = vi.fn(async () => Buffer.from("new bytes"));

    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "drive-pdf",
      externalId: "file-1",
      fetchBytes,
      mimeType: "application/pdf",
      versionRef: "md5-1",
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result).toMatchObject({ status: "skipped", id: "bd-existing" });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
  });

  it("stores new PDF bytes through the injected object store", async () => {
    const bytes = Buffer.from("%PDF-1.7\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "drive-pdf",
      externalId: "file-2",
      fetchBytes: async () => bytes,
      mimeType: "application/pdf",
      versionRef: "md5-2",
      sourceUpdatedAt: "2026-07-01T12:00:00Z",
      authorEmail: "author@example.com",
      sourceAcl: { provider: "drive-pdf", fileId: "file-2", webContentLink: "https://drive/download" },
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result).toMatchObject({
      status: "stored",
      sha256,
      storageKey: `binary/t1/${sha256}`,
      sizeBytes: bytes.byteLength,
    });
    expect(putObjectMock).toHaveBeenCalledWith({
      tenantId: "t1",
      sha256,
      bytes,
      contentType: "application/pdf",
    });
    const row = executor.rows.get(key("t1", "drive-pdf", "file-2"));
    expect(row).toMatchObject({
      sha256,
      storage_key: `binary/t1/${sha256}`,
      parse_status: "pending",
      author_email: "author@example.com",
    });
    expect(row?.source_acl).toEqual({ provider: "drive-pdf", fileId: "file-2" });
  });

  it("records non-PDF input as failed_unsupported without fetching bytes", async () => {
    const fetchBytes = vi.fn(async () => Buffer.from("not a pdf"));

    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "drive-pdf",
      externalId: "file-3",
      fetchBytes,
      mimeType: "text/plain",
      versionRef: "v3",
      sourceAcl: [{ role: "reader" }],
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result.status).toBe("failed_unsupported");
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(putObjectMock).not.toHaveBeenCalled();
    const row = executor.rows.get(key("t1", "drive-pdf", "file-3"));
    expect(row).toMatchObject({
      sha256: null,
      storage_key: null,
      parse_status: "failed_unsupported",
      mime_type: "text/plain",
    });
    expect(row?.source_acl).toEqual({ permissions: [{ role: "reader" }] });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("stores non-PDF bytes as parse_status 'stored' when acceptAnyMimeType is set (Slack lane)", async () => {
    const bytes = Buffer.from("plain text attachment");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "slack",
      externalId: "F123",
      fetchBytes: async () => bytes,
      mimeType: "text/plain",
      acceptAnyMimeType: true,
      versionRef: "F123:1800000000",
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result).toMatchObject({ status: "stored", sha256, sizeBytes: bytes.byteLength });
    expect(putObjectMock).toHaveBeenCalledWith({
      tenantId: "t1",
      sha256,
      bytes,
      contentType: "text/plain",
    });
    expect(executor.rows.get(key("t1", "slack", "F123"))).toMatchObject({
      provider: "slack",
      mime_type: "text/plain",
      parse_status: "stored",
      storage_key: `binary/t1/${sha256}`,
    });
  });

  it("keeps PDF bytes on the parse pipeline (parse_status 'pending') even with acceptAnyMimeType", async () => {
    const bytes = Buffer.from("%PDF-1.7\n");

    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "slack",
      externalId: "F-pdf",
      fetchBytes: async () => bytes,
      mimeType: "application/pdf",
      acceptAnyMimeType: true,
      versionRef: "F-pdf:1",
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result.status).toBe("stored");
    expect(executor.rows.get(key("t1", "slack", "F-pdf"))).toMatchObject({
      parse_status: "pending",
    });
  });

  it("stores non-PDF bytes for providers with a wider mime allowlist (gmail attachments)", async () => {
    const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const bytes = Buffer.from("PK docx bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "gmail-attachment",
      externalId: "msg-1:2",
      fetchBytes: async () => bytes,
      mimeType: docxMime,
      versionRef: "gmail:msg-1:2",
      authorEmail: "alice@example.com",
      sourceAcl: { provider: "gmail-attachment", gmailId: "msg-1", partId: "2", filename: "notes.docx" },
      supportedMimeTypes: new Set(["application/pdf", docxMime]),
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result).toMatchObject({ status: "stored", sha256, sizeBytes: bytes.byteLength });
    // Object store receives the REAL content type, not a hardcoded PDF one.
    expect(putObjectMock).toHaveBeenCalledWith({
      tenantId: "t1",
      sha256,
      bytes,
      contentType: docxMime,
    });
    expect(executor.rows.get(key("t1", "gmail-attachment", "msg-1:2"))).toMatchObject({
      mime_type: docxMime,
      parse_status: "stored",
      author_email: "alice@example.com",
    });
  });

  it("keeps the default lane PDF-only: mimes outside the caller's set are failed_unsupported", async () => {
    const fetchBytes = vi.fn(async () => Buffer.from("zip"));

    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "gmail-attachment",
      externalId: "msg-1:3",
      fetchBytes,
      mimeType: "application/zip",
      versionRef: "gmail:msg-1:3",
      supportedMimeTypes: new Set(["application/pdf"]),
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result.status).toBe("failed_unsupported");
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(executor.rows.get(key("t1", "gmail-attachment", "msg-1:3"))).toMatchObject({
      sha256: null,
      storage_key: null,
      parse_status: "failed_unsupported",
      mime_type: "application/zip",
    });
  });
  it("records fetch failures as failed_fetch without storing bytes", async () => {
    const result = await intakeBinaryDocument({
      tenantId: "t1",
      provider: "drive-pdf",
      externalId: "file-4",
      fetchBytes: async () => {
        throw new Error("download failed");
      },
      mimeType: "application/pdf",
      versionRef: "v4",
      executor,
      objectStore: { putObject: putObjectMock },
    });

    expect(result.status).toBe("failed_fetch");
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(executor.rows.get(key("t1", "drive-pdf", "file-4"))).toMatchObject({
      sha256: null,
      storage_key: null,
      parse_status: "failed_fetch",
    });
  });

  it("tombstones an existing Drive PDF row for a removed change", async () => {
    await intakeBinaryDocument({
      tenantId: "t1",
      provider: "drive-pdf",
      externalId: "file-5",
      fetchBytes: async () => Buffer.from("%PDF\n"),
      mimeType: "application/pdf",
      versionRef: "v5",
      executor,
      objectStore: { putObject: putObjectMock },
    });

    const count = await tombstoneBinaryDocument({
      tenantId: "t1",
      provider: "drive-pdf",
      externalId: "file-5",
      executor,
    });

    expect(count).toBe(1);
    expect(executor.rows.get(key("t1", "drive-pdf", "file-5"))?.tombstoned_at).toBeInstanceOf(Date);
  });
});

function key(tenantId: string, provider: string, externalId: string): string {
  return `${tenantId}:${provider}:${externalId}`;
}

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function sqlParams(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return [chunk];
    if (chunk instanceof Date) return [chunk];
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk);
    if (Array.isArray(chunk.value)) return [];
    if ("value" in chunk) return [chunk.value];
    return [];
  });
}
