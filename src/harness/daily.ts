import { ConflictError, type MemoryRepo } from "../store/memory.js";
import { buildTraceArchive, emptyTraceArchive, TraceArchiveSnapshot, type TraceArchiveOptions, type TraceArchiveSummary } from "../traces/archive.js";
import { errorMessage, newId } from "../util.js";
import { resolveBudget, type InvestigationBudget } from "./budget.js";
import { manifestSha256 } from "./patch.js";
import { runBuildTree, type AgentReceipt, type BuildLogger, type PublishCallback } from "./orchestrator.js";
import type { ChatClientFactory, ProfileRegistry } from "./profiles.js";
import type { ToolProviderRegistration } from "./tools.js";
import type { BuildWorkspaceFactory } from "./workspace.js";

/**
 * Daily procedural-memory build: pin the published head, run the recursive
 * agent tree over the day's immutable trace cohort, and publish the root's
 * validated draft with base CAS. On a CAS conflict the whole tree is rebuilt
 * once on the new head (never merged over it). A failed build leaves the last
 * revision intact. The workspace backend is explicit: there is no fallback
 * from Modal to local (LocalBuildWorkspace is for trusted offline runs only).
 */
export interface MemoryBuildOptions {
  repo: MemoryRepo;
  /** Trace cohort files relative to inputs/ (manifest.json, sessions/<id>/...). */
  inputs: ReadonlyMap<string, string>;
  /** Daily manifest ids this cohort was pinned from (recorded as revision provenance). */
  sources: readonly string[];
  /**
   * Read-only archive of all retained traces mounted at sources/ for every agent:
   *  - undefined or TraceArchiveOptions: built once from repo.store + repo.ns (the host tenant) before the first attempt;
   *  - a TraceArchiveSnapshot: used as-is (must belong to repo.ns);
   *  - "disabled": an empty sources/ whose README says the host disabled it.
   * Any archive error (integrity, over cap) fails the build explicitly; nothing is dropped.
   */
  traceArchive?: TraceArchiveSnapshot | TraceArchiveOptions | "disabled";
  profiles: ProfileRegistry;
  clientFactory: ChatClientFactory;
  budget?: Partial<InvestigationBudget>;
  workspaceFactory: BuildWorkspaceFactory;
  toolProviders?: readonly ToolProviderRegistration[];
  signal?: AbortSignal;
  log?: BuildLogger;
  buildId?: string;
  /** Optional operator/eval instructions appended to the root task prompt (recorded in the receipt). */
  instructions?: string;
  /** Total attempts including CAS-conflict rebuilds (default 2 = rebuild once). */
  maxAttempts?: number;
}

export type BuildStatus = "published" | "no_change" | "failed";

export interface BuildAttemptReceipt {
  attempt: number;
  baseRevision: string;
  status: "published" | "no_change" | "publish_conflict" | "failed";
  revisionId?: string;
  summary?: string;
  failure?: { code: string; message: string };
  agents: number;
  startedAt: string;
  finishedAt: string;
  tree: AgentReceipt;
}

export interface BuildReceipt {
  schema: "procmem.build-receipt/v1";
  buildId: string;
  status: BuildStatus;
  sources: string[];
  inputs: { files: number; manifestSha256: string };
  /** The archive snapshot every agent saw at sources/ (null when it could not be built; see failure). */
  traceArchive: TraceArchiveSummary | null;
  workspaceBackend: string | null;
  profiles: { root: string; selectable: string[]; defaultChild: string };
  budget: InvestigationBudget;
  instructions?: string;
  /** Head before the first attempt and the revision the build ended on (unchanged on failure). */
  initialHead: string;
  revisionId: string;
  summary?: string;
  failure?: { code: string; message: string };
  startedAt: string;
  finishedAt: string;
  attempts: BuildAttemptReceipt[];
  /** close() outcome of every registered tool provider (called once, in finally). */
  providerClose: Array<{ id: string; ok: boolean; detail?: unknown; error?: string }>;
}

