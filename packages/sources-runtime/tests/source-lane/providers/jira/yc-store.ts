/**
 * Publish target for Jira lane tests: applies the exporter's wire protocol to the
 * REAL yc_msaw SourceStore (src/sources/store.ts on a DirectoryObjectStore), so
 * ordering guards, tombstones and history are production semantics.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const YC_ROOT = resolve(here, "../../../../../..");

async function importYc(rel: string): Promise<any> {
  return import(pathToFileURL(join(YC_ROOT, rel)).href);
}

export function bindingToken(tenantId: string): string {
  return `psb_${tenantId}.sb-0123456789abcdef.${"A".repeat(43)}`;
}

export interface StoredFile {
  path: string;
  kind: string;
  bytes: Buffer;
  contentType: string | null;
  versionRef: string | null;
  provenance: Record<string, unknown>;
}

export class YcStore {
  readonly results: Array<{ path: string; outcome: string; reason?: string }> = [];

  private constructor(readonly store: any) {}

  static async create(ns: string): Promise<YcStore> {
    const { SourceStore } = await importYc("src/sources/store.ts");
    const { DirectoryObjectStore } = await importYc("src/store/objects.ts");
    const dir = mkdtempSync(join(os.tmpdir(), "jira-yc-"));
    return new YcStore(new SourceStore(new DirectoryObjectStore(dir), ns));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    try {
      const blob = /^\/v1\/sources\/blobs\/([0-9a-f]{64})$/u.exec(url.pathname);
      if (blob && init?.method === "PUT") return Response.json({ ...(await this.store.putBlob(Buffer.from(body, "base64"), blob[1])), stored: true });
      if (url.pathname === "/v1/sources/publish") {
        const batch = JSON.parse(body);
        const receipt = await this.store.applyBatch({ bindingId: "sb-0123456789abcdef", providers: ["*"] }, batch);
        for (const r of receipt.results) {
          const change = batch.changes.find((c: any) => c.path === r.path);
          this.results.push({ path: r.path, outcome: r.outcome, ...(change?.op === "delete" ? { reason: change.reason } : {}) });
        }
        return Response.json(receipt);
      }
      if (url.pathname === "/v1/sources/status-report") return Response.json({ ok: true });
    } catch (error: any) {
      if (error?.code === "missing_blobs") return Response.json({ error: { code: "missing_blobs", message: error.message, ...(error.details ?? {}) } }, { status: 409 });
      return Response.json({ error: { code: error?.code ?? "error", message: String(error?.message ?? error) } }, { status: 400 });
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  };

  /** Live file at a wire path (`sources/...`), or null when absent or tombstoned. */
  async file(path: string): Promise<StoredFile | null> {
    const r = await this.store.resolve(path.replace(/^sources\//u, ""));
    if (!r || r.type !== "file" || r.entry.t !== "f") return null;
    const v = await this.store.version(r.entry.v);
    return { path, kind: r.entry.kind, bytes: await this.store.readRange(v, 0, v.size), contentType: r.entry.contentType, versionRef: r.entry.versionRef ?? null, provenance: v.provenance ?? {} };
  }

  async text(path: string): Promise<string> {
    const f = await this.file(path);
    if (!f) throw new Error(`no live file ${path}; have:\n${(await this.paths()).join("\n")}`);
    return f.bytes.toString("utf8");
  }

  async json(path: string): Promise<any> {
    return JSON.parse(await this.text(path));
  }

  /** Tombstoned entry (`x`) at a path: its deletion reason. */
  async tombstone(path: string): Promise<{ reason: string; at: string } | null> {
    const r = await this.store.resolve(path.replace(/^sources\//u, ""));
    if (!r || r.type !== "file" || r.entry.t !== "x") return null;
    const v = await this.store.version(r.entry.v);
    return { reason: v.deleted?.reason ?? "", at: v.deleted?.at ?? "" };
  }

  async paths(prefix = "sources/jira"): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const item of this.store.walk(prefix.replace(/^sources\/?/u, ""))) if (item.entry.t === "f") out.push(`sources/${item.path}`);
    } catch (error: any) {
      if (error?.code === "not_found") return [];
      throw error;
    }
    return out.sort();
  }

  /** Every byte the store holds for a namespace (file bytes + provenance), for secret scans. */
  async allText(): Promise<string> {
    const parts: string[] = [];
    for (const p of await this.paths("sources")) {
      const f = (await this.file(p))!;
      parts.push(p, f.bytes.toString("latin1"), JSON.stringify(f.provenance));
    }
    return parts.join("\n");
  }
}
