import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceViewer } from "../src/sources/access.js";
import { SourceFs } from "../src/sources/fs.js";
import { SourceService } from "../src/sources/service.js";
import { SourceStore } from "../src/sources/store.js";
import { CachedObjectStore, DirectoryObjectStore, type ObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/**
 * perf-verification: on the hosted store every ObjectStore call is a remote round trip (Modal function call), so
 * publish, walks and grep must batch their immutable-object I/O instead of issuing one call per file. Counts the
 * calls that reach the authority behind the production CachedObjectStore, on a cold replica (empty local cache).
 */
class Counting implements ObjectStore {
  readonly kind = "counting";
  calls = { put: 0, get: 0, getRef: 0 };
  constructor(readonly inner: ObjectStore) {}
  put(ns: string, o: Parameters<ObjectStore["put"]>[1]) { this.calls.put++; return this.inner.put(ns, o); }
  get(ns: string, k: string[]) { this.calls.get++; return this.inner.get(ns, k); }
  list(ns: string, p: string, o?: { after?: string; limit?: number }) { return this.inner.list(ns, p, o); }
  getRef(ns: string, n: string) { this.calls.getRef++; return this.inner.getRef(ns, n); }
  casRef(ns: string, n: string, v: number | null, value: unknown) { return this.inner.casRef(ns, n, v, value); }
  reset() { this.calls = { put: 0, get: 0, getRef: 0 }; }
}

const NS = "t-batched-io";
const MSGS = 600;
let dir: string;
let authority: Counting;
const viewer = new SourceViewer({ subject: "user_alice", issuer: "https://issuer.test" }, { providerOwners: new Map(), googleAccounts: [{ account: "alice@acme.test", subject: "user_alice", issuer: "https://issuer.test" }] });
const put = (p: string, body: string) => {
  const bytes = Buffer.from(body);
  return { op: "put" as const, path: p, kind: "projection" as const, contentType: "text/markdown", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt: new Date(Date.now() - 60_000).toISOString() };
};
const coldFs = () => new SourceFs(new SourceService(new CachedObjectStore(authority, new DirectoryObjectStore(path.join(dir, `cache-${Math.random().toString(36).slice(2)}`)))));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-batched-io-"));
  authority = new Counting(new DirectoryObjectStore(path.join(dir, "authority")));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("batched object-store I/O on a cold replica", () => {
  it("publishes a batch of inline changes with one put, not one per change", async () => {
    const store = new SourceStore(new CachedObjectStore(authority, new DirectoryObjectStore(path.join(dir, "pub-cache"))), NS);
    const changes = Array.from({ length: MSGS }, (_, i) => put(`sources/gmail/alice@acme.test/messages/2026-07/m${i}/message.md`, `mail ${i}\nneedle-${i}\n`));
    authority.reset();
    const r = await store.applyBatch({ bindingId: "sb-io", providers: ["*"] }, { batchId: "b1", changes });
    expect(r.results.every((x) => x.outcome === "created")).toBe(true);
    expect(authority.calls.put).toBeLessThanOrEqual(2); // was MSGS + 1
    // The content is exactly what was published.
    const v = await store.version(r.results[7]!.versionId!);
    expect((await store.readRange(v, 0, v.size)).toString()).toBe("mail 7\nneedle-7\n");
  });

  it("walks one directory per message with batched node reads and a single head read", async () => {
    const fs = coldFs();
    authority.reset();
    const r = await fs.run(NS, viewer, "find", { path: "$SOURCES/gmail/alice@acme.test/messages/2026-07", pattern: "message.md", limit: 2_000 });
    expect((r.matches as string[]).length).toBe(MSGS);
    expect(authority.calls.getRef).toBe(1); // was 2
    expect(authority.calls.get).toBeLessThan(15); // was ~MSGS (one per message directory)
  });

  it("greps many files with batched version and content reads, same matches", async () => {
    const fs = coldFs();
    authority.reset();
    const r = await fs.run(NS, viewer, "grep", { path: "$SOURCES/gmail/alice@acme.test/messages/2026-07", pattern: "needle-599", literal: true, limit: 20 });
    expect(r.matches).toEqual([{ path: "$SOURCES/gmail/alice@acme.test/messages/2026-07/m599/message.md", line: 2, text: "needle-599" }]);
    expect(r.filesSearched).toBe(MSGS);
    expect(authority.calls.get).toBeLessThan(25); // was ~3 x MSGS (node, version, chunk per file)
  });
});
