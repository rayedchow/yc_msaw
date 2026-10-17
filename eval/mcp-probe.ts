/**
 * Prove that Pi's real MCP extension (createMcpExtension) can talk to an mcp-use 2.x MCPServer over
 * Streamable HTTP, with no LLM: a Pi faux (scripted, offline) model issues the MCP tool call, so the
 * call goes through Pi's normal tool pipeline -> MCP client -> HTTP -> mcp-use server.
 *
 * Label: "scripted-fixture" (no live model).
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { createIsolatedPiSession, waitForTools } from "./pi-agent.js";

export interface McpProbeResult {
  label: "scripted-fixture";
  serverUrl: string;
  activeTools: string[];
  toolCallResultText?: string;
  toolCallIsError?: boolean;
  serverSawCalls: number;
  serverSawAuthHeader: boolean;
  ok: boolean;
  error?: string;
}

export async function startProbeServer(): Promise<{ url: string; calls: () => number; sawAuth: () => boolean; close: () => Promise<void> }> {
  let calls = 0;
  let sawAuth = false;
  const server = new MCPServer({ name: "probe", version: "0.0.1" });
  server.app.use("*", async (c, next) => {
    if (c.req.header("authorization") === "Bearer probe-token") sawAuth = true;
    await next();
  });
  server.tool(
    {
      name: "echo",
      description: "Echo the given text back, uppercased.",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }) => {
      calls += 1;
      return { content: [{ type: "text", text: `ECHO:${text.toUpperCase()}` }] };
    },
  );
  const { url } = await server.listen(0, { host: "127.0.0.1" });
  return { url, calls: () => calls, sawAuth: () => sawAuth, close: () => server.close() };
}

export async function runMcpProbe(): Promise<McpProbeResult> {
  const srv = await startProbeServer();
  let resultText: string | undefined;
  let resultIsError: boolean | undefined;
  let activeTools: string[] = [];
  let error: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const faux = fauxProvider({ provider: "faux-probe", models: [{ id: "probe-model" }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__memory__echo", { text: "hello mcp" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const created = await createIsolatedPiSession({
      runtime,
      model: faux.getModel() as Model<Api>,
      systemPrompt: "probe",
      customTools: [],
      toolAllowlist: ["mcp__memory__*"],
      mcp: { url: srv.url, headers: { Authorization: "Bearer probe-token" } },
      thinkingLevel: "off",
    });
    cleanup = created.cleanup;
    const session = created.session;
    await waitForTools(session, "mcp__memory__", 15_000);
    activeTools = session.getActiveToolNames().slice().sort();
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "mcp__memory__echo") {
        const r = event.result as { content?: Array<{ type: string; text?: string }> };
        resultText = r.content?.map((c) => c.text ?? "").join("");
        resultIsError = event.isError;
      }
    });
    await session.prompt("call the echo tool");
    session.dispose();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await cleanup?.();
    await srv.close();
  }
  const ok =
    !error &&
    activeTools.includes("mcp__memory__echo") &&
    resultText === "ECHO:HELLO MCP" &&
    srv.calls() === 1 &&
    srv.sawAuth();
  return {
    label: "scripted-fixture",
    serverUrl: srv.url.replace(/:\d+/, ":<port>"),
    activeTools,
    ...(resultText !== undefined ? { toolCallResultText: resultText } : {}),
    ...(resultIsError !== undefined ? { toolCallIsError: resultIsError } : {}),
    serverSawCalls: srv.calls(),
    serverSawAuthHeader: srv.sawAuth(),
    ok,
    ...(error ? { error } : {}),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpProbe().then(
    (r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    },
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
