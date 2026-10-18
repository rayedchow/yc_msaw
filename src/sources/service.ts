import type { ObjectStore } from "../store/objects.js";
import { SourceBindings, type BindingRecord, type PublicBinding } from "./bindings.js";
import { SourceError } from "./paths.js";
import { DEFAULT_NODE_CACHE_BYTES, SourceNodeCache, SourceStore, type DirEntry } from "./store.js";

/**
 * Tenant-scoped entry point for the sources/ subsystem. Every method takes the
 * namespace of an already-verified caller (MCP principal, admin principal, or
 * binding); nothing here derives a namespace from request content.
 */

const MAX_CACHED_TENANTS = 64;

export type CoverageState = "complete" | "partial" | "blocked" | "pending";
export const COVERAGE_STATES: readonly CoverageState[] = ["complete", "partial", "blocked", "pending"];

export interface CoverageReport {
  provider: string;
  scope: string;
  state: CoverageState;
  reason?: string;
  cursor?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  counts?: Record<string, number>;
}

export interface StatusReport {
  providers: CoverageReport[];
  /** reportIntervalSeconds: how often this collector promises to report; drives the stale-heartbeat check. */
  runtime?: { version?: string; donorCommit?: string; host?: string; reportIntervalSeconds?: number };
}

export interface StoredStatus {
  schema: "procmem.source-status/v1";
  bindingId: string;
  receivedAt: string;
  report: StatusReport;
}

export type CollectorHealth = "healthy" | "stale" | "unreported";

export interface ProviderStatus {
  provider: string;
  files: number;
  deleted: number;
  /** Newest capture/provider-edit time in this provider tree: data age, NOT collector health. */
  lastCapturedAt: string | null;
  lastSourceUpdatedAt: string | null;
  captureAgeSeconds: number | null;
  /** Newest `lastSuccessAt` any collector reported for this provider (a no-change poll still counts). */
  lastSuccessfulCheckAt: string | null;
  checkAgeSeconds: number | null;
  /** Newest status report (heartbeat) received for this provider. */
  lastReportAt: string | null;
  reportAgeSeconds: number | null;
  /** stale: no heartbeat or successful check within 3x the collector's report interval. */
  health: CollectorHealth;
  /** Worst reported coverage across collectors; says nothing about whether the collector is still running. */
  coverageState: CoverageState | "unreported";
  coverage: Array<CoverageReport & { bindingId: string; reportedAt: string; reportAgeSeconds: number; stale: boolean }>;
}

/** Report interval assumed when a collector does not declare one. */
export const DEFAULT_REPORT_INTERVAL_SECONDS = 300;

const STATE_RANK: Record<CoverageState, number> = { complete: 0, pending: 1, partial: 2, blocked: 3 };

export const statusRef = (bindingId: string) => `sources/status/${bindingId}`;

export class SourceService {
  readonly bindings: SourceBindings;
  readonly #stores = new Map<string, SourceStore>();
  readonly #reportEpoch = new Map<string, number>();

  /** One byte-bounded metadata cache for every tenant store of this process. */
  readonly nodeCache: SourceNodeCache;

  constructor(
    readonly objects: ObjectStore,
    private readonly now: () => Date = () => new Date(),
    opts: { nodeCacheBytes?: number } = {},
  ) {
    this.bindings = new SourceBindings(objects);
    this.nodeCache = new SourceNodeCache(opts.nodeCacheBytes ?? DEFAULT_NODE_CACHE_BYTES);
  }

