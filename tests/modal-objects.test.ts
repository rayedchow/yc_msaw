import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModalClient } from "modal";
import { ModalObjectStore, RefLockedError } from "../src/store/modal-objects.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

type Remote = (op: string, payload: Record<string, any>) => Promise<unknown>;

/** Fake ModalClient whose store_op is served by a DirectoryObjectStore (the reference semantics). */
function fakeClient(remote: Remote, calls: { op: string; payload: Record<string, any> }[] = []) {
  const client = {
    functions: {
      fromName: async () => ({
        remote: async ([op, payload]: [string, Record<string, any>]) => {
          calls.push({ op, payload });
          return remote(op, payload);
        },
      }),
    },
    close() {},
  };
  return client as unknown as ModalClient;
}

const INLINE_MAX = 6 * 1024 * 1024;

function directoryRemote(dir: DirectoryObjectStore, staged = new Map<string, Map<number, Buffer>>()): Remote {
  return async (op, p) => {
    try {
      switch (op) {
        case "upload_part": {
          const parts = staged.get(p.upload_id) ?? new Map<number, Buffer>();
          parts.set(p.index, Buffer.from(p.b64, "base64"));
          staged.set(p.upload_id, parts);
          return { index: p.index };
        }
        case "upload_commit": {
          const parts = staged.get(p.upload_id);
          staged.delete(p.upload_id);
          const bytes = Buffer.concat(Array.from({ length: p.parts }, (_, i) => parts?.get(i) ?? Buffer.alloc(0)));
          if (bytes.length !== p.size || sha256(bytes) !== p.sha256) return { error: "Digest mismatch" };
          await dir.put(p.ns, [{ key: p.key, bytes }]);
          return { created: 1 };
        }
        case "upload_abort":
          return { removed: staged.delete(p.upload_id) };
        case "get_range": {
          const bytes = (await dir.get(p.ns, [p.key])).get(p.key);
          if (!bytes) return { found: false };
          return { found: true, size: bytes.length, offset: p.offset, b64: bytes.subarray(p.offset, p.offset + p.length).toString("base64") };
        }
        case "put":
          await dir.put(p.ns, p.objects.map((o: { key: string; b64: string }) => ({ key: o.key, bytes: Buffer.from(o.b64, "base64") })));
          return { created: p.objects.length };
        case "get": {
          const got = [...(await dir.get(p.ns, p.keys))];
          return {
            objects: Object.fromEntries(got.filter(([, v]) => v.length <= INLINE_MAX).map(([k, v]) => [k, v.toString("base64")])),
            large: Object.fromEntries(got.filter(([, v]) => v.length > INLINE_MAX).map(([k, v]) => [k, { size: v.length, sha256: sha256(v) }])),
            remaining: [],
          };
        }
        case "list":
          return { keys: await dir.list(p.ns, p.prefix, { after: p.after, limit: p.limit }) };
        case "get_ref":
          return { ref: await dir.getRef(p.ns, p.name) };
        case "cas_ref":
          return await dir.casRef(p.ns, p.name, p.expected_version, p.value);
      }
      return { error: `Unknown op ${op}` };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
}

const dirs: string[] = [];
async function tempDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "modal-objects-test-"));
  dirs.push(d);
  return new DirectoryObjectStore(d);
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("ModalObjectStore (offline, fake client)", () => {
  it("round-trips objects, listings and CAS refs with reference semantics", async () => {
    const store = new ModalObjectStore({ client: fakeClient(directoryRemote(await tempDir())) });
    const blob = Buffer.from("hello");
    await store.put("t1", [
      { key: `blobs/${sha256(blob)}`, bytes: blob },
      { key: "a/b.txt", bytes: Buffer.from("x") },
    ]);
    const got = await store.get("t1", [`blobs/${sha256(blob)}`, "a/b.txt", "nope"]);
    expect(got.get("a/b.txt")?.toString()).toBe("x");
    expect(got.has("nope")).toBe(false);
    expect(await store.list("t1", "a/")).toEqual(["a/b.txt"]);
    await expect(store.put("t1", [{ key: "a/b.txt", bytes: Buffer.from("y") }])).rejects.toThrow(/different content/);

    expect((await store.casRef("t1", "memory/head", null, { v: 1 })).ok).toBe(true);
    expect((await store.casRef("t1", "memory/head", null, { v: 2 })).ok).toBe(false);
    const next = await store.casRef("t1", "memory/head", 1, { v: 2 });
    expect(next).toMatchObject({ ok: true, current: { version: 2, value: { v: 2 } } });
  });

  it("validates client-side before any network call", async () => {
    const calls: { op: string; payload: Record<string, any> }[] = [];
    const store = new ModalObjectStore({ client: fakeClient(async () => ({}), calls) });
    await expect(store.put("t1", [{ key: "k", bytes: Buffer.from("1") }, { key: "k", bytes: Buffer.from("2") }])).rejects.toThrow(/Conflicting duplicate/);
    await expect(store.put("t1", [{ key: `blobs/${"0".repeat(64)}`, bytes: Buffer.from("1") }])).rejects.toThrow(/digest mismatch/);
    await expect(store.put("Bad NS", [])).rejects.toThrow(/Invalid namespace/);
    await expect(store.get("t1", ["../x"])).rejects.toThrow(/Invalid object key/);
    await expect(store.list("t1", "../")).rejects.toThrow(/Invalid list prefix/);
    await expect(store.casRef("t1", "../head", null, 1)).rejects.toThrow(/Invalid ref name/);
    expect(calls).toHaveLength(0);
  });

  it("splits large puts into bounded batches", async () => {
    const calls: { op: string; payload: Record<string, any> }[] = [];
    const store = new ModalObjectStore({ client: fakeClient(directoryRemote(await tempDir()), calls) });
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    await store.put("t1", [1, 2, 3, 4].map((i) => ({ key: `big/${i}`, bytes: Buffer.concat([big, Buffer.from([i])]) })));
    const puts = calls.filter((c) => c.op === "put");
    expect(puts.length).toBeGreaterThan(1);
    for (const c of puts) expect(c.payload.objects.reduce((n: number, o: { b64: string }) => n + o.b64.length, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("uploads large objects in parts and reads them back by range with exact bytes", async () => {
    const calls: { op: string; payload: Record<string, any> }[] = [];
    const staged = new Map<string, Map<number, Buffer>>();
    const store = new ModalObjectStore({ client: fakeClient(directoryRemote(await tempDir(), staged), calls) });
    const big = randomBytes(20 * 1024 * 1024 + 3);
    const key = `blobs/${sha256(big)}`;
    await store.put("t1", [{ key, bytes: big }, { key: "small.txt", bytes: Buffer.from("s") }]);
    const parts = calls.filter((c) => c.op === "upload_part");
    expect(parts).toHaveLength(4);
    for (const c of parts) expect(c.payload.b64.length).toBeLessThanOrEqual(8 * 1024 * 1024 + 4);
    expect(calls.filter((c) => c.op === "upload_commit")).toHaveLength(1);
    expect(staged.size).toBe(0);
    const got = await store.get("t1", [key, "small.txt"]);
    expect(got.get(key)?.equals(big)).toBe(true);
    expect(got.get("small.txt")?.toString()).toBe("s");
    expect(calls.filter((c) => c.op === "get_range").length).toBe(4);
  });

  it("aborts the staged upload when a part fails", async () => {
    const calls: { op: string; payload: Record<string, any> }[] = [];
    const store = new ModalObjectStore({
      client: fakeClient(async (op, p) => (op === "upload_part" && p.index === 1 ? { error: "boom" } : { removed: true }), calls),
    });
    await expect(store.put("t1", [{ key: "big.bin", bytes: randomBytes(13 * 1024 * 1024) }])).rejects.toThrow(/boom/);
    expect(calls.map((c) => c.op)).toContain("upload_abort");
    expect(calls.map((c) => c.op)).not.toContain("upload_commit");
  });

  it("rejects a ranged read whose bytes do not match the reported digest", async () => {
    const real = randomBytes(7 * 1024 * 1024);
    const store = new ModalObjectStore({
      client: fakeClient(async (op, p) =>
        op === "get"
          ? { objects: {}, large: { [p.keys[0]]: { size: real.length, sha256: sha256(real) } }, remaining: [] }
          : { found: true, size: real.length, offset: p.offset, b64: Buffer.alloc(p.length).toString("base64") },
      ),
    });
    await expect(store.get("t1", ["large/x.bin"])).rejects.toThrow(/Digest mismatch/);
  });

  it("rejects corrupted blobs returned by the remote", async () => {
    const store = new ModalObjectStore({
      client: fakeClient(async (_op, p) => ({ objects: { [p.keys[0]]: Buffer.from("tampered").toString("base64") }, remaining: [] })),
    });
    await expect(store.get("t1", [`blobs/${sha256("original")}`])).rejects.toThrow(/digest mismatch/);
  });

  it("maps remote errors, ref_locked, and hung calls", async () => {
    const failing = new ModalObjectStore({ client: fakeClient(async () => ({ error: "Immutable object k already exists" })) });
    await expect(failing.put("t1", [{ key: "k", bytes: Buffer.from("1") }])).rejects.toThrow(/already exists/);

    const locked = new ModalObjectStore({ client: fakeClient(async () => ({ error: "ref_locked", detail: "held since then" })) });
    const err = await locked.casRef("t1", "memory/head", 1, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefLockedError);
    expect((err as Error).message).toMatch(/locked/);

    const hung = new ModalObjectStore({ client: fakeClient(() => new Promise(() => {})), timeoutMs: 50 });
    await expect(hung.getRef("t1", "memory/head")).rejects.toThrow(/timed out/);
  });
});
