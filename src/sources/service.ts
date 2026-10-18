import type { ObjectStore } from "../store/objects.js";
import { providerOwners, SourceOwners, SourceViewer, type GoogleAccountOwner, type Identity } from "./access.js";
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
  /** How often this scope promises a successful check (drives `checkLate`). */
  expectedIntervalSeconds?: number;
}

export interface StatusReport {
  providers: CoverageReport[];
  /** reportIntervalSeconds: how often this collector promises to report; drives the stale-heartbeat check. */
  runtime?: { version?: string; donorCommit?: string; host?: string; reportIntervalSeconds?: number };
  /** Every Google address the runtime collects and the verified subject of its grant (honoured from `*` runtime bindings only). */
  googleAccounts?: GoogleAccountOwner[];
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
  /** null: withheld, the directory also holds data of other owners. */
  files: number | null;
  deleted: number | null;
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
  /** stale: no heartbeat within 3x the collector's report interval, or a scope's last success is 3x older than its declared interval. */
  health: CollectorHealth;
  /** Worst reported coverage across collectors; says nothing about whether the collector is still running. */
  coverageState: CoverageState | "unreported";
  coverage: Array<CoverageReport & { bindingId: string; reportedAt: string; reportAgeSeconds: number; stale: boolean; checkLate: boolean }>;
}

/** Report interval assumed when a collector does not declare one. */
export const DEFAULT_REPORT_INTERVAL_SECONDS = 300;

const STATE_RANK: Record<CoverageState, number> = { complete: 0, pending: 1, partial: 2, blocked: 3 };

export const statusRef = (bindingId: string) => `sources/status/${bindingId}`;

export class SourceService {
  readonly bindings: SourceBindings;
  readonly owners: SourceOwners;
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
    this.owners = new SourceOwners(objects);
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

  /** Latest status report of every active binding. */
  async #reports(ns: string, bindings: readonly PublicBinding[]): Promise<StoredStatus[]> {
    const reports: StoredStatus[] = [];
    for (const b of bindings) {
      if (b.revokedAt) continue;
      const ref = await this.objects.getRef(ns, statusRef(b.bindingId));
      if (ref) reports.push(ref.value as StoredStatus);
    }
    return reports;
  }

  /** What `who` (a verified principal of `ns`) may read; see access.ts. */
  async viewer(ns: string, who: Identity): Promise<SourceViewer> {
    const [bindings, owners] = await Promise.all([this.bindings.list(ns), this.owners.registry(ns)]);
    const runtimeIds = new Set(bindings.filter((b) => !b.revokedAt && b.kind === "runtime" && b.providers.includes("*")).map((b) => b.bindingId));
    const reports = (await this.#reports(ns, bindings)).filter((r) => runtimeIds.has(r.bindingId));
    return new SourceViewer(who, {
      providerOwners: providerOwners(bindings, owners.value),
      googleAccounts: reports.flatMap((r) => r.report.googleAccounts ?? []),
    });
  }

  /**
   * Freshness, collector health and coverage per provider directory, merged across active bindings.
   * With a viewer: providers it cannot read are omitted; for a partly readable provider only its own
   * coverage reports are kept and tenant-wide counts are withheld (null).
   */
  async status(ns: string, viewer?: SourceViewer): Promise<{ head: { seq: number; commitId: string | null; updatedAt: string | null }; providers: ProviderStatus[]; bindings: PublicBinding[] }> {
    const store = this.storeFor(ns);
    const head = (await store.head()).value;
    const dirs = new Map<string, DirEntry>();
    for await (const [name, e] of store.children(head.root)) if (e.t === "d") dirs.set(name, e);
    const allBindings = await this.bindings.list(ns);
    const reports = await this.#reports(ns, allBindings);
    const names = new Set<string>(dirs.keys());
    for (const r of reports) for (const p of r.report.providers) names.add(p.provider);
    if (viewer) for (const n of names) if (viewer.access(n) === "deny") names.delete(n);
    // Device bindings are listed to their own enroller only.
    const bindings = viewer ? allBindings.filter((b) => b.kind !== "device" || (b.createdBy.subject === viewer.who.subject && b.createdBy.issuer === viewer.who.issuer)) : allBindings;
    const nowMs = this.now().getTime();
    const age = (iso: string | null | undefined) => (iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000)) : null);
    const providers: ProviderStatus[] = [...names].sort().map((provider) => {
      const dir = dirs.get(provider);
      const coverage = reports.flatMap((r) => {
        const interval = r.report.runtime?.reportIntervalSeconds ?? DEFAULT_REPORT_INTERVAL_SECONDS;
        const reportAge = age(r.receivedAt)!;
        return r.report.providers
          .filter((p) => p.provider === provider && (!viewer || viewer.coverageVisible(provider, p)))
          .map((p) => {
            // A scope that declares how often it succeeds is late once its last success is 3 intervals old, even
            // while the exporter process keeps heartbeating (a dead worker or sweeper).
            const successAge = age(p.lastSuccessAt);
            const checkLate = p.expectedIntervalSeconds !== undefined && successAge !== null && successAge > 3 * p.expectedIntervalSeconds;
            return { ...p, bindingId: r.bindingId, reportedAt: r.receivedAt, reportAgeSeconds: reportAge, stale: reportAge > 3 * interval || checkLate, checkLate };
          });
      });
      const worst = coverage.reduce<CoverageState | null>((acc, c) => (acc === null || STATE_RANK[c.state] > STATE_RANK[acc] ? c.state : acc), null);
      const lastReportAt = coverage.reduce<string | null>((m, c) => (m === null || c.reportedAt > m ? c.reportedAt : m), null);
      const lastSuccessfulCheckAt = coverage.reduce<string | null>((m, c) => (c.lastSuccessAt && (m === null || c.lastSuccessAt > m) ? c.lastSuccessAt : m), null);
      const health: CollectorHealth =
        coverage.length === 0 ? "unreported" : coverage.every((c) => c.stale) || coverage.some((c) => c.checkLate) ? "stale" : "healthy";
      // Directory totals of a partly readable provider include other owners' data.
      const totals = viewer && viewer.access(provider) !== "allow" ? undefined : dir;
      return {
        provider,
        files: totals ? totals.files : viewer && dir ? null : 0,
        deleted: totals ? totals.deleted : viewer && dir ? null : 0,
        lastCapturedAt: totals?.capturedAt ?? null,
        lastSourceUpdatedAt: totals?.sourceUpdatedAt ?? null,
        captureAgeSeconds: age(totals?.capturedAt),
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