  storeFor(ns: string): SourceStore {
    let s = this.#stores.get(ns);
    if (s) {
      this.#stores.delete(ns);
      this.#stores.set(ns, s);
      return s;
    }
    s = new SourceStore(this.objects, ns, { now: this.now, cache: this.nodeCache });
    this.#stores.set(ns, s);
    while (this.#stores.size > MAX_CACHED_TENANTS) this.#stores.delete(this.#stores.keys().next().value!);
    return s;
  }

  /** Changes whenever this process accepts a status report for `ns` (lets readers drop cached coverage). */
  reportEpoch(ns: string): number {
    return this.#reportEpoch.get(ns) ?? 0;
  }

  /** Record a binding's latest coverage report (overwrites that binding's previous report only). */
  async reportStatus(ns: string, binding: BindingRecord, report: StatusReport): Promise<StoredStatus> {
    for (const p of report.providers) {
      if (!binding.providers.includes("*") && !binding.providers.includes(p.provider)) {
        throw new SourceError("forbidden_provider", `This binding may not report status for ${p.provider}`, { provider: p.provider });
      }
    }
    const value: StoredStatus = { schema: "procmem.source-status/v1", bindingId: binding.bindingId, receivedAt: this.now().toISOString(), report };
    for (let attempt = 0; attempt < 10; attempt++) {
      const cur = await this.objects.getRef(ns, statusRef(binding.bindingId));
      const r = await this.objects.casRef(ns, statusRef(binding.bindingId), cur?.version ?? null, value);
      if (r.ok) {
        this.#reportEpoch.set(ns, (this.#reportEpoch.get(ns) ?? 0) + 1);
        return value;
      }
    }
    throw new SourceError("conflict", "Status ref is busy; retry");
  }

  /** Freshness, collector health and coverage per provider directory, merged across active bindings. */
  async status(ns: string): Promise<{ head: { seq: number; commitId: string | null; updatedAt: string | null }; providers: ProviderStatus[]; bindings: PublicBinding[] }> {
    const store = this.storeFor(ns);
    const head = (await store.head()).value;
    const dirs = new Map<string, DirEntry>();
    for await (const [name, e] of store.children(head.root)) if (e.t === "d") dirs.set(name, e);
    const bindings = await this.bindings.list(ns);
    const reports: StoredStatus[] = [];
    for (const b of bindings) {
      if (b.revokedAt) continue;
      const ref = await this.objects.getRef(ns, statusRef(b.bindingId));
      if (ref) reports.push(ref.value as StoredStatus);
    }
    const names = new Set<string>(dirs.keys());
    for (const r of reports) for (const p of r.report.providers) names.add(p.provider);
    const nowMs = this.now().getTime();
    const age = (iso: string | null | undefined) => (iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000)) : null);
    const providers: ProviderStatus[] = [...names].sort().map((provider) => {
      const dir = dirs.get(provider);
      const coverage = reports.flatMap((r) => {
        const interval = r.report.runtime?.reportIntervalSeconds ?? DEFAULT_REPORT_INTERVAL_SECONDS;
        const reportAge = age(r.receivedAt)!;
        return r.report.providers
          .filter((p) => p.provider === provider)
          .map((p) => ({ ...p, bindingId: r.bindingId, reportedAt: r.receivedAt, reportAgeSeconds: reportAge, stale: reportAge > 3 * interval }));
      });
      const worst = coverage.reduce<CoverageState | null>((acc, c) => (acc === null || STATE_RANK[c.state] > STATE_RANK[acc] ? c.state : acc), null);
      const lastReportAt = coverage.reduce<string | null>((m, c) => (m === null || c.reportedAt > m ? c.reportedAt : m), null);
      const lastSuccessfulCheckAt = coverage.reduce<string | null>((m, c) => (c.lastSuccessAt && (m === null || c.lastSuccessAt > m) ? c.lastSuccessAt : m), null);
      const health: CollectorHealth = coverage.length === 0 ? "unreported" : coverage.every((c) => c.stale) ? "stale" : "healthy";
      return {
        provider,
        files: dir?.files ?? 0,
        deleted: dir?.deleted ?? 0,
        lastCapturedAt: dir?.capturedAt ?? null,
        lastSourceUpdatedAt: dir?.sourceUpdatedAt ?? null,
        captureAgeSeconds: age(dir?.capturedAt),
        lastSuccessfulCheckAt,
        checkAgeSeconds: age(lastSuccessfulCheckAt),
        lastReportAt,
        reportAgeSeconds: age(lastReportAt),
        health,
        coverageState: worst ?? "unreported",
        coverage,
      };
    });
    return { head: { seq: head.seq, commitId: head.commitId, updatedAt: head.updatedAt }, providers, bindings };
  }
}
