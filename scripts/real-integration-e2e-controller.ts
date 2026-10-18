/**
 * Pure feedback-loop controller for scripts/real-integration-e2e.ts (no I/O; unit-tested).
 *
 * Across customer attempts: a REAL customer failure that the build agents can act on (an integration tool
 * error, or the agent not getting the right answer) is delivered as a trace and fed to another real daily
 * build cycle; the SAME Pi session then retries. Failures the build agents must NOT be asked to fix
 * (model-provider/infra errors, auth, quota/rate limits, trace delivery, host verifier bugs) stop the loop
 * with an honest classification instead. Within a build, the build agent already iterates on its own
 * validation/tool errors; this controller only decides what happens BETWEEN customer attempts.
 */

export type FailureClass = "integration" | "agent" | "infra" | "verifier";

export interface AttemptObservation {
  /** session.prompt threw (provider/network/runtime), message only. */
  promptError: string | null;
  /** The SDK trace for this attempt was delivered (finish() with no delivery errors and >=1 chunk). */
  traceDelivered: boolean;
  /** The integration tool was present in the agent's live tool set at the start of the attempt. */
  toolAvailable: boolean;
  /** Integration tool results that were errors (status/message from the child, raw). */
  integrationToolErrors: Array<{ status: number | null; message: string }>;
  /** githubProofOk over the RAW tool result (own args.ref, 200, requestId, host-truth sha). */
  proofOk: boolean;
  answerHasFact: boolean;
  /** Host verifier itself failed (e.g. truth unavailable); never the agent's fault. */
  verifierError: string | null;
}

export interface AttemptClassification {
  outcome: "succeeded" | "failed";
  failureClass: FailureClass | null;
  /** True only when a further real build cycle can legitimately address this failure. */
  feedToBuild: boolean;
  reason: string;
}

const INFRA_RE = /\b(429|5\d\d|rate.?limit|quota|timeout|timed out|ECONN|ENOTFOUND|socket hang up|fetch failed|unauthori[sz]ed|forbidden|401|403|overloaded|capacity)\b/i;

const UPSTREAM_INFRA_RE = /(api rate limit|rate.?limit(ed)? exceeded|secondary rate limit|abuse detection|quota|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|service unavailable|bad gateway|gateway time-?out|upstream connect error)/i;

/** True when a tool error is identifiably an upstream outage/throttle/auth problem (not a defect in the child). */
export function isUpstreamInfraError(e: { status: number | null; message: string }): boolean {
  if (e.status === 401 || e.status === 429) return true;
  if (e.status === 403) return INFRA_RE.test(e.message) || UPSTREAM_INFRA_RE.test(e.message);
  if (e.status === 502 || e.status === 503 || e.status === 504) return true;
  if (/internal_error|TypeError|ReferenceError|cannot read propert/i.test(e.message)) return false;
  return UPSTREAM_INFRA_RE.test(e.message);
}

export function classifyAttempt(o: AttemptObservation): AttemptClassification {
  if (o.verifierError) return { outcome: "failed", failureClass: "verifier", feedToBuild: false, reason: `host verifier error: ${o.verifierError}` };
  if (o.promptError) return { outcome: "failed", failureClass: "infra", feedToBuild: false, reason: `customer model/runtime error: ${o.promptError}` };
  if (!o.traceDelivered) return { outcome: "failed", failureClass: "infra", feedToBuild: false, reason: "the attempt's SDK trace was not delivered; a build could not see it" };
  if (o.proofOk && o.answerHasFact) return { outcome: "succeeded", failureClass: null, feedToBuild: false, reason: "real GitHub 200 with the host-truth sha via the integration, and the answer has the fact" };
  if (!o.toolAvailable) return { outcome: "failed", failureClass: "infra", feedToBuild: false, reason: "the integration tool was not in the live tool set (catalog/deployment problem)" };
  const errs = o.integrationToolErrors;
  // Upstream outage/throttling/auth surfaced through the tool is infra, not something a code repair should chase.
  // An internal child failure (e.g. MCP 500 internal_error, a schema/ref bug, a GitHub 404 for a wrong ref) stays repairable.
  if (errs.length && errs.every(isUpstreamInfraError)) {
    return { outcome: "failed", failureClass: "infra", feedToBuild: false, reason: `upstream throttling/auth: ${errs.map((e) => `${e.status} ${e.message}`).join("; ").slice(0, 300)}` };
  }
  if (errs.length) return { outcome: "failed", failureClass: "integration", feedToBuild: true, reason: `integration tool error(s): ${errs.map((e) => `${e.status ?? "?"} ${e.message}`).join("; ").slice(0, 300)}` };
  if (o.proofOk && !o.answerHasFact) return { outcome: "failed", failureClass: "agent", feedToBuild: true, reason: "the tool returned the right file but the answer missed the fact (procedure/memory gap)" };
  return { outcome: "failed", failureClass: "agent", feedToBuild: true, reason: "the agent did not obtain the file through the integration (no successful repaired call)" };
}

export interface BuildCycleObservation {
  status: string | null;
  error: string | null;
  newDeployment: boolean;
  newMemoryRevision: boolean;
}

/** A build cycle that died on provider/infra is not retried by asking the LLM; it stops the loop. */
export function classifyBuildCycle(b: BuildCycleObservation): { ok: boolean; infra: boolean; changed: boolean; reason: string } {
  const changed = b.newDeployment || b.newMemoryRevision;
  if (b.status === "published" || b.status === "no_change") return { ok: true, infra: false, changed, reason: changed ? "published changes" : "build finished without changes" };
  const infra = !!b.error && INFRA_RE.test(b.error);
  return { ok: false, infra, changed, reason: `build ${b.status ?? "unknown"}: ${b.error ?? "no error text"}`.slice(0, 400) };
}

