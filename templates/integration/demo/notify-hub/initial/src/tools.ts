import { z } from "zod";
import type { MCPServer } from "mcp-use";
import manifest from "../integration.json" with { type: "json" };
import { NotifyHubClient, NotifyHubError } from "./client.ts";
import { createSimulatedFetch } from "./simulated-upstream.ts";

type EnvVar = { name: string; required: boolean; secret: boolean; description?: string };

let simulated: typeof fetch | null = null;

function client(): NotifyHubClient {
  if (process.env.NOTIFY_HUB_SIMULATED === "1") {
    simulated ??= createSimulatedFetch({ seed: 23, maxPageSize: 10, postFailures: ["503_after_commit"] });
    return new NotifyHubClient({ baseUrl: "https://notify-hub.simulated.invalid", token: "simulated", fetchImpl: simulated });
  }
  const baseUrl = process.env.NOTIFY_HUB_BASE_URL;
  const token = process.env.NOTIFY_HUB_TOKEN;
  if (!baseUrl || !token) throw new NotifyHubError(0, "not_configured", "NOTIFY_HUB_BASE_URL and NOTIFY_HUB_TOKEN must be configured");
  return new NotifyHubClient({ baseUrl, token });
}

function toolError(error: unknown) {
  const e = error instanceof NotifyHubError ? { code: error.code, status: error.status, message: error.message } : { code: "internal_error", status: 0, message: String((error as Error)?.message ?? error) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(e) }], structuredContent: e };
}

export function registerTools(server: MCPServer) {
  server.tool(
    {
      name: "integration_info",
      description: "Describe this integration: upstream service, tools, and required configuration (never secret values).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const info = { slug: manifest.slug, title: manifest.title, upstream: manifest.upstream, tools: manifest.tools, env: (manifest.env as EnvVar[]).map((e) => ({ name: e.name, required: e.required, secret: e.secret })) };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  server.tool(
    {
      name: "list_notifications",
      description: "List notifications from Notify Hub, optionally for one recipient.",
      inputSchema: z.object({ recipient: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ recipient }) => {
      try {
        const { items, pages } = await client().listAll(recipient ? { recipient } : {});
        const out = { count: items.length, pages, items };
        return { content: [{ type: "text", text: `${items.length} notifications` }], structuredContent: out };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    {
      name: "send_notification",
      description: "Send one notification through Notify Hub.",
      inputSchema: z.object({ recipient: z.string().min(1), message: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient, message }) => {
      try {
        const r = await client().send({ recipient, message });
        const out = { ...r.notification, attempts: r.attempts, replayed: r.replayed };
        return { content: [{ type: "text", text: `sent ${r.notification.id}` }], structuredContent: out };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    {
      name: "get_notification",
      description: "Fetch one notification by id.",
      inputSchema: z.object({ id: z.string().regex(/^ntf_[0-9]{4,}$/) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const n = await client().get(id);
        return { content: [{ type: "text", text: JSON.stringify(n) }], structuredContent: n };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
