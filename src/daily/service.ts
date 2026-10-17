import { MemoryRepo } from "../store/memory.js";
import type { ObjectStore } from "../store/objects.js";
import { dayFor, getDailyRef, listUnprocessedDays, materializeCohort, pinDailyManifest, type DailyManifest } from "../traces/index.js";
import { canonicalJson, errorMessage, KeyedMutex, newId } from "../util.js";
import type { BuildController } from "../server.js";
import { claimDailyBuild, DEFAULT_LEASE_MS, FencedError, finishDailyBuild, leaseExpired, renewDailyLease, type LeasedRef } from "./lease.js";

/** Result shape a memory builder must return (the build harness's receipt is a superset). */
export interface MemoryBuildOutcome {
  status: "published" | "no_change" | "failed";
  revisionId?: string;
  error?: string;
  [key: string]: unknown;
}

export type MemoryBuilder = (args: {
  repo: MemoryRepo;
  ns: string;
  buildId: string;
  inputs: Map<string, string>;
  sources: string[];
  signal: AbortSignal;
}) => Promise<MemoryBuildOutcome>;

interface Job {
  ns: string;
  buildId: string;
  day: string;
  manifestKey: string;
  status: "running" | "published" | "no_change" | "failed";
  startedAt: string;
  finishedAt?: string;
  revisionId?: string;
  error?: string;
  /** Set when the receipt or the day's status could not be persisted; the job stays visible here. */
  persistError?: string;
  done: Promise<void>;
}

export interface DailyBuildServiceOptions {
  store: ObjectStore;
  builder: MemoryBuilder;
  dayOffsetMinutes?: number;
  buildTimeoutMs?: number;
  leaseMs?: number;
  /** Max finished jobs kept in memory for status lookups. */
  maxRetainedJobs?: number;
  log?: (msg: string) => void;
}

const PERSIST_ATTEMPTS = 4;

/**
 * Daily build orchestration with durable ownership:
 * pin the day's immutable manifest -> atomically claim it with a lease ->
 * run the recursive build over the materialized cohort -> publish (CAS in the
 * harness) -> record a durable receipt and the fenced final day status.
 * A crashed process stops renewing its lease; the next trigger supersedes the
 * stale manifest and rebuilds, so no day stalls and no chunk is lost or
 * double-processed. `catchup` picks the earliest unprocessed day <= yesterday.
 */
export class DailyBuildService implements BuildController {
  readonly #jobs = new Map<string, Job>();
  readonly #queue = new KeyedMutex();

  constructor(private readonly opts: DailyBuildServiceOptions) {}

  /** Default day: yesterday in the configured day convention (the cron builds completed days). */
  defaultDay(now = new Date()): string {
    return dayFor(new Date(now.getTime() - 24 * 3600_000), this.opts.dayOffsetMinutes ?? 0);
  }

  async start(ns: string, input: { day?: string; force?: boolean; catchup?: boolean }): Promise<Record<string, unknown> & { buildId?: string }> {
    let day = input.day;
    let remainingDays: string[] | undefined;
    if (input.catchup) {
      const pending = await listUnprocessedDays(this.opts.store, ns, input.day ?? this.defaultDay());
      if (pending.length === 0) return { status: "nothing_to_build", reason: "no unprocessed days", remainingDays: [] };
      day = pending[0];
      remainingDays = pending.slice(1);
    }
    day ??= this.defaultDay();
    const running = [...this.#jobs.values()].find((j) => j.ns === ns && j.day === day && j.status === "running");
    if (running) return { day, buildId: running.buildId, status: "running", reason: "build already running in this process", ...(remainingDays ? { remainingDays } : {}) };

    const { store } = this.opts;
    let pin = await pinDailyManifest(store, ns, day, { force: input.force === true });
    if (pin.reason === "build-in-progress") {
      if (!leaseExpired(pin.ref as LeasedRef | null)) {
        return { day, status: "build_in_progress", buildId: pin.ref?.buildId, reason: "another worker holds a live lease for this day", ...(remainingDays ? { remainingDays } : {}) };
      }
      this.opts.log?.(`day ${day}: build ${pin.ref?.buildId ?? "?"} lease expired; superseding its manifest and rebuilding`);
      pin = await pinDailyManifest(store, ns, day, { force: true });
    }
    if (!pin.manifest || pin.reason === "up-to-date") {
      return { day, status: "nothing_to_build", reason: pin.reason, ...(remainingDays ? { remainingDays } : {}) };
    }
    const manifest = pin.manifest;
    const buildId = newId("bld");
    const claim = await claimDailyBuild(store, ns, day, { manifestKey: manifest.key, buildId, leaseMs: this.#leaseMs });
    if (!claim.ok) {
      return { day, status: "not_claimed", reason: claim.reason, buildId: claim.value?.buildId, ...(remainingDays ? { remainingDays } : {}) };
    }
    const job: Job = { ns, buildId, day, manifestKey: manifest.key, status: "running", startedAt: new Date().toISOString(), done: Promise.resolve() };
    this.#jobs.set(buildId, job);
    job.done = this.#queue.run(ns, () => this.#run(job, manifest));
    return {
      day,
      buildId,
      status: "running",
      manifest: { key: manifest.key, chunks: manifest.chunks.length, sessions: manifest.sessionIds.length },
      ...(remainingDays ? { remainingDays } : {}),
    };
  }

  /** Run synchronously (CLI / tests / demo): start then wait for the receipt. */
  async runAndWait(ns: string, input: { day?: string; force?: boolean; catchup?: boolean }) {
    const started = await this.start(ns, input);
    const job = started.buildId ? this.#jobs.get(started.buildId) : undefined;
    if (!job) return started;
    await job.done;
    return this.get(ns, job.buildId);
  }

  async get(ns: string, buildId: string): Promise<Record<string, unknown> | null> {
    const job = this.#jobs.get(buildId);
    if (job && job.ns !== ns) return null;
    if (job && (job.status === "running" || job.persistError)) return this.#jobView(job);
    const key = `builds/receipts/${buildId}.json`;
    const bytes = (await this.opts.store.get(ns, [key])).get(key);
    if (bytes) return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    return job ? this.#jobView(job) : null;
  }

  async dayStatus(ns: string, day: string) {
    return (await getDailyRef(this.opts.store, ns, day))?.value ?? null;
  }

  get #leaseMs() {
    return this.opts.leaseMs ?? DEFAULT_LEASE_MS;
  }

  #jobView(job: Job) {
    return {
      buildId: job.buildId,
      day: job.day,
      status: job.status,
      startedAt: job.startedAt,
      manifestKey: job.manifestKey,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.revisionId ? { revisionId: job.revisionId } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.persistError ? { persistError: job.persistError } : {}),
    };
  }