export type NextStep =
  | { action: "stop"; verdict: "succeeded"; reason: string }
  | { action: "stop"; verdict: "failed"; reason: string; blockedBy: FailureClass | "budget" | "no_change" | "build" }
  | { action: "build_then_retry"; cycle: number };

/** Decide what follows an attempt. cyclesUsed = real build cycles already run in this execution. */
export function nextStep(last: AttemptClassification, cyclesUsed: number, maxCycles: number, lastBuild: ReturnType<typeof classifyBuildCycle> | null): NextStep {
  if (last.outcome === "succeeded") return { action: "stop", verdict: "succeeded", reason: last.reason };
  if (!last.feedToBuild) return { action: "stop", verdict: "failed", reason: last.reason, blockedBy: last.failureClass ?? "infra" };
  if (lastBuild && !lastBuild.ok) return { action: "stop", verdict: "failed", reason: lastBuild.reason, blockedBy: lastBuild.infra ? "infra" : "build" };
  if (lastBuild && lastBuild.ok && !lastBuild.changed) return { action: "stop", verdict: "failed", reason: "the previous build cycle changed neither the integration nor memory; another identical retry cannot differ", blockedBy: "no_change" };
  if (cyclesUsed >= maxCycles) return { action: "stop", verdict: "failed", reason: `build-cycle budget exhausted (${cyclesUsed}/${maxCycles})`, blockedBy: "budget" };
  return { action: "build_then_retry", cycle: cyclesUsed + 1 };
}

/**
 * Final verdict from the FINAL validated outcome plus run-wide invariants. Earlier failed attempts stay in the
 * record as failed attempts (they are the reason builds ran); they do not make a later genuine success false.
 */
export function finalVerdict(p: { finalAttempt: AttemptClassification | null; invariants: Record<string, boolean>; finalChecks: Record<string, boolean> }): { ok: boolean; failing: string[] } {
  const failing = [
    ...(p.finalAttempt?.outcome === "succeeded" ? [] : ["finalAttempt.succeeded"]),
    ...Object.entries(p.invariants).filter(([, v]) => !v).map(([k]) => k),
    ...Object.entries(p.finalChecks).filter(([, v]) => !v).map(([k]) => k),
  ];
  return { ok: failing.length === 0, failing };
}

export interface RecordedFile {
  path: string;
  kind: "memory" | "source";
  before: string | null;
  after: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  truncated: boolean;
  cycles?: number[];
}

/**
 * One selected-file entry per path across build cycles: the ORIGINAL before (first cycle that touched it) and the
 * LATEST after. Every intermediate diff stays in its cycle receipt.
 */
export function upsertFile(files: RecordedFile[], next: RecordedFile, cycle: number): RecordedFile[] {
  const i = files.findIndex((f) => f.path === next.path && f.kind === next.kind);
  if (i < 0) {
    files.push({ ...next, cycles: [cycle] });
    return files;
  }
  const cur = files[i]!;
  files[i] = { ...cur, after: next.after, afterSha256: next.afterSha256, truncated: cur.truncated || next.truncated, cycles: [...(cur.cycles ?? []), cycle] };
  return files;
}

export interface CycleProof {
  cycle: number;
  buildOk: boolean;
  memoryChanged: boolean;
  sourceChanged: boolean;
  newDeployment: boolean;
  /** For integration changes: registry saw the new deployment by its own polling (no forced refresh). */
  sdkAutomatic: boolean;
  /** For schema changes: Pi applied the changed tool on its own (idle/safe point), before any manual apply. */
  piAutomatic: boolean | null;
}

/**
 * Proof of the REQUESTED mechanism (separate from task success): the prerequisites held, the first attempt
 * failed for the genuine seeded integration reason, and real builds repaired the integration (source + new
 * deployment, observed automatically by the SDK) and updated memory before the final success.
 */
export function mechanismProof(p: {
  prerequisites: Record<string, boolean>;
  firstAttempt: { failureClass: FailureClass | null; outcome: "succeeded" | "failed" } | null;
  expectedInitialFailure: boolean;
  cycles: CycleProof[];
}): { ok: boolean; failing: string[] } {
  const failing = Object.entries(p.prerequisites).filter(([, v]) => !v).map(([k]) => `prerequisite.${k}`);
  if (!p.firstAttempt || p.firstAttempt.outcome !== "failed" || p.firstAttempt.failureClass !== "integration" || !p.expectedInitialFailure) failing.push("initialFailure.genuineSeededIntegrationFailure");
  if (!p.cycles.length) failing.push("repair.atLeastOneBuildCycle");
  if (!p.cycles.some((c) => c.buildOk && c.sourceChanged && c.newDeployment)) failing.push("repair.integrationSourceAndDeployment");
  if (!p.cycles.some((c) => c.buildOk && c.memoryChanged)) failing.push("repair.memoryUpdated");
  const integrationCycles = p.cycles.filter((c) => c.newDeployment);
  if (integrationCycles.length && !integrationCycles.every((c) => c.sdkAutomatic)) failing.push("sdk.automaticObservationOfEveryNewDeployment");
  if (integrationCycles.some((c) => c.piAutomatic === false)) failing.push("pi.automaticApplicationOfChangedSchema");
  return { ok: failing.length === 0, failing };
}
