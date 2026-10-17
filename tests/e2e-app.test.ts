/**
 * End-to-end over real HTTP + the real MCP client:
 * SDK trace capture -> ingest -> daily build trigger -> publish -> customer FS MCP.
 * The memory builder here is a SCRIPTED FIXTURE (deterministic, no model);
 * the recursive LLM build harness is covered by tests/build*.test.ts and the live eval.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { generateStaticKey } from "../src/auth/index.js";
import type { MemoryBuilder } from "../src/daily/service.js";
import { LocalLease } from "../src/sandbox/local.js";
import { HttpTraceTransport, TraceRecorder } from "../src/sdk/index.js";
import { MemoryRepo } from "../src/store/memory.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { sniffImage } from "../src/customer/workspace.js";

const fixtureBuilder: MemoryBuilder = async ({ repo, buildId, inputs, sources }) => {
  const base = await repo.ensureHead();
  const files = new Map(await repo.files(base));
  const manifest = JSON.parse(inputs.get("manifest.json") ?? "{}") as { sessions?: Array<{ sessionId: string }> };
  const lines: string[] = [];
  for (const { sessionId } of manifest.sessions ?? []) {
    const events = (inputs.get(`sessions/${sessionId}/events.jsonl`) ?? "").trim().split("\n").filter(Boolean);
    for (const raw of events) {
      const e = JSON.parse(raw) as { seq: number; type: string; data?: { name?: string; error?: string } };
      if (e.type === "error") lines.push(`- Failure observed: ${e.data?.error ?? "error"} (\`${sessionId}#${e.seq}\`)`);
      if (e.type === "tool_call") lines.push(`- Uses tool \`${e.data?.name ?? "?"}\` (\`${sessionId}#${e.seq}\`)`);
    }
  }
  files.set("index.md", "# Procedural memory\n\n- [Workflows](workflows/index.md): recurring procedures.\n");
  files.set("workflows/index.md", "# Workflows\n\nBack to [root](../index.md).\n\n- [Recover deliveries](recover-deliveries.md): retry failed notifications without duplicates.\n");
  files.set("workflows/recover-deliveries.md", `# Recover deliveries\n\nBack to [workflows](index.md).\n\n${lines.join("\n")}\n`);
  const result = await repo.publish(base, files, { buildId, summary: "scripted fixture build", sources });
  return { status: "published", revisionId: result.revisionId, builder: "scripted-fixture" };
};

let dir: string;
const leases: LocalLease[] = [];
let app: App;
let base: string;
let mcpUrl: string;
const tenantA = generateStaticKey("tenant-a", ["memory:read", "traces:write", "memory:build"]);
const tenantB = generateStaticKey("tenant-b", ["memory:read"]);
const ingestOnly = generateStaticKey("tenant-a", ["traces:write"]);
const catalogReader = generateStaticKey("tenant-a", ["integrations:read"]);
const tenantLarge = generateStaticKey("tenant-large", ["memory:read"]);

function env(): NodeJS.ProcessEnv {
  return {
    PORT: "0",
    HOST: "127.0.0.1",
    AUTH_MODE: "static",
    PROCMEM_STATIC_KEYS: [tenantA.entry, tenantB.entry, ingestOnly.entry, catalogReader.entry, tenantLarge.entry].join(","),
    PROCMEM_STORE: "directory",
    PROCMEM_SANDBOX: "local",
    PROCMEM_DATA_DIR: dir,
  };
}

async function start(): Promise<App> {
  const a = await createApp({
    env: env(),
    store: new DirectoryObjectStore(path.join(dir, "objects")),
    builder: fixtureBuilder,
    leaseFactory: async () => {
      const lease = await LocalLease.create();
      leases.push(lease);
      return lease;
    },
    log: () => undefined,
  });
  const bound = await a.listen(0);
  base = bound.url;
  mcpUrl = bound.mcpUrl;
  return a;
}

async function mcp(key?: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : {}),
  );
  return client;
}

function body(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "procmem-e2e-"));
  app = await start();
});

afterAll(async () => {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("view_file media sniffing", () => {
  it("recognizes images by magic bytes only", () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a....", "latin1"))).toBe("image/gif");
    expect(sniffImage(Buffer.from("# not an image"))).toBeNull();
  });
});

describe("procmem end-to-end", () => {
  it("serves unauthenticated liveness probes at /health and /healthz", async () => {
    for (const route of ["/health", "/healthz"]) {
      const res = await fetch(`${base}${route}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, auth: "static" });
    }
  });

  it("rejects unauthenticated MCP and ingest requests", async () => {
    await expect(mcp()).rejects.toThrow();
    const res = await fetch(`${base}/v1/traces/chunks`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const readOnly = await fetch(`${base}/v1/builds/daily`, { method: "POST", headers: { Authorization: `Bearer ${tenantB.key}` }, body: "{}" });
    expect(readOnly.status).toBe(403);
  });

  it("captures traces with the SDK, builds the day, and serves the published wiki over FS-only MCP", async () => {
    const recorder = new TraceRecorder({ transport: new HttpTraceTransport({ baseUrl: base, token: tenantA.key }), agent: { id: "agent-a", model: "fixture" } });
    const session = recorder.begin({ objective: "Recover failed notifications without duplicates" });
    session.toolCall("list_notifications", { status: "failed" }, "c1");
    session.toolResult("list_notifications", "c1", { items: 3, next_cursor: "abc" });
    session.error({ error: "503 temporarily_unavailable on deliver n-4" });
    session.toolCall("deliver", { id: "n-4", idempotency_key: "n-4" }, "c2");
    await session.finish({ status: "succeeded", summary: "delivered all eligible" });
    expect(recorder.errors).toEqual([]);

    const today = new Date().toISOString().slice(0, 10);
    const receipt = (await app.builds.runAndWait("tenant-a", { day: today })) as Record<string, unknown>;
    expect(receipt.status).toBe("published");
    expect(String(receipt.revisionId)).toMatch(/^rev-/);

    const client = await mcp(tenantA.key);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(["cancel_command", "edit", "find", "grep", "ls", "open_memory", "poll_command", "read", "shell", "view_file", "write", "write_command"]);
      const opened = body(await client.callTool({ name: "open_memory", arguments: {} }));
      expect(opened).toMatchObject({ status: "opened", entrypoint: "$KNOWLEDGE/index.md", revision: { id: receipt.revisionId } });
      const workspaceId = String(opened.workspaceId);
      const root = body(await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/index.md", workspaceId } }));
      expect(JSON.stringify(root)).toContain("workflows/index.md");

      const page = body(await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/workflows/recover-deliveries.md", workspaceId } }));
      expect(JSON.stringify(page)).toContain("503 temporarily_unavailable");

      const forbidden = await client.callTool({ name: "write", arguments: { path: "$KNOWLEDGE/index.md", content: "x", workspaceId } });
      expect((forbidden as { isError?: boolean }).isError).toBe(true);

      const scratch = body(await client.callTool({ name: "write", arguments: { path: "$WORK/scratch/notes.md", content: "hello", workspaceId } }));
      expect(scratch.ok).not.toBe(false);
      const back = body(await client.callTool({ name: "read", arguments: { path: "$WORK/scratch/notes.md", workspaceId } }));
      expect(JSON.stringify(back)).toContain("hello");

      // view_file sniffs magic bytes: a Markdown scratch file is not an image, and $KNOWLEDGE has no images.
      const notImage = await client.callTool({ name: "view_file", arguments: { path: "$WORK/scratch/notes.md", workspaceId } });
      expect((notImage as { isError?: boolean }).isError).toBe(true);
      const knowledgeView = await client.callTool({ name: "view_file", arguments: { path: "$KNOWLEDGE/index.md", workspaceId } });
      expect((knowledgeView as { isError?: boolean }).isError).toBe(true);

      const shell = await client.callTool({ name: "shell", arguments: { script: "echo hi", workspaceId } });
      expect((shell as { isError?: boolean }).isError).toBe(true); // local backend never executes commands

      const traces = await client.callTool({ name: "read", arguments: { path: "$WORK/../traces", workspaceId } });
      expect((traces as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("isolates tenants and workspaces", async () => {
    const client = await mcp(tenantB.key);
    try {
      const opened = body(await client.callTool({ name: "open_memory", arguments: {} }));
      expect(opened.status).toBe("opened");
      const root = body(await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/index.md", workspaceId: String(opened.workspaceId) } }));
      expect(JSON.stringify(root)).toContain("No workflows have been learned yet");
      const missing = await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/workflows/recover-deliveries.md" } });
      expect((missing as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("open_memory is a bounded receipt: no wiki contents, outlines or summaries regardless of wiki size", async () => {
    const repo = new MemoryRepo(new DirectoryObjectStore(path.join(dir, "objects")), "tenant-large");
    const SENTINEL = "ROOTSENTINEL_7f3a";
    const pad = (n: number) => "lorem ipsum dolor ".repeat(Math.ceil(n / 18)).slice(0, n);
    const wiki = (tag: string) => {
      const files = new Map<string, string>();
      const links: string[] = [];
      for (let i = 0; i < 60; i++) {
        const subject = `subject-${i}`;
        files.set(`${subject}/index.md`, `# ${tag} SUBJECTSENTINEL_${i} index\n\n- [Page](page.md): ${tag} PAGESENTINEL_${i} ${pad(3000)}\n`);
        files.set(`${subject}/page.md`, `# ${tag} PAGESENTINEL_${i}\n\n${pad(8000)}\n`);
        links.push(`- [${subject}](${subject}/index.md): ${tag} subject ${i}`);
      }
      files.set("index.md", `# ${tag} ${SENTINEL}\n\n${links.join("\n")}\n\n${pad(8900 - links.join("\n").length - 80)}\n`);
      return files;
    };
    const rev1 = (await repo.publish(await repo.ensureHead(), wiki("REV1"), { buildId: "large-1", summary: `SUMMARYSENTINEL ${pad(3500)}`, sources: [] })).revisionId;

    const client = await mcp(tenantLarge.key);
    try {
      const raw = await client.callTool({ name: "open_memory", arguments: {} });
      const text = (raw as { content: Array<{ text: string }> }).content.map((c) => c.text).join("");
      for (const leak of [SENTINEL, "SUBJECTSENTINEL", "PAGESENTINEL", "SUMMARYSENTINEL", "lorem ipsum", "rootIndex", "outline"]) expect(text).not.toContain(leak);
      expect(text.length).toBeLessThan(1_000);
      const opened = JSON.parse(text) as Record<string, unknown>;
      expect(opened).toMatchObject({
        status: "opened",
        entrypoint: "$KNOWLEDGE/index.md",
        revision: { id: rev1, pages: 121 },
        knowledge: { path: "$KNOWLEDGE", readOnly: true },
        scratch: { path: "$WORK/scratch", readOnly: false },
      });
      expect(Object.keys(opened.revision as object).sort()).toEqual(["id", "pages", "publishedAt"]);
      const ws1 = String(opened.workspaceId);

      // Contents arrive only through explicit filesystem reads.
      const root = await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/index.md", workspaceId: ws1 } });
      expect(JSON.stringify(root)).toContain(`REV1 ${SENTINEL}`);

      // A newer publish does not move the already-open workspace; a fresh open pins the latest.
      const rev2 = (await repo.publish(rev1, wiki("REV2"), { buildId: "large-2", summary: "second", sources: [] })).revisionId;
      expect(JSON.stringify(await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/index.md", workspaceId: ws1 } }))).toContain(`REV1 ${SENTINEL}`);
      const reopened = body(await client.callTool({ name: "open_memory", arguments: {} }));
      expect((reopened.revision as { id: string }).id).toBe(rev2);
      expect(reopened.workspaceId).not.toBe(ws1);
      expect(JSON.stringify(await client.callTool({ name: "read", arguments: { path: "$KNOWLEDGE/index.md", workspaceId: String(reopened.workspaceId) } }))).toContain(`REV2 ${SENTINEL}`);
    } finally {
      await client.close();
    }
  });

  it("serves the integration catalog over authenticated HTTP only (not on /mcp)", async () => {
    expect((await fetch(`${base}/v1/integrations`)).status).toBe(401);
    expect((await fetch(`${base}/v1/integrations`, { headers: { Authorization: `Bearer ${tenantA.key}` } })).status).toBe(403);
    const ok = await fetch(`${base}/v1/integrations`, { headers: { Authorization: `Bearer ${catalogReader.key}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ integrations: [], childAuthConfigured: false });
    // No child signing key on this test host: a permanent configuration state, not "not found".
    const token = await fetch(`${base}/v1/integrations/notifications/token`, { method: "POST", headers: { Authorization: `Bearer ${catalogReader.key}` } });
    expect(token.status).toBe(503);
    expect(await token.json()).toMatchObject({ error: { code: "child_auth_not_configured", retryable: false } });
  });

  it("refuses memory tools to an ingest-only key", async () => {
    await expect(mcp(ingestOnly.key)).rejects.toThrow();
  });

  it("keeps two concurrent clients of the same principal in separate pinned workspaces", async () => {
    const c1 = await mcp(tenantA.key);
    const c2 = await mcp(tenantA.key);
    try {
      const w1 = String(body(await c1.callTool({ name: "open_memory", arguments: {} })).workspaceId);
      const w2 = String(body(await c2.callTool({ name: "open_memory", arguments: {} })).workspaceId);
      expect(w1).not.toBe(w2);
      await c1.callTool({ name: "write", arguments: { path: "$WORK/scratch/who.md", content: "client-1", workspaceId: w1 } });
      await c2.callTool({ name: "write", arguments: { path: "$WORK/scratch/who.md", content: "client-2", workspaceId: w2 } });
      expect(JSON.stringify(body(await c1.callTool({ name: "read", arguments: { path: "$WORK/scratch/who.md", workspaceId: w1 } })))).toContain("client-1");
      expect(JSON.stringify(body(await c2.callTool({ name: "read", arguments: { path: "$WORK/scratch/who.md", workspaceId: w2 } })))).toContain("client-2");
      // Omitting workspaceId is refused instead of silently picking another client's scratch.
      const ambiguous = await c1.callTool({ name: "read", arguments: { path: "$WORK/scratch/who.md" } });
      expect((ambiguous as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(ambiguous)).toContain("workspace_ambiguous");
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  it("view_file returns MCP image content (no base64 in the text part)", async () => {
    const client = await mcp(tenantB.key);
    try {
      const opened = body(await client.callTool({ name: "open_memory", arguments: {} }));
      const workspaceId = String(opened.workspaceId);
      await client.callTool({ name: "write", arguments: { path: "$WORK/scratch/touch.md", content: "x", workspaceId } }); // starts the lease
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-image-bytes")]);
      await leases[leases.length - 1]!.writeFiles([{ path: "/work/scratch/chart.png", content: png }]);
      const result = (await client.callTool({ name: "view_file", arguments: { path: "$WORK/scratch/chart.png", workspaceId } })) as {
        isError?: boolean;
        content: Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
      };
      expect(result.isError).not.toBe(true);
      const image = result.content.find((c) => c.type === "image");
      expect(image?.mimeType).toBe("image/png");
      expect(Buffer.from(image!.data!, "base64").equals(png)).toBe(true);
      const text = result.content.find((c) => c.type === "text")!.text!;
      expect(JSON.parse(text)).toMatchObject({ ok: true, mediaType: "image/png", bytes: png.length });
      expect(text).not.toContain(png.toString("base64"));
    } finally {
      await client.close();
    }
  });

  it("serves the same published revision after a cold restart", async () => {
    const before = body(await (await mcp(tenantA.key)).callTool({ name: "open_memory", arguments: {} }));
    await app.close();
    app = await start();
    const client = await mcp(tenantA.key);
    try {
      const after = body(await client.callTool({ name: "open_memory", arguments: {} }));
      expect((after.revision as { id: string }).id).toBe((before.revision as { id: string }).id);
    } finally {
      await client.close();
    }
  });
});
