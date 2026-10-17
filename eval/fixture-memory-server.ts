/**
 * OFFLINE FIXTURE ONLY ("scripted-fixture"): a tiny mcp-use server that mimics the shape of the
 * product's customer memory MCP (open_memory / read / ls) with CANNED wiki content, plus a fake
 * "daily build" that publishes that canned content. Used by tests and `eval/run.ts --offline` so
 * the harness can be exercised without the product server. Never reported as a real build.
 */
import { MCPServer } from "mcp-use";
import { z } from "zod";

const EMPTY_INDEX = "# Procedural memory\n\n(no workflows published yet)\n";

export const FIXTURE_WIKI: Record<string, string> = {
  "index.md":
    "# Procedural memory\n\n- [Notification re-delivery](notifications/redelivery.md): re-sending failed notifications safely.\n",
  "notifications/redelivery.md": [
    "# Re-delivering failed notifications",
    "",
    "1. list_notifications(status=failed, channel=<target>) and follow next_cursor until null (page size is 3).",
    "2. Retry 429 (list) and 503 (deliver) responses; 503 can happen after the delivery was committed.",
    "3. Skip status failed_permanent (409), records without recipient or with an invalid channel (422).",
    "4. get_deliveries first: some 'failed' records were already delivered.",
    "5. Always deliver with idempotency_key = notification id so retries are deduplicated.",
    "",
  ].join("\n"),
};

export interface FixtureMemoryServer {
  url: string;
  headers: Record<string, string>;
  /** Fake daily build: publishes FIXTURE_WIKI as a new revision. */
  publish(): { revisionId: string; files: number; label: "scripted-fixture" };
  calls(): Record<string, number>;
  close(): Promise<void>;
}

export async function startFixtureMemoryServer(token = "fixture-token"): Promise<FixtureMemoryServer> {
  let files: Record<string, string> = { "index.md": EMPTY_INDEX };
  let revision = "rev-empty";
  const calls: Record<string, number> = {};
  const count = (n: string) => (calls[n] = (calls[n] ?? 0) + 1);
  const server = new MCPServer({ name: "fixture-memory", version: "0.0.1" });
  server.app.use("/mcp", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  server.tool(
    {
      name: "open_memory",
      description: "Pin the latest memory revision into a workspace; returns a small receipt (no contents). Then read $KNOWLEDGE/index.md.",
      inputSchema: z.object({}),
    },
    async () => {
      count("open_memory");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "opened", workspaceId: "fixture", revision: { id: revision, pages: Object.keys(files).length }, entrypoint: "$KNOWLEDGE/index.md" }),
          },
        ],
      };
    },
  );
  server.tool(
    { name: "read", description: "Read a file under $KNOWLEDGE.", inputSchema: z.object({ path: z.string(), workspaceId: z.string().optional() }) },
    async ({ path }) => {
      count("read");
      const rel = path.replace(/^\$KNOWLEDGE\/?/, "");
      const body = files[rel];
      return body === undefined
        ? { content: [{ type: "text", text: `not found: ${path}` }], isError: true }
        : { content: [{ type: "text", text: body }] };
    },
  );
  server.tool(
    { name: "ls", description: "List files under $KNOWLEDGE.", inputSchema: z.object({ path: z.string().optional() }) },
    async () => {
      count("ls");
      return { content: [{ type: "text", text: Object.keys(files).sort().join("\n") }] };
    },
  );
  const { url } = await server.listen(0, { host: "127.0.0.1" });
  return {
    url,
    headers: { Authorization: `Bearer ${token}` },
    publish: () => {
      files = { ...FIXTURE_WIKI };
      revision = "rev-fixture-1";
      return { revisionId: revision, files: Object.keys(files).length, label: "scripted-fixture" };
    },
    calls: () => ({ ...calls }),
    close: () => server.close(),
  };
}
