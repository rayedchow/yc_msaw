/**
 * Live durability smoke for the hosted ObjectStore (Modal Volume + Dict lock).
 *
 *   npx tsx scripts/durability-smoke.ts
 *
 * Uses a fresh namespace per run and writes sanitized evidence (no tokens or
 * credentials) to reports/durability-smoke.json. Exits non-zero on failure.
 */
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ModalClient } from "modal";
import { ModalObjectStore, RefLockedError } from "../src/store/modal-objects.js";
import { CachedObjectStore, DirectoryObjectStore, type RefRecord } from "../src/store/objects.js";
import { MemoryRepo } from "../src/store/memory.js";
import { sha256 } from "../src/util.js";

const APP = "procmem-store";
const FN = "store_op";

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  details?: Record<string, unknown>;
  error?: string;
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const ns = `smoke-${stamp}`;
const results: StepResult[] = [];
const stores: ModalObjectStore[] = [];
const tempDirs: string[] = [];

function fresh(): ModalObjectStore {
  const s = new ModalObjectStore({ appName: APP, functionName: FN, timeoutMs: 90_000 });
  stores.push(s);
  return s;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

async function expectReject(p: Promise<unknown>, pattern: RegExp, label: string): Promise<string> {
  try {
    await p;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    assert(pattern.test(msg), `${label}: unexpected error ${JSON.stringify(msg)}`);
    return msg;
  }
  throw new Error(`Assertion failed: ${label} should have been rejected`);
}

async function step(name: string, fn: () => Promise<Record<string, unknown> | void>): Promise<void> {
  const started = performance.now();
  try {
    const details = (await fn()) ?? undefined;
    results.push({ name, ok: true, ms: Math.round(performance.now() - started), details });
    console.log(`ok   ${name} (${Math.round(performance.now() - started)}ms)`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, ms: Math.round(performance.now() - started), error: msg });
    console.error(`FAIL ${name}: ${msg}`);
  }
}

