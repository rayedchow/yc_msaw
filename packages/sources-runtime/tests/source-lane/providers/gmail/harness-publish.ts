/**
 * Fake yc_msaw publish endpoint for Gmail lane tests: applies the exporter's real wire protocol
 * (chunk uploads + batches) to an in-memory file tree, verifying every sha256. Synthetic only.
 */
import { createHash } from "node:crypto";

export interface PublishedFile {
  bytes: Buffer;
  kind: string;
  contentType: string;
  provenance: Record<string, unknown> | undefined;
  sourceVersion: { ref: string; ordinal?: number } | undefined;
  capturedAt: string;
}

/** Minimal yc_msaw publish endpoint: blobs + batches applied to one in-memory tree per binding token. */
export class FakePublishStore {
  readonly blobs = new Map<string, Buffer>();
  readonly files = new Map<string, PublishedFile>();
  readonly deleted = new Map<string, { reason: string; deletedAt: string }>();
  readonly history: Array<{ path: string; op: "put" | "delete"; reason?: string }> = [];
  readonly statusReports: unknown[] = [];
  #seq = 0;

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const blob = /^\/v1\/sources\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);
    if (blob && init?.method === "PUT") {
      const bytes = Buffer.from(body, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== blob[1]) return Response.json({ error: { code: "sha_mismatch" } }, { status: 400 });
      this.blobs.set(blob[1]!, bytes);
      return Response.json({ sha256: blob[1], size: bytes.length, stored: true });
    }
    if (url.pathname === "/v1/sources/publish") {
      const { batchId, changes } = JSON.parse(body) as { batchId: string; changes: Array<Record<string, any>> };
      const missing = changes.flatMap((c) => (c.op === "put" && c.chunks ? c.chunks.filter((s: string) => !this.blobs.has(s)) : []));
      if (missing.length) return Response.json({ error: { code: "missing_blobs", message: "missing", missing } }, { status: 409 });
      const results = changes.map((c) => {
        if (c.op === "delete") {
          const had = this.files.delete(c.path);
          if (had) {
            this.deleted.set(c.path, { reason: c.reason, deletedAt: c.deletedAt });
            this.history.push({ path: c.path, op: "delete", reason: c.reason });
          }
          return { path: c.path, outcome: had ? "deleted" : "absent", versionId: null };
        }
        const bytes = c.inline !== undefined ? Buffer.from(c.inline, "base64") : Buffer.concat((c.chunks as string[]).map((s) => this.blobs.get(s)!));
        if (bytes.length !== c.size || createHash("sha256").update(bytes).digest("hex") !== c.sha256) throw new Error(`bad put for ${c.path}`);
        const prev = this.files.get(c.path);
        const same = prev && prev.bytes.equals(bytes) && prev.kind === c.kind;
        this.files.set(c.path, { bytes, kind: c.kind, contentType: c.contentType, provenance: c.provenance, sourceVersion: c.sourceVersion, capturedAt: c.capturedAt });
        this.deleted.delete(c.path);
        if (!same) this.history.push({ path: c.path, op: "put" });
        return { path: c.path, outcome: same ? "unchanged" : prev ? "updated" : "created", versionId: `v${++this.#seq}` };
      });
      return Response.json({ batchId, commitId: `c${this.#seq}`, seq: this.#seq, results });
    }
    if (url.pathname === "/v1/sources/status-report") {
      this.statusReports.push(JSON.parse(body));
      return Response.json({ ok: true });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };

  paths(prefix = ""): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  text(path: string): string {
    const f = this.files.get(path);
    if (!f) throw new Error(`no published file ${path}; have:\n${this.paths().join("\n")}`);
    return f.bytes.toString("utf8");
  }

  json<T = any>(path: string): T {
    return JSON.parse(this.text(path)) as T;
  }

  find(re: RegExp): string[] {
    return this.paths().filter((p) => re.test(p));
  }
}

export function bindingToken(tenantId: string): string {
  return `psb_${tenantId}.sb-0123456789abcdef.${"A".repeat(43)}`;
}
