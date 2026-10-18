# @procmem/sdk

Records agent traces and sends them to a procmem ingest endpoint. A trace covers model inputs and outputs, tool calls, arguments, results, errors, usage and outcomes. The nightly procedural-memory build turns these traces into a versioned wiki of workflows.

- Payloads are sent in full and never truncated. A serialized payload over 64 KiB is uploaded first as a content-addressed blob (sha256). The limit is 32 MiB per payload. Anything over a limit throws instead of being cut down.
- Delivery is batched and idempotent. Events get sequence numbers and are grouped into bounded gzip chunks, each with a stable `chunkSeq`. Network errors, 408, 429 and 5xx are retried with backoff using the same `chunkSeq`, and the server deduplicates. Any other 4xx surfaces as a `TraceDeliveryError`.
- Redaction is off by default: everything you record is sent. To redact before data leaves the process, use `redactKeys` and/or `redact(event)`.
- Node >= 20. The only runtime dependency is `zod`.

## Quickstart

```ts
import { TraceRecorder, HttpTraceTransport } from "@procmem/sdk";

const recorder = new TraceRecorder({
  transport: new HttpTraceTransport({
    baseUrl: "https://memory.example.com",
    token: async () => process.env.PROCMEM_TOKEN!, // tenant comes from the token, never the payload
  }),
  agent: { id: "support-bot", model: "fireworks/kimi-k2", harness: "custom" },
  redactKeys: ["apiKey", "authorization"], // optional, opt-in
});

const session = recorder.begin({ objective: "Refund order o-42" });
session.modelInput({ messages });
session.modelOutput({ message }, { usage: { inputTokens: 1200, outputTokens: 80 } });
session.toolCall("refund", { orderId: "o-42" }, "call-1");
session.toolResult("refund", "call-1", { ok: true });
await session.finish({ status: "succeeded", summary: "Refunded o-42" }); // flushes the final chunk

if (recorder.errors.length) console.warn("trace delivery problems", recorder.errors);
```

`record(type, data, extra?)` returns the event `seq`. Evidence in the built memory cites events as `<sessionId>#<seq>`.

## Pi coding agent

```ts
import { attachPiTraceCapture } from "@procmem/sdk/pi";

const detach = attachPiTraceCapture(piSession, session);
await piSession.prompt("…");
detach();
await session.finish({ status: "succeeded", summary: "…" });
```

The adapter records the following:

- **Every model request:** the effective system prompt and sections, full tool specs and JSON schemas, and the transformed or compacted messages actually sent.
- **Provider wire payloads.**
- **Assistant messages:** text, thinking, tool calls, usage and stop reason.
- **Tool executions:** full arguments, results and error state.
- **Errors.**

API keys, auth headers, cookies and tokens are replaced with `"[REDACTED]"`. Pi types are imported as types only, so Pi is not a runtime dependency.

## Wire protocol

| Route | Body |
| --- | --- |
| `POST /v1/traces/chunks` | gzip JSON `{sessionId, chunkSeq, events[], final?}`, `Content-Type: application/vnd.procmem.trace-chunk+gzip; encoding=base64` (base64 of the gzip bytes, the default, safe through hosts that decode bodies as text). Raw gzip without `encoding=base64` (`bodyEncoding: "binary"`) and plain `application/json` are also accepted. |
| `PUT /v1/traces/blobs/:sha256` | gzip bytes (base64 by default), `Content-Type: application/vnd.procmem.trace-blob+gzip; encoding=base64`, with `X-Procmem-Media-Type` set to the payload type |

Limits:

- 2 MiB decoded and 1000 events per chunk.
- 32 MiB per blob.

Over-limit requests are rejected with JSON `{error: {code, message}}`.

## Live tools: every tenant MCP, updated at runtime

`@procmem/sdk/live` exposes the memory MCP (`memory__*`) and every integration MCP deployed for your tenant
(`integration__<slug>__*`). Tools that are added, changed or removed are picked up without restarting your harness.
Full guide: `docs/sdk-live-tools.md`.