export async function runMemoryBuild(opts: MemoryBuildOptions): Promise<BuildReceipt> {
  const providerClose: BuildReceipt["providerClose"] = [];
  try {
    const receipt = await runMemoryBuildInner(opts);
    return Object.assign(receipt, { providerClose });
  } finally {
    // Tool providers own external resources (integration sandboxes, repo bundles): always release them.
    for (const reg of opts.toolProviders ?? []) {
      if (!reg.provider.close) continue;
      try {
        const detail = await reg.provider.close();
        providerClose.push({ id: reg.provider.id, ok: true, ...(detail !== undefined ? { detail } : {}) });
      } catch (error) {
        providerClose.push({ id: reg.provider.id, ok: false, error: error instanceof Error ? error.message : String(error) });
        opts.log?.({ at: new Date().toISOString(), agentId: "host", event: "provider_close_failed", detail: { provider: reg.provider.id, message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }
}

async function runMemoryBuildInner(opts: MemoryBuildOptions): Promise<Omit<BuildReceipt, "providerClose">> {
  if (typeof opts.workspaceFactory !== "function") throw new Error("runMemoryBuild requires an explicit workspaceFactory (no implicit local fallback)");
  const budget = resolveBudget(opts.budget);
  const buildId = opts.buildId ?? newId("build");
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 2, 5));
  const startedAt = new Date().toISOString();
  const initialHead = await opts.repo.ensureHead();
  const attempts: BuildAttemptReceipt[] = [];
  let backend: string | null = null;
  let archive: TraceArchiveSnapshot;
  try {
    archive = await resolveArchive(opts);
  } catch (error) {
    opts.log?.({ at: new Date().toISOString(), agentId: "host", event: "trace_archive_failed", detail: { message: errorMessage(error) } });
    return {
      schema: "procmem.build-receipt/v1",
      buildId,
      status: "failed",
      sources: [...opts.sources],
      inputs: { files: opts.inputs.size, manifestSha256: manifestSha256(opts.inputs) },
      traceArchive: null,
      workspaceBackend: null,
      profiles: { root: opts.profiles.root.id, selectable: opts.profiles.selectable.map((p) => p.id), defaultChild: opts.profiles.defaultChild.id },
      budget,
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      initialHead,
      revisionId: initialHead,
      failure: { code: "trace_archive_failed", message: errorMessage(error) },
      startedAt,
      finishedAt: new Date().toISOString(),
      attempts,
    };
  }
  opts.log?.({ at: new Date().toISOString(), agentId: "host", event: "trace_archive_ready", detail: { ...archive.summary(), cachedPartitions: archive.stats.cachedPartitions, renderedPartitions: archive.stats.renderedPartitions } });
  const workspaceFactory: BuildWorkspaceFactory = (spec) => {
    const ws = opts.workspaceFactory(spec);
    backend = ws.kind;
    return ws;
  };

  let final: { status: BuildStatus; revisionId: string; summary?: string; failure?: { code: string; message: string } } | null = null;
  for (let attempt = 1; attempt <= maxAttempts && !final; attempt++) {
    if (opts.signal?.aborted) {
      final = { status: "failed", revisionId: (await opts.repo.head())?.value.revisionId ?? initialHead, failure: { code: "aborted", message: "Build aborted before attempt" } };
      break;
    }
    const attemptStarted = new Date().toISOString();
    const base = await opts.repo.ensureHead();
    const published = await opts.repo.files(base);
    const publish: PublishCallback = async ({ files, summary }) => {
      if (manifestSha256(files) === manifestSha256(published)) {
        // Identical tree: record no_change, but still detect that the base moved underneath us.
        const head = (await opts.repo.head())?.value.revisionId ?? null;
        if (head !== base) throw new ConflictError(base, head);
        return { status: "no_change", revisionId: base };
      }
      const r = await opts.repo.publish(base, files, { buildId, summary, sources: [...opts.sources] });
      return { status: "published", revisionId: r.revisionId };
    };
    const result = await runBuildTree({
      buildId: `${buildId}`,
      baseRevision: base,
      sources: opts.sources,
      inputs: opts.inputs,
      traceArchive: archive,
      published,
      profiles: opts.profiles,
      clientFactory: opts.clientFactory,
      budget,
      workspaceFactory,
      toolProviders: opts.toolProviders,
      publish,
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      signal: opts.signal,
      log: opts.log,
    });
    const o = result.outcome;
    const rec: BuildAttemptReceipt = {
      attempt,
      baseRevision: base,
      status: o.kind,
      ...(o.kind === "published" || o.kind === "no_change" ? { revisionId: o.revisionId, summary: o.summary } : {}),
      ...(o.kind === "failed" ? { failure: { code: o.code, message: o.message } } : o.kind === "publish_conflict" ? { failure: { code: "publish_conflict", message: o.message } } : {}),
      agents: result.agents,
      startedAt: attemptStarted,
      finishedAt: result.finishedAt,
      tree: result.tree,
    };
    attempts.push(rec);
    if (o.kind === "published" || o.kind === "no_change") final = { status: o.kind, revisionId: o.revisionId, summary: o.summary };
    else if (o.kind === "failed") final = { status: "failed", revisionId: base, failure: { code: o.code, message: o.message } };
    // publish_conflict: loop and rebuild on the new head.
  }
  if (!final) {
    const head = (await opts.repo.head())?.value.revisionId ?? initialHead;
    final = { status: "failed", revisionId: head, failure: { code: "publish_conflict", message: `Head kept moving; gave up after ${maxAttempts} attempt(s)` } };
  }
  return {
    schema: "procmem.build-receipt/v1",
    buildId,
    status: final.status,
    sources: [...opts.sources],
    inputs: { files: opts.inputs.size, manifestSha256: manifestSha256(opts.inputs) },
    traceArchive: archive.summary(),
    workspaceBackend: backend,
    profiles: { root: opts.profiles.root.id, selectable: opts.profiles.selectable.map((p) => p.id), defaultChild: opts.profiles.defaultChild.id },
    budget,
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
    initialHead,
    revisionId: final.revisionId,
    ...(final.summary ? { summary: final.summary } : {}),
    ...(final.failure ? { failure: final.failure } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    attempts,
  };
}

async function resolveArchive(opts: MemoryBuildOptions): Promise<TraceArchiveSnapshot> {
  const a = opts.traceArchive;
  if (a === "disabled") return emptyTraceArchive(opts.repo.ns, { disabled: true, reason: "traceArchive: disabled" });
  if (a instanceof TraceArchiveSnapshot) {
    if (a.ns !== opts.repo.ns) throw new Error(`Trace archive belongs to namespace ${a.ns}, not the build's ${opts.repo.ns}`);
    return a;
  }
  return buildTraceArchive(opts.repo.store, opts.repo.ns, a ?? {});
}
