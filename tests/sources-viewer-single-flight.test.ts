import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SourceService } from "../src/sources/service.js";
import { DirectoryObjectStore, type ObjectStore } from "../src/store/objects.js";

/**
 * perf-verification-2: agents issue tool calls in parallel. When the 5 s owner-evidence / attribution TTL runs out,
 * every concurrent call of a principal re-read the bindings, owners and status refs and asked the runtime for its
 * Google units again (8 parallel calls: 8 attribution requests of ~1.1 MB each for ~12k units, 290 ms per call at a
 * 25 ms store round trip). Concurrent refreshes must share one load, and a cached viewer must not be rebuilt per call.
 */
class Counting implements ObjectStore {
  readonly kind = "counting";
  refs = 0;
  constructor(readonly inner: ObjectStore) {}
  put(ns: string, o: Parameters<ObjectStore["put"]>[1]) { return this.inner.put(ns, o); }
  get(ns: string, k: string[]) { return this.inner.get(ns, k); }
  list(ns: string, p: string, o?: { after?: string; limit?: number }) { return this.inner.list(ns, p, o); }
  async getRef(ns: string, n: string) { this.refs++; await new Promise((r) => setTimeout(r, 5)); return this.inner.getRef(ns, n); }
  casRef(ns: string, n: string, v: number | null, value: unknown) { return this.inner.casRef(ns, n, v, value); }
}
const ISS = "https://issuer.test";
const alice = { subject: "user_alice", issuer: ISS };
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("viewer refresh", () => {
  it("shares one refresh between concurrent calls and reuses the viewer while nothing changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "viewer-single-flight-"));
    dirs.push(dir);
    let now = Date.parse("2026-10-18T12:00:00Z");
    const counted = new Counting(new DirectoryObjectStore(dir));
    const svc = new SourceService(counted, () => new Date(now));
    const { binding } = await svc.bindings.create("acme", { kind: "runtime", providers: ["*"], origin: "runtime-provision" }, alice);
    await svc.reportStatus("acme", binding as never, { providers: [], googleAccounts: [{ account: "alice@acme.test", subject: "user_alice", issuer: ISS }] });
    let asked = 0;
    svc.useGoogleAttribution(async () => {
      asked++;
      await new Promise((r) => setTimeout(r, 20));
      return { units: Array.from({ length: 2000 }, (_, i) => ({ path: `google-docs/d${i}-doc-x`, accounts: ["alice@acme.test"], revisions: true })), truncated: false };
    });
    const first = await svc.viewer("acme", alice);
    expect(first.access("google-docs/d7-doc-x/document.md")).toBe("allow");
    expect(asked).toBe(1);
    now += 5_001; // TTL out: a burst of parallel tool calls
    counted.refs = 0;
    const burst = await Promise.all(Array.from({ length: 8 }, () => svc.viewer("acme", alice)));
    expect(asked).toBe(2); // unpatched: 9
    expect(counted.refs).toBeLessThanOrEqual(4); // bindings, owners, one status ref, one head (unpatched: 32)
    expect(new Set(burst).size).toBe(1);
    expect(await svc.viewer("acme", alice)).toBe(burst[0]); // cached: same viewer, not rebuilt from 2k units
  });
});
