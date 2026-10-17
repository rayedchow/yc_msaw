import type { ObjectStore } from "../store/objects.js";
import { dailyRefName, getDailyRef, loadManifest, type DailyRefValue } from "../traces/index.js";

/**
 * Build ownership for a day's manifest, layered on the daily ref (CAS):
 *  - claim: atomically moves pinned|failed -> building with an owner buildId and
 *    a lease deadline. Two processes racing on the same manifest: exactly one wins.
 *  - renew: the owner extends its lease while the build runs (heartbeat).
 *  - finish: only the current owner of the still-latest manifest may record
 *    published|failed (fencing). A superseded or expired owner is rejected.
 * Recovery: a crashed owner stops renewing; once its lease expires the next
 * trigger force-pins a superseding manifest (same chunks + any late ones) and
 * claims it, so a dead build never stalls a day.
 */
export type LeasedRef = DailyRefValue & { leaseUntil?: string };

export const DEFAULT_LEASE_MS = 10 * 60_000;

export class FencedError extends Error {
  readonly code = "fenced";
}

export function leaseExpired(v: LeasedRef | null | undefined, now = Date.now()): boolean {
  if (!v || v.status !== "building") return false;
  // Refs written before leases existed fall back to updatedAt + default lease.
  const until = v.leaseUntil ? Date.parse(v.leaseUntil) : Date.parse(v.updatedAt) + DEFAULT_LEASE_MS;
  return !Number.isFinite(until) || until <= now;
}

type ClaimResult = { ok: true; value: LeasedRef } | { ok: false; reason: "superseded" | "claimed" | "published" | "contention"; value: LeasedRef | null };

export async function claimDailyBuild(
  store: ObjectStore,
  ns: string,
  day: string,
  input: { manifestKey: string; buildId: string; leaseMs?: number; now?: () => number },
): Promise<ClaimResult> {
  const now = input.now ?? Date.now;
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = await getDailyRef(store, ns, day);
    const v = (ref?.value ?? null) as LeasedRef | null;
    if (!ref || !v || v.latestManifest !== input.manifestKey) return { ok: false, reason: "superseded", value: v };
    if (v.status === "published") return { ok: false, reason: "published", value: v };
    if (v.status === "building" && !leaseExpired(v, now())) return { ok: false, reason: "claimed", value: v };
    const t = now();
    const next: LeasedRef = {
      ...v,
      status: "building",
      buildId: input.buildId,
      leaseUntil: new Date(t + (input.leaseMs ?? DEFAULT_LEASE_MS)).toISOString(),
      attempts: v.attempts + 1,
      updatedAt: new Date(t).toISOString(),
    };
    delete next.error;
    const cas = await store.casRef(ns, dailyRefName(day), ref.version, next);
    if (cas.ok) return { ok: true, value: next };
  }
  return { ok: false, reason: "contention", value: null };
}

/** Extend the owner's lease. Returns false if this build no longer owns the day (it must stop). */
export async function renewDailyLease(
  store: ObjectStore,
  ns: string,
  day: string,
  input: { manifestKey: string; buildId: string; leaseMs?: number; now?: () => number },
): Promise<boolean> {
  const now = input.now ?? Date.now;
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = await getDailyRef(store, ns, day);
    const v = ref?.value as LeasedRef | undefined;
    if (!ref || !v || v.latestManifest !== input.manifestKey || v.status !== "building" || v.buildId !== input.buildId) return false;
    const next: LeasedRef = { ...v, leaseUntil: new Date(now() + (input.leaseMs ?? DEFAULT_LEASE_MS)).toISOString() };
    if ((await store.casRef(ns, dailyRefName(day), ref.version, next)).ok) return true;
  }
  return false;
}

/** Record the final status; only the current owner of the latest manifest may do so. */
export async function finishDailyBuild(
  store: ObjectStore,
  ns: string,
  day: string,
  input: { manifestKey: string; buildId: string; status: "published" | "failed"; revisionId?: string; error?: string },
): Promise<LeasedRef> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = await getDailyRef(store, ns, day);
    const v = ref?.value as LeasedRef | undefined;
    if (!ref || !v) throw new FencedError(`No daily ref for ${day}`);
    if (v.latestManifest !== input.manifestKey) throw new FencedError(`Manifest ${input.manifestKey} was superseded by ${v.latestManifest}`);
    if (v.status === "published" && v.buildId === input.buildId && input.status === "published") return v; // idempotent retry
    if (v.status !== "building" || v.buildId !== input.buildId) {
      throw new FencedError(`Build ${input.buildId} no longer owns ${day} (status ${v.status}, owner ${v.buildId ?? "none"})`);
    }
    const next: LeasedRef = { ...v, status: input.status, updatedAt: new Date().toISOString() };
    delete next.leaseUntil;
    if (input.revisionId) next.revisionId = input.revisionId;
    if (input.status === "failed") next.error = (input.error ?? "build failed").slice(0, 2000);
    else {
      const manifest = await loadManifest(store, ns, input.manifestKey);
      next.publishedManifests = [...v.publishedManifests, input.manifestKey];
      next.processedChunkKeys = v.processedChunkKeys + manifest.chunks.length;
      delete next.error;
    }
    if ((await store.casRef(ns, dailyRefName(day), ref.version, next)).ok) return next;
  }
  throw new Error(`Could not record final status for ${day}: too much concurrent contention`);
}
