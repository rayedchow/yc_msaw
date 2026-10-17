/**
 * Wires the real customer trace SDK (src/sdk: TraceRecorder + attachPiTraceCapture) into the
 * per-episode TraceSessionFactory used by eval/pi-agent.ts, and provides an inspecting "tee"
 * transport so the eval can assert what was actually captured (e.g. that model_input contains the
 * per-request system prompt and tool specs).
 */
import { gunzipSync } from "node:zlib";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { attachPiTraceCapture, HttpTraceTransport, TraceRecorder, type ChunkAck, type TraceTransport } from "../src/sdk/index.js";
import type { TraceChunk } from "../src/traces/schema.js";
import { SYSTEM_PROMPT_MARKER, type EpisodeMeta, type TraceSessionFactory } from "./pi-agent.js";
import { WORLD_TOOL_NAMES } from "./world/pi-tools.js";

/** Fragments of the list_notifications tool description and of its JSON parameter schema. */
export const TOOL_SPEC_MARKER = "GET /notifications.";
export const TOOL_SCHEMA_MARKER = "Opaque cursor from a previous response's next_cursor";

export function traceSessionId(episodeId: string): string {
  let s = episodeId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  if (s.length < 3) s = `ep-${s}xx`;
  return s.slice(0, 96);
}

export interface CaptureInspection {
  sessionId: string;
  chunks: number;
  events: number;
  eventTypes: Record<string, number>;
  blobs: number;
  /** A model_input event contains the agent's actual system prompt. */
  modelInputHasSystemPrompt: boolean;
  /** A model_input event contains the declared tool specs (names + descriptions). */
  modelInputHasToolSpecs: boolean;
  finalChunkSeen: boolean;
  outcomeStatus?: string;
}

/** Tee transport: forwards everything to `inner` and records what was captured per session. */
export class InspectingTraceTransport implements TraceTransport {
  private readonly blobs = new Map<string, string>();
  private readonly sessions = new Map<string, CaptureInspection>();

  constructor(private readonly inner: TraceTransport) {}

  async putBlob(sha256: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    await this.inner.putBlob(sha256, bytes, mediaType);
    let text: string;
    try {
      text = Buffer.from(bytes).toString("utf8");
      if (/gzip/.test(mediaType)) text = gunzipSync(bytes).toString("utf8");
    } catch {
      text = "";
    }
    this.blobs.set(sha256, text);
  }

  async sendChunk(chunk: TraceChunk): Promise<ChunkAck> {
    const ack = await this.inner.sendChunk(chunk);
    const s =
      this.sessions.get(chunk.sessionId) ??
      ({
        sessionId: chunk.sessionId,
        chunks: 0,
        events: 0,
        eventTypes: {},
        blobs: 0,
        modelInputHasSystemPrompt: false,
        modelInputHasToolSpecs: false,
        finalChunkSeen: false,
      } satisfies CaptureInspection);
    s.chunks += 1;
    if (chunk.final) s.finalChunkSeen = true;
    for (const e of chunk.events) {
      s.events += 1;
      s.eventTypes[e.type] = (s.eventTypes[e.type] ?? 0) + 1;
      const data = e.data as { $blob?: unknown } | null;
      let text: string;
      if (data && typeof data === "object" && typeof data.$blob === "string") {
        s.blobs += 1;
        text = this.blobs.get(data.$blob) ?? "";
      } else {
        text = JSON.stringify(e.data) ?? "";
      }
      if (e.type === "model_input") {
        if (text.includes(SYSTEM_PROMPT_MARKER)) s.modelInputHasSystemPrompt = true;
        if (text.includes(TOOL_SPEC_MARKER) && text.includes(TOOL_SCHEMA_MARKER) && WORLD_TOOL_NAMES.every((n) => text.includes(n))) {
          s.modelInputHasToolSpecs = true;
        }
      }
      if (e.type === "session_end" && e.outcome) s.outcomeStatus = e.outcome.status;
    }
    this.sessions.set(chunk.sessionId, s);
    return ack;
  }

  inspect(sessionId: string): CaptureInspection | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s, eventTypes: { ...s.eventTypes } } : undefined;
  }
}

/**
 * TraceSessionFactory over a TraceTransport (HttpTraceTransport or InProcessTraceTransport): one
 * TraceRecorder per episode (agent identity = model), one trace session per episode.
 */
export function traceFactoryFromTransport(transport: TraceTransport, harness = "pi-coding-agent@1.3.0"): TraceSessionFactory {
  return (meta: EpisodeMeta) => {
    const model = meta.model.split("/").pop() ?? meta.model;
    const recorder = new TraceRecorder({
      transport,
      agent: {
        id: `eval-agent-${model}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
        name: "notification-ops-agent",
        model: meta.model,
        harness,
      },
      flushIntervalMs: 1000,
    });
    const sessionId = traceSessionId(meta.episodeId);
    const ts = recorder.begin({
      objective: meta.objective,
      sessionId,
      metadata: { scenario: meta.scenario, condition: meta.condition, harness: "eval/pi-agent.ts" },
    });
    return {
      sessionId,
      attach: (session: AgentSession) => attachPiTraceCapture(session, ts),
      finish: async (outcome) => {
        const r = await ts.finish(outcome);
        if (r.errors.length > 0) throw new Error(`trace delivery errors: ${r.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
      },
    };
  };
}

export function httpTraceFactory(baseUrl: string, token: string): { factory: TraceSessionFactory; inspector: InspectingTraceTransport } {
  const inspector = new InspectingTraceTransport(new HttpTraceTransport({ baseUrl, token }));
  return { factory: traceFactoryFromTransport(inspector), inspector };
}
