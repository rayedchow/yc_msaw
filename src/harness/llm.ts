import { truncate, withTimeout } from "../util.js";

/** Minimal OpenAI-compatible chat-completions client (Fireworks). Only the model API key is ever sent. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage: ChatUsage;
  finishReason: string;
  latencyMs: number;
}

export interface ChatClient {
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolSpec[], opts?: { signal?: AbortSignal }): Promise<ChatResult>;
}

export class LlmError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
  }
}

export class OpenAICompatibleClient implements ChatClient {
  constructor(
    readonly model: string,
    private readonly opts: { apiKey: string; baseUrl?: string; timeoutMs?: number; maxTokens?: number; temperature?: number; maxRetries?: number },
  ) {
    if (!opts.apiKey) throw new Error("Missing model API key");
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], { signal }: { signal?: AbortSignal } = {}): Promise<ChatResult> {
    const baseUrl = this.opts.baseUrl ?? "https://api.fireworks.ai/inference/v1";
    const body = {
      model: this.model,
      messages: messages.map(({ reasoning_content: _r, ...m }) => m),
      tools,
      tool_choice: "auto",
      max_tokens: this.opts.maxTokens ?? 8192,
      temperature: this.opts.temperature ?? 0.2,
    };
    const maxRetries = this.opts.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      // One deadline covers connect, headers AND body; it aborts the request rather than abandoning it.
      const deadline = AbortSignal.timeout(this.opts.timeoutMs ?? 180_000);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        const text = await readBounded(response, MAX_RESPONSE_BYTES);
        if (!response.ok) {
          // Never echo request headers; the body is the provider's error message.
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new LlmError(`Model API ${response.status}: ${truncate(text, 400)}`, response.status, retryable);
        }
        const json = JSON.parse(text) as {
          choices?: Array<{ message: ChatMessage; finish_reason: string }>;
          usage?: Partial<ChatUsage>;
        };
        const choice = json.choices?.[0];
        if (!choice) throw new LlmError("Model API returned no choices", response.status, true);
        return {
          message: {
            role: "assistant",
            content: choice.message.content ?? null,
            tool_calls: choice.message.tool_calls,
            reasoning_content: choice.message.reasoning_content,
          },
          usage: {
            prompt_tokens: json.usage?.prompt_tokens ?? 0,
            completion_tokens: json.usage?.completion_tokens ?? 0,
            total_tokens: json.usage?.total_tokens ?? 0,
          },
          finishReason: choice.finish_reason,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        const timedOut = deadline.aborted;
        const retryable = error instanceof LlmError ? error.retryable : true;
        const fatal = error instanceof LlmError && (error.status === 401 || error.status === 403);
        if (fatal || !retryable || attempt >= maxRetries) {
          if (timedOut) throw new LlmError(`chat completion (${this.model}) timed out after ${this.opts.timeoutMs ?? 180_000}ms`, null, true);
          throw error;
        }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Read a response body with a hard byte ceiling (the request signal bounds time). */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new LlmError(`Model API response exceeded ${maxBytes} bytes`, response.status, false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Tiny authenticated request used before any eval loop so a bad key never triggers repeated charged calls. */
export async function validateFireworksKey(apiKey: string, baseUrl = "https://api.fireworks.ai/inference/v1"): Promise<{ ok: boolean; status: number; models: string[] }> {
  const response = await withTimeout(fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }), 20_000, "Fireworks key check");
  if (!response.ok) return { ok: false, status: response.status, models: [] };
  const json = (await response.json()) as { data?: Array<{ id: string }> };
  return { ok: true, status: response.status, models: (json.data ?? []).map((m) => m.id) };
}
