/**
 * Offline "scripted-fixture" agents: a Pi faux model whose every response is decided by a scripted
 * TypeScript policy (no LLM, no network, no cost). The tool calls still go through the real Pi
 * session, tool pipeline, MCP extension, and trace capture, so the harness wiring is exercised
 * end to end. Results are ALWAYS labeled "scripted-fixture", never as live model runs.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MEMORY_SERVER_NAME } from "./pi-agent.js";
import { SCRIPTED_POLICIES, type ApiClient, type ScriptedPolicyName } from "./scripted-policies.js";
import type { ApiResponse } from "./world/notifications.js";

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
}

export interface ScriptedAgentContext {
  call(toolName: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
}

/** A scripted agent issues tool calls and returns its final text. */
export type ScriptedAgent = (ctx: ScriptedAgentContext) => Promise<string>;

type Action = { kind: "call"; name: string; args: Record<string, unknown>; id: string } | { kind: "final"; text: string };

let fixtureSeq = 0;

export async function createScriptedFixtureModel(
  agent: ScriptedAgent,
  maxSteps = 400,
): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  fixtureSeq += 1;
  const faux = fauxProvider({ provider: `scripted-fixture-${fixtureSeq}`, models: [{ id: "scripted-policy" }] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);

  let pending: Action | undefined;
  let actionWaiter: ((a: Action) => void) | undefined;
  let resultWaiter: ((r: ToolCallOutcome) => void) | undefined;
  let started = false;
  let callSeq = 0;
  const emit = (a: Action) => {
    if (actionWaiter) {
      const w = actionWaiter;
      actionWaiter = undefined;
      w(a);
    } else pending = a;
  };
  const nextAction = (): Promise<Action> => {
    if (pending) {
      const a = pending;
      pending = undefined;
      return Promise.resolve(a);
    }
    return new Promise((r) => (actionWaiter = r));
  };
  const ctx: ScriptedAgentContext = {
    call: (name, args) =>
      new Promise<ToolCallOutcome>((res) => {
        resultWaiter = res;
        callSeq += 1;
        emit({ kind: "call", name, args, id: `scripted_${callSeq}` });
      }),
  };

  const step = async (context: { messages: ReadonlyArray<unknown> }) => {
    if (!started) {
      started = true;
      void agent(ctx).then(
        (text) => emit({ kind: "final", text }),
        (err: unknown) => emit({ kind: "final", text: `scripted policy error: ${err instanceof Error ? err.message : String(err)}` }),
      );
    } else if (resultWaiter) {
      const msgs = context.messages as Array<{ role?: string; content?: Array<{ type: string; text?: string }>; isError?: boolean }>;
      let last: (typeof msgs)[number] | undefined;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "toolResult") {
          last = msgs[i];
          break;
        }
      }
      const w = resultWaiter;
      resultWaiter = undefined;
      w({
        text: (last?.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""),
        isError: Boolean(last?.isError),
      });
    }
    const a = await nextAction();
    return a.kind === "call"
      ? fauxAssistantMessage(fauxToolCall(a.name, a.args as Parameters<typeof fauxToolCall>[1], { id: a.id }), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxText(a.text));
  };
  faux.setResponses(Array.from({ length: maxSteps }, () => step));
  return { runtime, model: faux.getModel() as Model<Api> };
}

/** ApiClient that goes through Pi tool calls to the world tools. */
export function toolCallClient(ctx: ScriptedAgentContext): ApiClient {
  const parse = (o: ToolCallOutcome): ApiResponse => {
    try {
      const v = JSON.parse(o.text) as { http_status: number; headers?: Record<string, string>; body: unknown };
      return { status: v.http_status, headers: v.headers ?? {}, body: v.body };
    } catch {
      return { status: 599, headers: {}, body: { error: "tool_error", message: o.text.slice(0, 300) } };
    }
  };
  return {
    listNotifications: async (a) => parse(await ctx.call("list_notifications", { ...a })),
    getDeliveries: async (a) => parse(await ctx.call("get_deliveries", { ...a })),
    deliver: async (a) => parse(await ctx.call("deliver", { ...a })),
  };
}

export interface ScriptedAgentSpec {
  channel: string;
  /** Policy used when no memory is consulted, or memory gives no relevant guidance. */
  basePolicy: ScriptedPolicyName;
  /** If set, open the memory MCP first; when it mentions any of `guidanceKeywords`, switch to this policy. */
  memoryPolicy?: ScriptedPolicyName;
  guidanceKeywords?: RegExp;
}

/** Scripted agent: optionally consult memory (open_memory over MCP), then run a policy via tool calls. */
export function scriptedNotificationAgent(spec: ScriptedAgentSpec): ScriptedAgent {
  return async (ctx) => {
    let policy: ScriptedPolicyName = spec.basePolicy;
    let consulted = "";
    if (spec.memoryPolicy) {
      const opened = await ctx.call(`mcp__${MEMORY_SERVER_NAME}__open_memory`, {});
      consulted = opened.text;
      // Follow up to 5 markdown links from the root index (e.g. "(notifications/redelivery.md)").
      const links = [...new Set([...consulted.matchAll(/\(([\w./-]+\.md)\)/g)].map((m) => m[1]!))].slice(0, 5);
      for (const link of links) {
        const page = await ctx.call(`mcp__${MEMORY_SERVER_NAME}__read`, { path: `$KNOWLEDGE/${link.replace(/^\.?\//, "")}` });
        if (!page.isError) consulted += `\n${page.text}`;
      }
      if ((spec.guidanceKeywords ?? /idempot/i).test(consulted)) policy = spec.memoryPolicy;
    }
    await SCRIPTED_POLICIES[policy](toolCallClient(ctx), spec.channel);
    return `scripted policy "${policy}" finished${spec.memoryPolicy ? ` (memory consulted: ${consulted.length} chars)` : ""}.`;
  };
}
