/**
 * @procmem/sdk main entry: trace recorder + transports. No runtime dependency on
 * server code, Modal or Pi. The Pi adapter lives in "./pi-adapter.js" (package
 * subpath "@procmem/sdk/pi").
 */
export {
  TraceRecorder,
  TraceSession,
  TraceDeliveryError,
  REDACTED,
  newSessionId,
  newTraceId,
  type TraceRecorderOptions,
  type RecordExtra,
  type BeginOptions,
  type ChildOptions,
  type FinishOptions,
  type FinishResult,
} from "./recorder.js";
export {
  HttpTraceTransport,
  InProcessTraceTransport,
  TraceTransportError,
  isRetryableStatus,
  type TraceTransport,
  type ChunkAck,
  type HttpTraceTransportOptions,
  type TraceIngestTarget,
} from "./transport.js";
export { MemoryTraceOutbox, TraceOutboxError, OUTBOX_FORMAT, type TraceOutboxStore, type TraceOutboxErrorCode, type OutboxCheckpoint } from "./outbox.js";
export { FileTraceOutbox, type FileTraceOutboxOptions } from "./outbox-file.js";
export { TRACE_BLOB_GZIP_CONTENT_TYPE, TRACE_CHUNK_GZIP_CONTENT_TYPE } from "../traces/schema.js";
export type { TraceCorrelation } from "../traces/schema.js";
export type { AgentInfo, TraceEvent, TraceEventType, TraceChunk, TraceOutcome, TraceUsage, OutcomeStatus, BlobRef } from "../traces/schema.js";
