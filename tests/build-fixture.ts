/**
 * TEST FIXTURE - scripted ChatClient.
 *
 * Each agent id maps to a deterministic list of tool-call steps written by the
 * test author. These scripts exercise the harness runtime (scopes, merges,
 * budgets, publication); they are NOT model behavior and must never be
 * reported as such. Live model behavior is only measured by the gated live
 * smoke (src/harness/live-smoke.ts).
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatClient, ChatMessage, ChatResult, ToolSpec } from "../src/harness/llm.js";
import type { ChatClientFactory } from "../src/harness/profiles.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { MemoryRepo } from "../src/store/memory.js";

export interface ScriptCall {
  name: string;
  args?: unknown;
  /** Raw arguments string sent verbatim (e.g. invalid JSON), overriding args. */
  rawArguments?: string;
}
export interface StepContext {
  agentId: string;
  /** Parsed tool results of the previous step, in call order. */
  last: Array<{ name: string; result: any }>;
}
export type ScriptStep = ScriptCall[] | { text: string } | ((ctx: StepContext) => ScriptCall[] | Promise<ScriptCall[]>);

export interface ScriptedRun {
  factory: ChatClientFactory;
  /** Every tool result seen by each agent (parsed JSON), for assertions. */
  results: Record<string, Array<{ name: string; result: any }>>;
  toolsSeen: Record<string, string[]>;
  systemPrompts: Record<string, string>;
  /** Messages of the first and the most recent request per agent. */
  firstMessages: Record<string, ChatMessage[]>;
  lastMessages: Record<string, ChatMessage[]>;
}

/**
 * Scripts keyed by agent id. When the same agent id is created more than once
 * (e.g. a rebuild attempt), "<agentId>#<n>" (1-based) takes precedence.
 */
export function scripted(scripts: Record<string, ScriptStep[]>): ScriptedRun {
  const run: ScriptedRun = { factory: undefined as never, results: {}, toolsSeen: {}, systemPrompts: {}, firstMessages: {}, lastMessages: {} };
  const created = new Map<string, number>();
  run.factory = (profile, ctx) => {
    const n = (created.get(ctx.agentId) ?? 0) + 1;
    created.set(ctx.agentId, n);
    const steps = scripts[`${ctx.agentId}#${n}`] ?? scripts[ctx.agentId] ?? [];
    let i = 0;
    let callSeq = 0;
    const client: ChatClient = {
      model: `fixture:${profile.model}`,
      async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
        run.toolsSeen[ctx.agentId] = tools.map((t) => t.function.name);
        run.systemPrompts[ctx.agentId] = messages[0]?.content ?? "";
        run.firstMessages[ctx.agentId] ??= [...messages];
        run.lastMessages[ctx.agentId] = [...messages];
        // Collect tool results answering the previous assistant message.
        const last: StepContext["last"] = [];
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (lastAssistant?.tool_calls) {
          for (const call of lastAssistant.tool_calls) {
            const msg = messages.find((m) => m.role === "tool" && m.tool_call_id === call.id);
            if (!msg) continue;
            let parsed: any;
            try {
              parsed = JSON.parse(msg.content ?? "");
            } catch {
              parsed = { raw: msg.content };
            }
            last.push({ name: call.function.name, result: parsed });
            (run.results[ctx.agentId] ??= []).push({ name: call.function.name, result: parsed });
          }
        }
        const step = steps[i++];
        let message: ChatMessage;
        if (step === undefined) message = { role: "assistant", content: "(fixture script exhausted)" };
        else if (!Array.isArray(step) && typeof step === "object") message = { role: "assistant", content: step.text };
        else {
          const calls = typeof step === "function" ? await step({ agentId: ctx.agentId, last }) : step;
          message = {
            role: "assistant",
            content: null,
            tool_calls: calls.map((c) => ({ id: `call_${ctx.agentId}_${++callSeq}`, type: "function" as const, function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.args ?? {}) } })),
          };
        }
        return { message, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, finishReason: "stop", latencyMs: 1 };
      },
    };
    return client;
  };
  return run;
}

export async function tempRepo(): Promise<MemoryRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "procmem-build-test-"));
  return new MemoryRepo(new DirectoryObjectStore(dir), "tenant-test");
}

export async function seedRepo(repo: MemoryRepo, files: Record<string, string>): Promise<string> {
  const head = await repo.ensureHead();
  const r = await repo.publish(head, new Map(Object.entries(files)), { buildId: "seed", summary: "seed", sources: [] });
  return r.revisionId;
}

/** Tiny synthetic trace cohort in the inputs/ layout (fixture data, not captured traces). */
export function fixtureInputs(): Map<string, string> {
  const events = [
    { seq: 1, type: "tool_call", tool: "billing.refund", args: { chargeId: "ch_1" } },
    { seq: 2, type: "tool_error", tool: "billing.refund", error: "409 idempotency key required" },
    { seq: 3, type: "tool_call", tool: "billing.refund", args: { chargeId: "ch_1", idempotencyKey: "k1" } },
    { seq: 4, type: "tool_result", tool: "billing.refund", result: { status: "refunded" } },
  ];
  return new Map([
    ["manifest.json", JSON.stringify({ day: "2026-10-16", sessions: ["s1"], watermark: 4 })],
    ["sessions/s1/session.json", JSON.stringify({ sessionId: "s1", objective: "Refund a charge", outcome: { reported: "success" } })],
    ["sessions/s1/events.jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n"],
  ]);
}
