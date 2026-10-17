import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimDailyBuild, FencedError, finishDailyBuild } from "../src/daily/lease.js";
import { DailyBuildService, type MemoryBuilder } from "../src/daily/service.js";
import { DirectoryObjectStore, type ObjectStore, type StoredObject } from "../src/store/objects.js";
import { getDailyRef, pinDailyManifest, TraceIngestor } from "../src/traces/index.js";

const NS = "tenant-daily";
let dir: string;
let store: DirectoryObjectStore;

/** Deterministic fixture builder: publishes one page listing the session ids it saw. */
const publishingBuilder: MemoryBuilder = async ({ repo, buildId, inputs, sources }) => {
  const base = await repo.ensureHead();
  const sessions = [...inputs.keys()].filter((k) => k.endsWith("/session.json")).sort();
  const files = new Map(await repo.files(base));
  files.set("index.md", `# Memory\n\n- [Seen](seen.md): sessions consolidated.\n`);
  files.set("seen.md", `# Seen\n\nBack to [root](index.md).\n\n${sessions.map((s) => `- ${s}`).join("\n")}\n`);
  const r = await repo.publish(base, files, { buildId, summary: "fixture", sources });
  return { status: "published", revisionId: r.revisionId };
};

async function ingest(day: string, sessionId: string) {
  const ingestor = new TraceIngestor(store, { now: () => new Date(`${day}T12:00:00Z`) });
  await ingestor.ingestChunk(NS, {
    sessionId,
    chunkSeq: 1,
    final: true,
    events: [
      { sessionId, seq: 1, ts: `${day}T12:00:00Z`, type: "note", agent: { id: "a" }, data: { hello: sessionId } },
      { sessionId, seq: 2, ts: `${day}T12:00:01Z`, type: "session_end", agent: { id: "a" }, data: null, outcome: { status: "succeeded", summary: "ok" } },
    ],
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "procmem-daily-"));
  store = new DirectoryObjectStore(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("daily build service", () => {
  it("lets exactly one of two processes claim the same day", async () => {
    await ingest("2026-10-16", "ses-race-1");
    let builds = 0;
    const slowBuilder: MemoryBuilder = async (args) => {
      builds++;
      await new Promise((r) => setTimeout(r, 50));
      return publishingBuilder(args);
    };
    const a = new DailyBuildService({ store, builder: slowBuilder });
    const b = new DailyBuildService({ store, builder: slowBuilder });
    const [ra, rb] = await Promise.all([a.start(NS, { day: "2026-10-16" }), b.start(NS, { day: "2026-10-16" })]);
    const running = [ra, rb].filter((r) => r.status === "running");
    expect(running).toHaveLength(1);
    const winner = running[0]!;
    const svc = winner === ra ? a : b;
    const receipt = await svc.runAndWait(NS, { day: "2026-10-16" }).catch(() => null);
    expect(receipt).toBeTruthy();
    const final = await (winner === ra ? a : b).get(NS, String(winner.buildId));
    // wait for the running job to finish
    for (let i = 0; i < 50 && final && (await svc.get(NS, String(winner.buildId)))?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await svc.get(NS, String(winner.buildId)))?.status).toBe("published");
    expect(builds).toBe(1);
  });

  it("recovers a day whose builder crashed (lease expired) and fences the dead owner", async () => {
    await ingest("2026-10-15", "ses-crash-1");
    const pin = await pinDailyManifest(store, NS, "2026-10-15");
    // A process claims the day and then dies without renewing its lease.
    const dead = await claimDailyBuild(store, NS, "2026-10-15", { manifestKey: pin.manifest!.key, buildId: "bld-dead-1", leaseMs: 1 });
    expect(dead.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    const svc = new DailyBuildService({ store, builder: publishingBuilder });
    const receipt = (await svc.runAndWait(NS, { day: "2026-10-15" })) as Record<string, unknown>;
    expect(receipt.status).toBe("published");
    const ref = await getDailyRef(store, NS, "2026-10-15");
    expect(ref?.value.status).toBe("published");
    expect(ref?.value.latestManifest).not.toBe(pin.manifest!.key); // superseded the dead build's manifest

    // The dead owner can never record a result afterwards.
    await expect(
      finishDailyBuild(store, NS, "2026-10-15", { manifestKey: pin.manifest!.key, buildId: "bld-dead-1", status: "failed", error: "late" }),
    ).rejects.toBeInstanceOf(FencedError);
  });

  it("does not start while another owner holds a live lease", async () => {
    await ingest("2026-10-14", "ses-live-1");
    const pin = await pinDailyManifest(store, NS, "2026-10-14");
    await claimDailyBuild(store, NS, "2026-10-14", { manifestKey: pin.manifest!.key, buildId: "bld-live-1", leaseMs: 60_000 });
    const svc = new DailyBuildService({ store, builder: publishingBuilder });
    const r = await svc.start(NS, { day: "2026-10-14" });
    expect(r.status).toBe("build_in_progress");
    expect(r.buildId).toBe("bld-live-1");
  });

  it("keeps a finished build visible with persistError when its receipt cannot be stored", async () => {
    await ingest("2026-10-13", "ses-persist-1");
    const failingReceipts: ObjectStore = {
      kind: "flaky",
      put: (ns: string, objects: StoredObject[]) =>
        objects.some((o) => o.key.startsWith("builds/receipts/")) ? Promise.reject(new Error("volume unavailable")) : store.put(ns, objects),
      get: (ns, keys) => store.get(ns, keys),
      list: (ns, prefix, opts) => store.list(ns, prefix, opts),
      getRef: (ns, name) => store.getRef(ns, name),
      casRef: (ns, name, v, value) => store.casRef(ns, name, v, value),
    };
    const svc = new DailyBuildService({ store: failingReceipts, builder: publishingBuilder });
    const view = (await svc.runAndWait(NS, { day: "2026-10-13" })) as Record<string, unknown>;
    expect(view.status).toBe("published");
    expect(String(view.persistError)).toContain("volume unavailable");
    // The day itself was still recorded (fenced final status is a separate write).
    expect((await getDailyRef(store, NS, "2026-10-13"))?.value.status).toBe("published");
  }, 20_000);

  it("catch-up builds the oldest unprocessed day first and reports the backlog", async () => {
    await ingest("2026-10-10", "ses-old-1");
    await ingest("2026-10-12", "ses-new-1");
    const svc = new DailyBuildService({ store, builder: publishingBuilder });
    const first = (await svc.start(NS, { catchup: true, day: "2026-10-16" })) as Record<string, unknown>;
    expect(first.day).toBe("2026-10-10");
    expect(first.remainingDays).toEqual(["2026-10-12"]);
    await svc.runAndWait(NS, { day: "2026-10-10" }).catch(() => undefined);
    for (let i = 0; i < 100 && (await svc.get(NS, String(first.buildId)))?.status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    const second = (await svc.runAndWait(NS, { catchup: true, day: "2026-10-16" })) as Record<string, unknown>;
    expect(second.day).toBe("2026-10-12");
    expect(second.status).toBe("published");
    const third = await svc.start(NS, { catchup: true, day: "2026-10-16" });
    expect(third.status).toBe("nothing_to_build");
  });
});
