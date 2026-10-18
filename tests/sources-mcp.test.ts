import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/static-keys.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sha256 } from "../src/util.js";

/** MCP $SOURCES routing over the real server (static keys on loopback). */

let app: App;
let dir: string;
let base: string;
let mcpUrl: string;
let reader: Client;
let token: string;
const admin = generateStaticKey("acme", ["memory:build", "memory:read"]);
const readerKey = generateStaticKey("acme", ["memory:read"]);
const ingestKey = generateStaticKey("acme", ["traces:write"]);
const clients: Client[] = [];

async function connect(key: string): Promise<Client> {
  const c = new Client({ name: "sources-mcp", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  clients.push(c);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { ...(JSON.parse(r.content[0]!.text) as Record<string, any>), isError: r.isError === true };
}

function put(p: string, content: string | Buffer, extra: Record<string, unknown> = {}) {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return { op: "put", path: p, kind: "projection", contentType: "text/markdown", size: bytes.length, sha256: sha256(bytes), inline: bytes.toString("base64"), capturedAt: new Date(Date.now() - 60_000).toISOString(), ...extra };
}

async function publish(changes: unknown[], batchId: string) {
  const res = await fetch(`${base}/v1/sources/publish`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ batchId, changes }) });
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "sources-mcp-"));
  app = await createApp({
    env: {
      HOST: "127.0.0.1",
      AUTH_MODE: "static",
      PROCMEM_STATIC_KEYS: [admin.entry, readerKey.entry, ingestKey.entry].join(","),
      PROCMEM_STATIC_KEYS_ON_MCP: "1",
      PROCMEM_STORE: "directory",
      PROCMEM_SANDBOX: "local",
      PROCMEM_DATA_DIR: dir,
    },
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: async () => {
      throw new Error("no builds in source tests");
    },
    leaseFactory: async () => {
      throw new Error("$SOURCES tools must not open a sandbox");
    },
    log: () => undefined,
  });
  ({ url: base, mcpUrl } = await app.listen(0));
  const created = await fetch(`${base}/v1/sources/bindings`, { method: "POST", headers: { Authorization: `Bearer ${admin.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ providers: ["jira", "confluence"] }) });
  expect(created.status).toBe(201);
  token = ((await created.json()) as { token: string }).token;
  const many = Array.from({ length: 30 }, (_, i) => put(`sources/jira/C1/2026-10-${String(i + 1).padStart(2, "0")}.md`, `day ${i + 1}\nneedle-${i % 3}\n`));
  await publish(
    [
      ...many,
      put("sources/confluence/Team Handbook/Tab 1.md", "line one\nline two\nline three\n", { sourceUpdatedAt: new Date(Date.now() - 3_600_000).toISOString(), sourceVersion: { ref: "rev-9", ordinal: 9 } }),
      put("sources/confluence/d1/image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff]), { kind: "binary", contentType: "image/png" }),
      put("sources/jira/C1/gone.md", "soon deleted\nneedle-0\n"),
    ],
    "seed",
  );
  await publish([{ op: "delete", path: "sources/jira/C1/gone.md", deletedAt: new Date(Date.now() - 1_000).toISOString(), reason: "message_deleted", capturedAt: new Date(Date.now() - 1_000).toISOString() }], "delete");
  reader = await connect(readerKey.key);
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("$SOURCES over the filesystem MCP", () => {
  it("advertises the source tools next to the existing filesystem verbs", async () => {
    const names = (await reader.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read", "ls", "find", "grep", "sources_status", "sources_history"]));
    const ls = (await reader.listTools()).tools.find((t) => t.name === "ls")!;
    expect(JSON.stringify(ls.inputSchema)).toContain("after");
  });

  it("lists the root with orientation and pages large directories with after", async () => {
    const root = await call(reader, "ls", { path: "$SOURCES" });
    expect(root.entries.map((e: any) => e.name)).toEqual(["confluence/", "jira/"]);
    expect(root.orientation).toContain("$SOURCES");
    const first = await call(reader, "ls", { path: "$SOURCES/jira/C1", limit: 10 });
    expect(first.entries).toHaveLength(10);
    expect(first.truncated).toBe(true);
    expect(first.deletedFiles).toBe(1);
    const second = await call(reader, "ls", { path: "$SOURCES/jira/C1", limit: 25, after: first.nextAfter });
    expect(second.entries).toHaveLength(20);
    expect(second.truncated).toBe(false);
    expect([...first.entries, ...second.entries].map((e: any) => e.name)).not.toContain("gone.md");
    const knowledge = await call(reader, "ls", { path: "$KNOWLEDGE", after: "x" });
    expect(knowledge.isError).toBe(true);
    expect(knowledge.error).toContain("only supported for $SOURCES");
  });

  it("reads text by lines and bytes, binaries as base64, with freshness and provenance", async () => {
    const lines = await call(reader, "read", { path: "$SOURCES/confluence/Team Handbook/Tab 1.md", offset: 2, limit: 1 });
    expect(lines).toMatchObject({ ok: true, content: "line two", mode: "lines", totalLines: 3, nextOffset: 3 });
    expect(lines.source).toMatchObject({ kind: "projection", contentType: "text/markdown" });
    expect(lines.source.captureLagSeconds).toBeGreaterThan(0);
    expect(lines.source.coverage.state).toBe("unreported");
    const bytes = await call(reader, "read", { path: "$SOURCES/confluence/Team Handbook/Tab 1.md", byteOffset: 5, byteLimit: 3 });
    expect(bytes).toMatchObject({ content: "one", encoding: "utf8", mode: "bytes", nextByteOffset: 8 });
    const png = await call(reader, "read", { path: "$SOURCES/confluence/d1/image.png" });
    expect(png.encoding).toBe("base64");
    expect(Buffer.from(png.content, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff]));
    const badLines = await call(reader, "read", { path: "$SOURCES/confluence/d1/image.png", offset: 1 });
    expect(badLines.isError).toBe(true);
  });

  it("finds and greps without loading binaries, and rejects traversal", async () => {
    const found = await call(reader, "find", { path: "$SOURCES", pattern: "*.png" });
    expect(found.matches).toEqual(["$SOURCES/confluence/d1/image.png"]);
    const grep = await call(reader, "grep", { path: "$SOURCES", pattern: "needle-[0]", glob: "*.md" });
    expect(grep.matches).toHaveLength(10);
    expect(grep.matches.every((m: any) => m.path.startsWith("$SOURCES/jira/C1/"))).toBe(true);
    const lit = await call(reader, "grep", { path: "$SOURCES/confluence", pattern: "line t", literal: true });
    expect(lit.matches.map((m: any) => m.line)).toEqual([2, 3]);
    expect(lit.filesSkipped).toBe(1);
    for (const bad of ["$SOURCES/../KNOWLEDGE/index.md", "$SOURCES/jira/../../x", "$SOURCES/jira/\u0000"]) {
      const r = await call(reader, "read", { path: bad });
      expect(r.isError, bad).toBe(true);
      expect(r.code).toBe("invalid_path");
    }
  });

  it("explains deletions and serves the full history including the tombstone", async () => {
    const gone = await call(reader, "read", { path: "$SOURCES/jira/C1/gone.md" });
    expect(gone.isError).toBe(true);
    expect(gone.error).toContain("message_deleted");
    const h = await call(reader, "sources_history", { path: "$SOURCES/jira/C1/gone.md" });
    expect(h.versions.map((v: any) => v.kind)).toEqual(["tombstone", "projection"]);
    const prior = await call(reader, "sources_history", { path: "$SOURCES/jira/C1/gone.md", versionId: h.versions[1].versionId });
    expect(prior.content).toBe("soon deleted\nneedle-0\n");
    const wrong = await call(reader, "sources_history", { path: "$SOURCES/jira/C1/2026-10-01.md", versionId: h.versions[1].versionId });
    expect(wrong.isError).toBe(true);
  });

  it("reports coverage and collector health only from the binding's own report", async () => {
    const report = await fetch(`${base}/v1/sources/status-report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [{ provider: "jira", scope: "workspace:T1", state: "partial", reason: "private channels not granted", lastSuccessAt: new Date().toISOString() }], runtime: { reportIntervalSeconds: 60 } }),
    });
    expect(report.status).toBe(200);
    const forbidden = await fetch(`${base}/v1/sources/status-report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [{ provider: "gmail", scope: "x", state: "complete" }] }),
    });
    expect(forbidden.status).toBe(403);
    const st = await call(reader, "sources_status", {});
    const slack = st.providers.find((p: any) => p.provider === "jira");
    expect(slack).toMatchObject({ files: 30, deleted: 1, coverageState: "partial", health: "healthy" });
    expect(slack.coverage[0].reason).toBe("private channels not granted");
    const docs = st.providers.find((p: any) => p.provider === "confluence");
    expect(docs).toMatchObject({ coverageState: "unreported", health: "unreported" });
    const read = await call(reader, "read", { path: "$SOURCES/jira/C1/2026-10-01.md" });
    expect(read.source.coverage).toMatchObject({ state: "partial", health: "healthy" });
  });

  it("keeps publish credentials and reader credentials apart", async () => {
    // Reader/static keys cannot publish; binding tokens cannot read over MCP or admin routes.
    const asReader = await fetch(`${base}/v1/sources/publish`, { method: "POST", headers: { Authorization: `Bearer ${readerKey.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ batchId: "x", changes: [] }) });
    expect(asReader.status).toBe(401);
    await expect(connect(token)).rejects.toThrow();
    expect((await fetch(`${base}/v1/sources/bindings`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    // Device data only enters through the runtime receiver: the generic route mints no device binding for anyone
    // (final-audit H2: a publish-capable device binding bypassed revocation and the office-audio consent gate).
    for (const key of [ingestKey.key, readerKey.key]) {
      const device = await fetch(`${base}/v1/sources/bindings`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "device", providers: ["office-audio"] }) });
      expect(device.status).toBe(400);
      expect(((await device.json()) as { error: { code: string } }).error.code).toBe("use_device_setup");
    }
    const deviceRuntime = await fetch(`${base}/v1/sources/bindings`, { method: "POST", headers: { Authorization: `Bearer ${ingestKey.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind: "runtime", providers: ["*"] }) });
    expect(deviceRuntime.status).toBe(403);
    // A device binding (as minted by device setup) cannot publish.
    const legacy = await app.sources!.bindings.create("acme", { kind: "device", providers: ["imessage"], transport: "runtime-ingest" }, { subject: "u", issuer: "iss" });
    const asDevice = await fetch(`${base}/v1/sources/publish`, { method: "POST", headers: { Authorization: `Bearer ${legacy.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ batchId: "d1", changes: [put("sources/imessage/x.md", "x")] }) });
    expect(asDevice.status).toBe(403);
    // Runtime control routes are absent when no runtime is configured.
    expect((await fetch(`${base}/v1/sources/runtime/status`, { headers: { Authorization: `Bearer ${readerKey.key}` } })).status).toBe(404);
  });
});
