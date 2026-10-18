import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SourceService } from "../src/sources/service.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

/**
 * final-audit M4: collector health is not just the exporter's heartbeat. A scope that declares how often it
 * succeeds (expectedIntervalSeconds) makes the provider stale once its last success is 3 intervals old, even
 * while fresh heartbeats keep arriving (a dead worker or sweeper behind a live exporter). Deterministic clock.
 */
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("collector health", () => {
  it("is stale when a declared scope stopped succeeding, healthy otherwise", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sources-health-"));
    dirs.push(dir);
    let now = new Date("2026-10-18T12:00:00Z");
    const service = new SourceService(new DirectoryObjectStore(dir), () => now);
    const { binding } = await service.bindings.create("acme", { kind: "runtime", providers: ["*"] }, { subject: "admin", issuer: "test" });
    const record = { ...binding, tokenSha256: "0".repeat(64) };
    const report = (lastSuccessAt: string) =>
      service.reportStatus("acme", record, {
        providers: [{ provider: "google-docs", scope: "docs-poll", state: "complete", lastSuccessAt, expectedIntervalSeconds: 300 }],
        runtime: { reportIntervalSeconds: 300 },
      });
    await report("2026-10-18T11:58:00Z");
    let gd = (await service.status("acme")).providers.find((p) => p.provider === "google-docs")!;
    expect(gd.health).toBe("healthy");
    // Heartbeat is fresh (just received), but the scope last succeeded 20 minutes ago (> 3 x 300 s).
    await report("2026-10-18T11:40:00Z");
    gd = (await service.status("acme")).providers.find((p) => p.provider === "google-docs")!;
    expect(gd.reportAgeSeconds).toBe(0);
    expect(gd.coverage[0]).toMatchObject({ checkLate: true, stale: true });
    expect(gd.health).toBe("stale");
    // Without a declared interval, an old lastSuccessAt alone (e.g. a daily sweep) is not staleness.
    await service.reportStatus("acme", record, { providers: [{ provider: "google-docs", scope: "sweep", state: "complete", lastSuccessAt: "2026-10-17T12:00:00Z" }], runtime: { reportIntervalSeconds: 300 } });
    expect((await service.status("acme")).providers.find((p) => p.provider === "google-docs")!.health).toBe("healthy");
    // And a missing heartbeat is still stale.
    now = new Date("2026-10-18T13:00:00Z");
    expect((await service.status("acme")).providers.find((p) => p.provider === "google-docs")!.health).toBe("stale");
  });
});