async function tempCache(label: string): Promise<DirectoryObjectStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `procmem-${label}-`));
  tempDirs.push(dir);
  return new DirectoryObjectStore(dir);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const started = Date.now();
  const store = fresh();
  const blobBytes = Buffer.from(`durability smoke blob ${ns}\n`, "utf8");
  const blobKey = `blobs/${sha256(blobBytes)}`;

  await step("put: objects incl. blob, identical duplicate, idempotent re-put", async () => {
    const a = Buffer.from("alpha", "utf8");
    await store.put(ns, [
      { key: blobKey, bytes: blobBytes },
      { key: "notes/a.txt", bytes: a },
      { key: "notes/a.txt", bytes: a }, // identical duplicate in one batch is fine
      { key: "notes/b.txt", bytes: Buffer.from("bravo") },
      { key: "notes/sub/c.txt", bytes: Buffer.from("charlie") },
      { key: "other/d.txt", bytes: Buffer.from("delta") },
    ]);
    await store.put(ns, [{ key: "notes/a.txt", bytes: a }]); // re-put identical bytes: no-op
    const got = await fresh().get(ns, [blobKey, "notes/a.txt", "notes/sub/c.txt", "missing/x.txt"]);
    assert(got.get(blobKey)?.equals(blobBytes), "blob round-trips");
    assert(got.get("notes/a.txt")?.toString() === "alpha", "notes/a.txt round-trips");
    assert(got.get("notes/sub/c.txt")?.toString() === "charlie", "nested key round-trips");
    assert(!got.has("missing/x.txt"), "missing key is absent");
    return { keysRead: got.size };
  });

  await step("put: rejections (conflicting duplicate, immutable overwrite, bad blob digest; client and server side)", async () => {
    const clientDup = await expectReject(
      store.put(ns, [
        { key: "notes/e.txt", bytes: Buffer.from("one") },
        { key: "notes/e.txt", bytes: Buffer.from("two") },
      ]),
      /Conflicting duplicate key/,
      "client conflicting duplicate",
    );
    const overwrite = await expectReject(store.put(ns, [{ key: "notes/a.txt", bytes: Buffer.from("not alpha") }]), /already exists with different content/, "immutable overwrite");
    const badBlob = await expectReject(store.put(ns, [{ key: `blobs/${"0".repeat(64)}`, bytes: Buffer.from("x") }]), /digest mismatch/, "client blob digest");
    // Bypass the client validation to prove the server enforces the same rules.
    const client = new ModalClient();
    try {
      const fn = await client.functions.fromName(APP, FN);
      const b64 = (s: string) => Buffer.from(s).toString("base64");
      const serverDup = (await fn.remote(["put", { ns, objects: [{ key: "notes/f.txt", b64: b64("one") }, { key: "notes/f.txt", b64: b64("two") }] }])) as Record<string, unknown>;
      assert(typeof serverDup.error === "string" && /Conflicting duplicate key/.test(serverDup.error), `server conflicting duplicate: ${JSON.stringify(serverDup)}`);
      const serverBlob = (await fn.remote(["put", { ns, objects: [{ key: `blobs/${"1".repeat(64)}`, b64: b64("x") }] }])) as Record<string, unknown>;
      assert(typeof serverBlob.error === "string" && /digest mismatch/.test(serverBlob.error), "server blob digest");
      const serverKey = (await fn.remote(["put", { ns, objects: [{ key: "../escape", b64: b64("x") }] }])) as Record<string, unknown>;
      assert(typeof serverKey.error === "string" && /Invalid object key/.test(serverKey.error), "server key validation");
      const serverNs = (await fn.remote(["get_ref", { ns: "../etc", name: "x" }])) as Record<string, unknown>;
      assert(typeof serverNs.error === "string" && /Invalid namespace/.test(serverNs.error), "server ns validation");
      const serverPrefix = (await fn.remote(["list", { ns, prefix: "../" }])) as Record<string, unknown>;
      assert(typeof serverPrefix.error === "string" && /Invalid list prefix/.test(serverPrefix.error), "server prefix validation");
    } finally {
      client.close();
    }
    const after = await fresh().get(ns, ["notes/a.txt", "notes/e.txt", "notes/f.txt"]);
    assert(after.get("notes/a.txt")?.toString() === "alpha", "original bytes survive overwrite attempt");
    assert(!after.has("notes/e.txt") && !after.has("notes/f.txt"), "rejected batches wrote nothing");
    return { clientDup, overwrite, badBlob, server: "conflicting-duplicate, blob digest, key, ns, prefix all rejected" };
  });

  await step("list: prefix / after / limit", async () => {
    const s = fresh();
    const all = await s.list(ns, "");
    const notes = await s.list(ns, "notes/");
    const partial = await s.list(ns, "notes/s");
    const after = await s.list(ns, "notes/", { after: "notes/a.txt" });
    const limited = await s.list(ns, "", { limit: 2 });
    assert(sameJson(all, [blobKey, "notes/a.txt", "notes/b.txt", "notes/sub/c.txt", "other/d.txt"].sort()), `list all: ${JSON.stringify(all)}`);
    assert(sameJson(notes, ["notes/a.txt", "notes/b.txt", "notes/sub/c.txt"]), `list notes/: ${JSON.stringify(notes)}`);
    assert(sameJson(partial, ["notes/sub/c.txt"]), `list partial segment: ${JSON.stringify(partial)}`);
    assert(sameJson(after, ["notes/b.txt", "notes/sub/c.txt"]), `list after: ${JSON.stringify(after)}`);
    assert(sameJson(limited, all.slice(0, 2)), "list limit");
    await expectReject(s.list(ns, "../x"), /Invalid list prefix/, "client unsafe prefix");
    return { all: all.length, notes, after };
  });

  let casVersion = 0;
  await step("casRef: create, stale rejection, success", async () => {
    const s = fresh();
    assert((await s.getRef(ns, "smoke/ref")) === null, "ref absent initially");
    const created = await s.casRef(ns, "smoke/ref", null, { n: 1 });
    assert(created.ok && created.current?.version === 1, `create: ${JSON.stringify(created)}`);
    const again = await fresh().casRef(ns, "smoke/ref", null, { n: "dup" });
    assert(!again.ok && again.current?.version === 1, "create-if-absent rejected when present");
    const stale = await fresh().casRef(ns, "smoke/ref", 7, { n: "stale" });
    assert(!stale.ok && stale.current?.version === 1 && sameJson(stale.current.value, { n: 1 }), "stale expected version rejected");
    const next = await s.casRef(ns, "smoke/ref", 1, { n: 2 });
    assert(next.ok && next.current?.version === 2, "advance 1 -> 2");
    const read: RefRecord | null = await fresh().getRef(ns, "smoke/ref");
    assert(read?.version === 2 && sameJson(read.value, { n: 2 }) && typeof read.updatedAt === "string", `fresh read: ${JSON.stringify(read)}`);
    casVersion = 2;
    return { finalVersion: read.version };
  });

  await step("casRef: concurrent race from 6 independent store instances", async () => {
    const racers = Array.from({ length: 6 }, () => fresh());
    const outcomes = await Promise.all(
      racers.map(async (s, i) => {
        const t0 = performance.now();
        try {
          const r = await s.casRef(ns, "smoke/ref", casVersion, { winner: i });
          return { i, ok: r.ok, version: r.current?.version ?? null, ms: Math.round(performance.now() - t0) };
        } catch (error) {
          return { i, ok: false, locked: error instanceof RefLockedError, error: error instanceof Error ? error.message : String(error), ms: Math.round(performance.now() - t0) };
        }
      }),
    );
    const winners = outcomes.filter((o) => o.ok);
    const errors = outcomes.filter((o) => "error" in o);
    assert(winners.length === 1, `exactly one winner expected, got ${winners.length}: ${JSON.stringify(outcomes)}`);
    assert(errors.length === 0, `no racer should error: ${JSON.stringify(errors)}`);
    const final = await fresh().getRef(ns, "smoke/ref");
    assert(final?.version === casVersion + 1, `final version ${final?.version}`);
    assert(sameJson(final.value, { winner: winners[0]!.i }), "stored value is the winner's");
    return { outcomes, finalVersion: final.version };
  });

  await step("multipart: >12 MiB random blob + 7 MiB keyed object roundtrip, cold read, create-once, abandoned upload invisible", async () => {
    const big = randomBytes(13 * 1024 * 1024 + 12_345); // high entropy: base64 cannot compress it
    const bigKey = `blobs/${sha256(big)}`;
    const keyed = randomBytes(7 * 1024 * 1024 + 7);
    const keyedKey = "large/trace-chunk.bin";
    const tPut = performance.now();
    await fresh().put(ns, [
      { key: bigKey, bytes: big },
      { key: keyedKey, bytes: keyed },
    ]);
    const putMs = Math.round(performance.now() - tPut);
    await fresh().put(ns, [{ key: bigKey, bytes: big }]); // idempotent re-put of the large blob
    const overwrite = await expectReject(fresh().put(ns, [{ key: keyedKey, bytes: randomBytes(keyed.length) }]), /already exists with different content/, "large immutable overwrite");

    // Cold instance: brand-new client and empty local cache.
    const tGet = performance.now();
    const cold = new CachedObjectStore(fresh(), await tempCache("multipart"));
    const got = await cold.get(ns, [bigKey, keyedKey, "notes/a.txt"]);
    const getMs = Math.round(performance.now() - tGet);
    assert(got.get(bigKey)?.equals(big), "large blob bytes are exact after cold read");
    assert(got.get(keyedKey)?.equals(keyed), "large keyed object bytes are exact after cold read");
    assert(got.get("notes/a.txt")?.toString() === "alpha", "mixed small object in same get");

    // An abandoned upload (parts staged, never committed) must never surface as an object.
    const client = new ModalClient();
    let abandoned: Record<string, unknown>;
    try {
      const fn = await client.functions.fromName(APP, FN);
      const uploadId = randomBytes(16).toString("hex");
      const part = (await fn.remote(["upload_part", { ns, upload_id: uploadId, index: 0, b64: Buffer.from("orphan").toString("base64") }])) as Record<string, unknown>;
      assert(part.bytes === 6, `staged part: ${JSON.stringify(part)}`);
      const badCommit = (await fn.remote(["upload_commit", { ns, upload_id: uploadId, key: "large/orphan.bin", parts: 1, size: 6, sha256: "0".repeat(64) }])) as Record<string, unknown>;
      assert(typeof badCommit.error === "string" && /Digest mismatch/.test(badCommit.error), `bad commit rejected: ${JSON.stringify(badCommit)}`);
      const retry = (await fn.remote(["upload_commit", { ns, upload_id: uploadId, key: "large/orphan.bin", parts: 1, size: 6, sha256: sha256("orphan") }])) as Record<string, unknown>;
      assert(typeof retry.error === "string" && /missing part 0/.test(retry.error), `failed commit cleaned staged parts: ${JSON.stringify(retry)}`);
      const uploadId2 = randomBytes(16).toString("hex");
      await fn.remote(["upload_part", { ns, upload_id: uploadId2, index: 0, b64: Buffer.from("never committed").toString("base64") }]);
      const listed = await fresh().list(ns, "large/");
      assert(sameJson(listed, [keyedKey]), `only committed objects listed: ${JSON.stringify(listed)}`);
      const abort = (await fn.remote(["upload_abort", { ns, upload_id: uploadId2 }])) as Record<string, unknown>;
      assert(abort.removed === true, "abort removes staged parts");
      abandoned = { badCommit: "rejected", failedCommitCleanedParts: true, listedLarge: listed, abortRemoved: abort.removed };
    } finally {
      client.close();
    }
    return { blobBytes: big.length, keyedBytes: keyed.length, putMs, coldGetMs: getMs, overwrite, abandoned };
  });

  const wiki = new Map<string, string>([
    ["index.md", "# Procedural memory\n\nSmoke-test wiki.\n\n- [Release workflow](release-workflow.md): read before cutting a release.\n"],
    ["release-workflow.md", "# Release workflow\n\nRun the tests, tag the commit, then publish.\n\nBack to [index](index.md).\n"],
  ]);
  let published = "";
  await step("restart survival: cold instance A publishes via CachedObjectStore", async () => {
    const repoA = new MemoryRepo(new CachedObjectStore(fresh(), await tempCache("a")), ns);
    const base = await repoA.ensureHead();
    const pub = await repoA.publish(base, wiki, { buildId: `smoke-${stamp}`, summary: "durability smoke", sources: [] });
    published = pub.revisionId;
    return { bootstrap: base, published };
  });

  await step("restart survival: fresh instance B reads head, manifest, files", async () => {
    const repoB = new MemoryRepo(new CachedObjectStore(fresh(), await tempCache("b")), ns);
    const head = await repoB.head();
    assert(head?.value.revisionId === published, `head ${head?.value.revisionId} != ${published}`);
    const manifest = await repoB.manifest(published);
    assert(manifest.revisionId === published && manifest.parent !== null, "manifest verified with bootstrap parent");
    const files = await repoB.files(published);
    assert(sameJson([...files.entries()].sort(), [...wiki.entries()].sort()), "files equal what A published");
    const history = await repoB.history(5);
    assert(history.length === 2, `history length ${history.length}`);
    return { head: head.value, headVersion: head.version, files: [...files.keys()], history: history.map((m) => m.revisionId) };
  });

  const ok = results.every((r) => r.ok);
  const evidence = {
    kind: "procmem.durability-smoke/v1",
    ok,
    ns,
    app: APP,
    function: FN,
    volume: "procmem-memory",
    lockDict: "procmem-locks",
    startedAt: new Date(started).toISOString(),
    totalMs: Date.now() - started,
    results,
  };
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile(path.join("reports", "durability-smoke.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${ok ? "PASS" : "FAIL"} ns=${ns} total=${evidence.totalMs}ms -> reports/durability-smoke.json`);
  return ok;
}

main()
  .then(async (ok) => {
    for (const s of stores) s.close();
    for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
