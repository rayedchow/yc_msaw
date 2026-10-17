import type { ObjectStore } from "../store/objects.js";
import { canonicalJson, sha256 } from "../util.js";
import { assertSlug } from "./paths.js";
import { IntegrationError } from "./types.js";

/**
 * Durable integration state in the shared ObjectStore, under a namespace the
 * HOST supplies (authenticated tenant); no tool input ever selects it.
 *
 *   ref     integrations/<slug>                     IntegrationRecord (CAS-updated)
 *   object  integrations/<slug>/created.json        catalog marker (list() rediscovery)
 *   object  integrations/<slug>/receipts/<id>.json  immutable validation/publish receipts
 *   object  blobs/<sha256>                          git bundles and deploy source archives
 */
export interface BundleSnapshot {
  key: string;
  sha256: string;
  bytes: number;
  /** branch name -> commit sha at snapshot time. */
  refs: Record<string, string>;
  savedAt: string;
  buildId: string;
}

export interface PromotedRevision {
  commit: string;
  tree: string;
  sourceSha256: string;
  validationReceiptId: string;
  /** Deterministic `git archive --format=tar.gz <commit>` bytes stored as blobs/<sha>. */
  archiveKey: string;
  archiveSha256: string;
  archiveBytes: number;
  promotedAt: string;
  buildId: string;
  /** Previously promoted commit (rollback target), if any. */
  previousCommit: string | null;
}

export interface DeploymentRecord {
  deploymentId: string;
  commit: string;
  archiveSha256: string;
  validationReceiptId: string;
  status: string;
  probe: "passed" | "failed" | "skipped";
  receiptId: string;
  at: string;
  /** "publish" | "update" | "rollback" | "auto_rollback" */
  action: string;
}

export interface ManufactServerRecord {
  orgSlug: string;
  serverId: string;
  serverSlug: string | null;
  name: string;
  mcpUrl: string | null;
  dashboardUrl: string | null;
  /** Deployment that last passed build + post-deploy MCP probe; it stays active on failed revisions. */
  active: DeploymentRecord | null;
  history: DeploymentRecord[];
  /** Names (never values) of env vars configured by the host publisher. */
  envNames: string[];
}

export interface IntegrationRecord {
  slug: string;
  title: string;
  description: string;
  createdAt: string;
  createdByBuild: string;
  bundle: BundleSnapshot | null;
  promoted: PromotedRevision | null;
  promotedHistory: PromotedRevision[];
  validations: Array<{ receiptId: string; tree: string; passed: boolean; at: string; buildId: string }>;
  manufact: ManufactServerRecord | null;
  /**
   * Discovery lifecycle. Absent on records written before retirement existed = active.
   * "retired" is a reversible tombstone: the record, repo bundles, receipts and promoted
   * revision are kept; only customer discovery/token exchange stop.
   */
  lifecycle?: IntegrationLifecycle;
}

export interface LifecycleEvent {
  state: "active" | "retired";
  at: string;
  buildId: string;
  reason: string;
  receiptId: string;
  /** Deployment stopped on Manufact as part of this retirement, if any. */
  stoppedDeploymentId?: string;
}

export interface IntegrationLifecycle {
  state: "active" | "retired";
  changedAt: string;
  history: LifecycleEvent[];
}

export function lifecycleState(r: Pick<IntegrationRecord, "lifecycle">): "active" | "retired" {
  return r.lifecycle?.state ?? "active";
}

const HISTORY_LIMIT = 50;

export class IntegrationStore {
  constructor(private readonly store: ObjectStore, readonly ns: string) {}

