/** In-repo SDK entry: client API plus the Pi adapter. */
export * from "./client.js";
export {
  attachPiTraceCapture,
  beginPiTrace,
  piTraceCorrelation,
  toolSpanId,
  piUsageToTraceUsage,
  sanitizePiRequestOptions,
  summarizePiSystem,
  type PiSessionLike,
  type PiTraceCaptureOptions,
} from "./pi-adapter.js";
