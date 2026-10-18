import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SourceViewer } from "../src/sources/access.js";
import { SourceFs } from "../src/sources/fs.js";
import { SourceService } from "../src/sources/service.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/**
 * perf-verification §4: a $SOURCES grep loaded every candidate file (up to 5,000) before matching, even when the
 * first files already held `limit` matches. It now searches in batches and stops once the limit is reached.
 */
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const viewer = new SourceViewer({ subject: "u", issuer: "i" }, { providerOwners: new Map(), googleAccounts: [] });

describe("$SOURCES grep", () => {
  it("stops reading files once the match limit is reached, and still searches everything when it is not", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sources-grep-"));
    dirs.push(dir);
    const service = new SourceService(new DirectoryObjectStore(dir));
    const changes = Array.from({ length: 1_200 }, (_, i) => {
      const bytes = Buffer.from(`issue ${i}\\n${i === 1_150 ? "rare-needle" : "common-needle"}\\n`);
      return { op: "put" as const, path: `sources/jira/ACME/ACME-${String(i).padStart(5, "0")}.md`, kind: "projection" as const, contentType: "text/markdown", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt: new Date(Date.now() - 60_000).toISOString() };
    });
    for (let i = 0; i < changes.length; i += 500) await service.storeFor("acme").applyBatch({ bindingId: "sb-grep", providers: ["*"] }, { batchId: `b${i}`, changes: changes.slice(i, i + 500) });
    const fs = new SourceFs(service);
    const early = await fs.grep("acme", viewer, { path: "$SOURCES/jira", pattern: "common-needle", literal: true, ignoreCase: false, limit: 5 } as never);
    expect(early.matches).toHaveLength(5);
    expect(early.truncated).toBe(true);
    expect(early.filesSearched).toBeLessThanOrEqual(250);
    const rare = await fs.grep("acme", viewer, { path: "$SOURCES/jira", pattern: "rare-needle", literal: true, ignoreCase: false, limit: 5 } as never);
    expect((rare.matches as Array<{ path: string }>).map((m) => m.path)).toEqual(["$SOURCES/jira/ACME/ACME-01150.md"]);
    expect(rare.filesSearched).toBe(1_200);
    expect(rare.truncated).toBe(false);
  });
});
