import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SourceService } from "../src/sources/service.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

/**
 * Owner evidence is cached per tenant (bindings, owners, runtime reports are object-store reads on every MCP call).
 * A change made by this process applies at once; one made by another replica applies within the 5 s TTL.
 */
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("owner evidence cache", () => {
  it("applies local changes at once and other replicas' changes within the TTL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sources-viewer-cache-"));
    dirs.push(dir);
    let now = Date.parse("2026-10-18T12:00:00Z");
    const objects = new DirectoryObjectStore(dir);
    const a = new SourceService(objects, () => new Date(now));
    const b = new SourceService(objects, () => new Date(now));
    const alice = { subject: "user_alice", issuer: "https://issuer.test" };
    expect((await a.viewer("acme", alice)).access("granola/x.md")).toBe("deny");
    await a.owners.claim("acme", "granola", alice, { hasUnownedData: false });
    expect((await a.viewer("acme", alice)).access("granola/x.md")).toBe("allow"); // same process: immediate
    await b.bindings.create("acme", { kind: "device", providers: ["imessage"], transport: "runtime-ingest" }, alice);
    expect((await a.viewer("acme", alice)).access("imessage/x.md")).toBe("deny"); // other replica: cached
    now += 5_001;
    expect((await a.viewer("acme", alice)).access("imessage/x.md")).toBe("allow");
  });
});