  #ref(slug: string) {
    return `integrations/${assertSlug(slug)}`;
  }

  async get(slug: string): Promise<IntegrationRecord | null> {
    const ref = await this.store.getRef(this.ns, this.#ref(slug));
    return ref ? (ref.value as IntegrationRecord) : null;
  }

  async list(): Promise<string[]> {
    const keys = await this.store.list(this.ns, "integrations/");
    return [...new Set(keys.filter((k) => k.endsWith("/created.json")).map((k) => k.split("/")[1]!))].sort();
  }

  /** Catalog marker bytes are derived ONLY from the winning record, so every writer produces identical bytes (legacy format). */
  #markerFor(rec: Pick<IntegrationRecord, "slug" | "createdAt" | "createdByBuild">) {
    return { key: `integrations/${rec.slug}/created.json`, bytes: Buffer.from(canonicalJson({ slug: rec.slug, createdAt: rec.createdAt, createdByBuild: rec.createdByBuild })) };
  }

  /**
   * Make an existing integration discoverable by list(). Idempotent; repairs a create that
   * crashed (or failed) between the ref CAS and the marker put. Errors propagate.
   */
  async ensureListed(rec: Pick<IntegrationRecord, "slug" | "createdAt" | "createdByBuild">): Promise<void> {
    await this.store.put(this.ns, [this.#markerFor(rec)]);
  }

  /**
   * Create-once. The ref CAS decides the winner; the discovery marker is then written from
   * the winning record. A retry (or a losing concurrent creator) re-puts the same marker
   * bytes, so a marker lost to a crash/failed put is repaired instead of leaving an
   * integration permanently invisible. A failed marker put is thrown, never swallowed.
   */
  async create(rec: Omit<IntegrationRecord, "bundle" | "promoted" | "promotedHistory" | "validations" | "manufact">): Promise<{ record: IntegrationRecord; created: boolean }> {
    const full: IntegrationRecord = { ...rec, bundle: null, promoted: null, promotedHistory: [], validations: [], manufact: null };
    const res = await this.store.casRef(this.ns, this.#ref(rec.slug), null, full);
    const winner = res.ok ? full : (res.current?.value as IntegrationRecord | undefined);
    if (!winner) throw new IntegrationError("store_conflict", `Could not create integration ${rec.slug}`);
    await this.ensureListed(winner);
    return { record: winner, created: res.ok };
  }

  /** CAS read-modify-write. `fn` must be a pure function of the current record; it is re-run on conflict. */
  async update(slug: string, fn: (cur: IntegrationRecord) => IntegrationRecord): Promise<IntegrationRecord> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ref = await this.store.getRef(this.ns, this.#ref(slug));
      if (!ref) throw new IntegrationError("unknown_integration", `Integration ${slug} does not exist`);
      const next = fn(structuredClone(ref.value as IntegrationRecord));
      next.validations = next.validations.slice(-HISTORY_LIMIT);
      next.promotedHistory = next.promotedHistory.slice(-HISTORY_LIMIT);
      if (next.manufact) next.manufact.history = next.manufact.history.slice(-HISTORY_LIMIT);
      if (next.lifecycle) next.lifecycle.history = next.lifecycle.history.slice(-HISTORY_LIMIT);
      const res = await this.store.casRef(this.ns, this.#ref(slug), ref.version, next);
      if (res.ok) return next;
    }
    throw new IntegrationError("store_conflict", `Concurrent updates to integration ${slug}; retry`);
  }

  /** Store bytes content-addressed; returns blobs/<sha256>. Identical re-puts are no-ops. */
  async putBlob(bytes: Buffer): Promise<{ key: string; sha256: string; bytes: number }> {
    const digest = sha256(bytes);
    const key = `blobs/${digest}`;
    await this.store.put(this.ns, [{ key, bytes }]);
    return { key, sha256: digest, bytes: bytes.length };
  }

  async getBlob(key: string): Promise<Buffer> {
    const got = (await this.store.get(this.ns, [key])).get(key);
    if (!got) throw new IntegrationError("blob_missing", `Stored object ${key} is missing`);
    if (key.startsWith("blobs/") && sha256(got) !== key.slice(6)) throw new IntegrationError("blob_corrupt", `Stored object ${key} failed its digest check`);
    return got;
  }

  /**
   * Immutable receipt keyed by content: id = <prefix>-<sha256(canonical body)[0:24]>.
   * Re-putting the same receipt is idempotent.
   */
  async putReceipt<T extends object>(slug: string, prefix: "val" | "pub" | "snap" | "life", body: T): Promise<{ receiptId: string; key: string }> {
    const receiptId = `${prefix}-${sha256(canonicalJson(body)).slice(0, 24)}`;
    const key = `integrations/${assertSlug(slug)}/receipts/${receiptId}.json`;
    await this.store.put(this.ns, [{ key, bytes: Buffer.from(canonicalJson({ receiptId, ...body })) }]);
    return { receiptId, key };
  }

  async getReceipt(slug: string, receiptId: string): Promise<Record<string, unknown> | null> {
    if (!/^(val|pub|snap|life)-[0-9a-f]{24}$/.test(receiptId)) throw new IntegrationError("invalid_receipt_id", `Invalid receipt id ${receiptId}`);
    const key = `integrations/${assertSlug(slug)}/receipts/${receiptId}.json`;
    const got = (await this.store.get(this.ns, [key])).get(key);
    return got ? (JSON.parse(got.toString("utf8")) as Record<string, unknown>) : null;
  }
}
