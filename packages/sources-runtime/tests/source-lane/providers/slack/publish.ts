/**
 * Minimal yc_msaw publish endpoint for Slack lane export tests: applies the exporter's real wire
 * protocol (chunk uploads + batches), verifies every sha256, and keeps every version per path so
 * tests can check that deletes are tombstones over retained history. Synthetic data only.
 */
import { createHash } from "node:crypto";

export interface PublishedVersion {
  op: "put" | "delete";
  bytes?: Buffer;
  kind?: string;
  contentType?: string;
  reason?: string;
  sourceVersion?: { ref: string; ordinal?: number };
  provenance?: Record<string, unknown>;
}

export class FakePublishStore {
  readonly blobs = new Map<string, Buffer>();
  readonly versions = new Map<string, PublishedVersion[]>();
  readonly statusReports: Array<{ providers: Array<Record<string, unknown>> }> = [];

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
        const list = this.versions.get(c.path) ?? [];
        const current = list.at(-1);
        if (c.op === "delete") {
          if (!current || current.op === "delete") return { path: c.path, outcome: "absent", versionId: null };
          list.push({ op: "delete", reason: c.reason });
          this.versions.set(c.path, list);
          return { path: c.path, outcome: "deleted", versionId: `v${list.length}` };
        }
        const bytes = c.inline !== undefined ? Buffer.from(c.inline, "base64") : Buffer.concat((c.chunks as string[]).map((s) => this.blobs.get(s)!));
        if (bytes.length !== c.size || createHash("sha256").update(bytes).digest("hex") !== c.sha256) throw new Error(`bad put for ${c.path}`);
        if (current?.op === "put" && current.bytes!.equals(bytes) && current.kind === c.kind) return { path: c.path, outcome: "unchanged", versionId: `v${list.length}` };
        list.push({ op: "put", bytes, kind: c.kind, contentType: c.contentType, sourceVersion: c.sourceVersion, provenance: c.provenance });
        this.versions.set(c.path, list);
        return { path: c.path, outcome: list.length > 1 ? "updated" : "created", versionId: `v${list.length}` };
      });
      return Response.json({ batchId, commitId: `c-${batchId}`, seq: 1, results });
    }
    if (url.pathname === "/v1/sources/status-report") {
      this.statusReports.push(JSON.parse(body));
      return Response.json({ ok: true });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };

  current(path: string): PublishedVersion | undefined {
    const v = this.versions.get(path)?.at(-1);
    return v?.op === "put" ? v : undefined;
  }

  live(prefix = ""): string[] {
    return [...this.versions.keys()].filter((p) => p.startsWith(prefix) && this.current(p)).sort();
  }

  json<T = any>(path: string): T {
    const v = this.current(path);
    if (!v) throw new Error(`no live file ${path}; have:\n${this.live().join("\n")}`);
    return JSON.parse(v.bytes!.toString("utf8")) as T;
  }
}

export function bindingToken(tenantId: string): string {
  return `psb_${tenantId}.sb-0123456789abcdef.${"A".repeat(43)}`;
}