  async #run(job: Job, manifest: DailyManifest): Promise<void> {
    const { store } = this.opts;
    const repo = new MemoryRepo(store, job.ns);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("daily build deadline exceeded")), this.opts.buildTimeoutMs ?? 45 * 60_000);
    // Heartbeat: keep the lease alive; if ownership is lost, stop building (fencing).
    const heartbeat = setInterval(() => {
      void renewDailyLease(store, job.ns, job.day, { manifestKey: job.manifestKey, buildId: job.buildId, leaseMs: this.#leaseMs })
        .then((owned) => {
          if (!owned) controller.abort(new FencedError(`build ${job.buildId} lost ownership of ${job.day}`));
        })
        .catch((error) => this.opts.log?.(`build ${job.buildId}: lease renewal error: ${errorMessage(error)}`));
    }, Math.max(1000, Math.floor(this.#leaseMs / 3)));
    let outcome: MemoryBuildOutcome;
    try {
      const inputs = await materializeCohort(store, job.ns, manifest);
      outcome = await this.opts.builder({ repo, ns: job.ns, buildId: job.buildId, inputs, sources: [manifest.key], signal: controller.signal });
    } catch (error) {
      outcome = { status: "failed", error: errorMessage(error) };
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }
    job.status = outcome.status;
    job.finishedAt = new Date().toISOString();
    if (outcome.revisionId) job.revisionId = outcome.revisionId;
    if (outcome.error) job.error = outcome.error;
    const receipt = {
      schema: "procmem.daily-build/v1",
      ...outcome,
      buildId: job.buildId,
      ns: job.ns,
      day: job.day,
      manifestKey: manifest.key,
      chunks: manifest.chunks.length,
      sessions: manifest.sessionIds,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
    const errors: string[] = [];
    await this.#persist(`receipt ${job.buildId}`, errors, () =>
      store.put(job.ns, [{ key: `builds/receipts/${job.buildId}.json`, bytes: Buffer.from(canonicalJson(receipt)) }]),
    );
    // A no-change build still consumed the cohort: mark it processed so catch-up only sees later chunks.
    await this.#persist(`day status ${job.day}`, errors, () =>
      finishDailyBuild(store, job.ns, job.day, {
        manifestKey: manifest.key,
        buildId: job.buildId,
        status: outcome.status === "failed" ? "failed" : "published",
        ...(outcome.revisionId ? { revisionId: outcome.revisionId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      }),
    );
    if (errors.length) job.persistError = errors.join("; ");
    this.#trim();
    this.opts.log?.(
      `build ${job.buildId} (${job.ns} ${job.day}) -> ${outcome.status}${outcome.revisionId ? ` ${outcome.revisionId}` : ""}${job.persistError ? ` [persist error: ${job.persistError}]` : ""}`,
    );
  }

  async #persist(what: string, errors: string[], op: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await op();
        return;
      } catch (error) {
        // Fencing is not transient: another owner superseded this build.
        if (error instanceof FencedError || attempt >= PERSIST_ATTEMPTS) {
          errors.push(`${what}: ${errorMessage(error)}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }

  #trim() {
    const max = this.opts.maxRetainedJobs ?? 200;
    const finished = [...this.#jobs.values()].filter((j) => j.status !== "running" && !j.persistError);
    for (const j of finished.slice(0, Math.max(0, this.#jobs.size - max))) this.#jobs.delete(j.buildId);
  }
}
