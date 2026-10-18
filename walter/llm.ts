/** Minimal Fireworks (OpenAI-compatible) chat client with tool calls, retries and token accounting. */
import "./env.js";

export const MODELS = {
  kimi: "accounts/fireworks/models/kimi-k3",
  glm: "accounts/fireworks/models/glm-5p3",
  minimax: "accounts/fireworks/models/minimax-m3",
} as const;

export function fireworksKey(): string {
  if (process.env.FIREWORKS_API_KEY) return process.env.FIREWORKS_API_KEY;
  throw new Error("FIREWORKS_API_KEY missing (.env)");
}

export interface Msg { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ToolSpec { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }

export const usage = { input: 0, output: 0, calls: 0 };

export async function chat(model: string, messages: Msg[], tools: ToolSpec[] = [], opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; retries?: number; json?: boolean } = {}): Promise<Msg> {
  const key = fireworksKey();
  for (let attempt = 0; ; attempt++) {
    const r = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools, tool_choice: "auto" } : {}), max_tokens: opts.maxTokens ?? 4096, temperature: opts.temperature ?? 0.2, ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
    if (r.ok) {
      const j = (await r.json()) as { choices: { message: Msg }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
      usage.calls++;
      usage.input += j.usage?.prompt_tokens ?? 0;
      usage.output += j.usage?.completion_tokens ?? 0;
      const m = j.choices[0]!.message;
      return { role: "assistant", content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
    }
    const text = (await r.text()).slice(0, 400).replace(key, "<redacted>");
    if (attempt >= (opts.retries ?? 4) || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw new Error(`Fireworks ${r.status}: ${text}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
  }
}