```ts
import { LiveToolRegistry, ToolBoundary, oauthParentCredential } from "@procmem/sdk/live";
import { createPiLiveTools } from "@procmem/sdk/live/pi";        // Pi 1.3 adapter (extension factory)
import { FileTokenStore, OAuthRefreshProvider } from "@procmem/sdk/oauth";

const registry = new LiveToolRegistry({ parent: { baseUrl, credential: () => key } }); // or ...oauthParentCredential(provider)
await registry.start();
registry.onToolsChanged(({ added, updated, removed }) => { /* ... */ });
const view = new ToolBoundary(registry); // call view.sync() between model requests; view.callTool(name, args)
```

MCP clients that configure servers at startup can run the stdio bridge. Credentials go in the environment only:

```bash
PROCMEM_BASE_URL=https://memory.example.com PROCMEM_API_KEY=pmk_... npx procmem-live-mcp
```

Runtime dependencies are `@modelcontextprotocol/client` and `@modelcontextprotocol/server` (~2.3.1), plus `zod`.

## Conversations, runs, turns and spans

Every session carries a first-class correlation on every chunk:

```ts
const s = recorder.begin({
  objective: "refund order o-42",
  conversationId: "slack:C123/1700000000.42", // your thread/conversation id; default: generated
  runId: "run-7",                              // one execution attempt; default: generated
  previousRunId: "run-6",                      // optional: this run retries run-6 (same conversation, new run)
});
s.startTurn();                                 // one user turn; later events carry turnId
s.toolCall("spawn_agent", args, "call-1", { spanId: "tool.call-1", parentSpanId: "req-1" });
const child = s.child({ objective: "research", parentSpanId: "tool.call-1" }); // same conversation + run, linked to its parent
```

- **Days are not boundaries.** A conversation can span any number of sessions, runs (retries) and days. Days only
  partition the server's receipt storage and the daily build windows.
- **The server binds each session's correlation once.** A chunk that tries to change it, including a resend of an
  already-stored chunk, is rejected (409).
- **Child sessions.** A child may arrive before its parent. It is accepted and marked `pending`, then becomes `verified`
  or `mismatch` once the parent arrives.
- **Pi.** `beginPiTrace(recorder, piSession, { objective })` derives the conversation from Pi's session id
  (`pi:<sessionId>`) and attaches capture.
  - One turnId per user prompt, steer or follow-up. Automatic retry and context-overflow continuation stay in the same
    turn.
  - Each model request gets a span, and each tool call gets a span parented by its tool call id.

## Durable delivery (opt-in, restart-safe)

```ts
import { FileTraceOutbox, TraceRecorder } from "@procmem/sdk";
const recorder = new TraceRecorder({ transport, agent, outbox: new FileTraceOutbox("/var/lib/my-agent/trace-outbox") });

const s = recorder.begin({ objective: "long task", conversationId: threadId });
s.note({ step: 1 });
await s.checkpoint();            // DURABLE from here (persisted, not yet sent)

// after a crash / restart:
for (const id of await recorder.pendingSessions()) {
  const resumed = await recorder.resume(id);   // verifies digests, takes ownership
  await resumed.flush();                       // resends unacked chunks (server deduplicates)
}
```

- **Durability boundary.** `record()` is synchronous and in memory. Events become crash-safe only once
  `await session.checkpoint()` or `flush()` has persisted them. The background flush (`flushIntervalMs`) also persists
  them. Events recorded after the last checkpoint are lost in a crash, and are never half-delivered.
- **Restarts.** A resumed session never reuses a seq or chunkSeq. A delivered `finish()` leaves a tombstone, so the id
  cannot be begun again. A second (stale) writer of the same session fails closed (`TraceOutboxError` `ownership_lost`).
- **`FileTraceOutbox` keeps raw traces private.** Directories are 0700 and files 0600, symlinks are refused, writes are
  atomic, and CAS runs under a cross-process lock. Nothing is ever posted anywhere except your transport.
- **Other storage.** For browsers or custom storage, implement `TraceOutboxStore`, which needs a checkpoint CAS and
  immutable objects (see `MemoryTraceOutbox`).
