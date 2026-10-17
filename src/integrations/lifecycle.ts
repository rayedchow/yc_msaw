import { errorMessage } from "../util.js";
import type { ManufactApi } from "./manufact.js";
import { lifecycleState, type IntegrationLifecycle, type IntegrationRecord, type IntegrationStore, type LifecycleEvent } from "./store.js";
import { IntegrationError } from "./types.js";

/**
 * Reversible retirement of an integration from customer discovery.
 *
 * retire: CAS-writes lifecycle.state = "retired" (+ immutable life- receipt). Nothing is deleted:
 * repo bundles/history, validation/publish receipts and the promoted revision stay. The customer
 * catalog and token exchange exclude it from the next read on. Already-issued child tokens are
 * stateless and stay valid at the child until they expire (<= 900 s via the parent route, 3600 s
 * cap) UNLESS stopDeployment is requested, which stops the active Manufact deployment (no data
 * deleted) so the child stops serving; that deployment then needs a new publish after restore.
 *
 * restore: CAS-writes lifecycle.state = "active". If the last active deployment is still recorded
 * as running + probe-passed it is listed again immediately; otherwise after the next publish.
 * Publishing/rolling back never re-enables a retired integration implicitly (both refuse).
 */
export interface LifecycleOutcome {
  slug: string;
  state: "active" | "retired";
  changed: boolean;
  receiptId: string | null;
  /** Whether the customer catalog lists the integration right now. */
  listed: boolean;
  stop: { requested: boolean; deploymentId: string | null; stopped: boolean; error: string | null; receiptId: string | null };
  lifecycle: IntegrationLifecycle | null;
  note: string;
}

/**
 * The single "recorded live" predicate used by the customer catalog: lifecycle active, an active
 * deployment recorded with status "running" AND a passing post-deploy MCP probe, and an mcpUrl.
 */
export function isListed(r: IntegrationRecord): boolean {
  const a = r.manufact?.active;
  return lifecycleState(r) === "active" && !!a && a.status === "running" && a.probe === "passed" && !!r.manufact?.mcpUrl;
}

function nextLifecycle(cur: IntegrationRecord, ev: LifecycleEvent): IntegrationLifecycle {
  return { state: ev.state, changedAt: ev.at, history: [...(cur.lifecycle?.history ?? []), ev] };
}

export async function retireIntegration(p: {
  store: IntegrationStore;
  slug: string;
  buildId: string;
  reason: string;
  stopDeployment?: boolean;
  api?: ManufactApi | null;
  now?: () => Date;
}): Promise<LifecycleOutcome> {
  const rec = await p.store.get(p.slug);
  if (!rec) throw new IntegrationError("unknown_integration", `Integration ${p.slug} does not exist`);
  if (p.stopDeployment && !p.api) throw new IntegrationError("publisher_not_configured", "stopDeployment needs host Manufact credentials");
  const stop: LifecycleOutcome["stop"] = { requested: !!p.stopDeployment, deploymentId: null, stopped: false, error: null, receiptId: null };
  let receiptId: string | null = null;
  let changed = false;
  let current = rec;
  if (lifecycleState(rec) !== "retired") {
    const at = (p.now ?? (() => new Date()))().toISOString();
    ({ receiptId } = await p.store.putReceipt(p.slug, "life", {
      kind: "integration_lifecycle",
      action: "retire",
      slug: p.slug,
      buildId: p.buildId,
      reason: p.reason,
      at,
      previousState: lifecycleState(rec),
      activeDeploymentId: rec.manufact?.active?.deploymentId ?? null,
      wasListed: isListed(rec),
      stopRequested: !!p.stopDeployment,
      tokenNote: "Already-issued child tokens stay valid until expiry (<=900 s via the parent route) unless the deployment is stopped.",
    }));
    const ev: LifecycleEvent = { state: "retired", at, buildId: p.buildId, reason: p.reason, receiptId };
    // Pure function of the current record: re-run on CAS conflict; a concurrent retire is a no-op.
    current = await p.store.update(p.slug, (cur) => (lifecycleState(cur) === "retired" ? cur : { ...cur, lifecycle: nextLifecycle(cur, ev) }));
    changed = current.lifecycle?.history.at(-1)?.receiptId === receiptId;
  }
  if (p.stopDeployment) {
    const active = current.manufact?.active ?? null;
    stop.deploymentId = active?.deploymentId ?? null;
    if (active && p.api) {
      try {
        await p.api.stopDeployment(active.deploymentId);
        stop.stopped = true;
      } catch (error) {
        stop.error = errorMessage(error);
      }
      const at = (p.now ?? (() => new Date()))().toISOString();
      stop.receiptId = (await p.store.putReceipt(p.slug, "life", { kind: "integration_lifecycle", action: "stop_deployment", slug: p.slug, buildId: p.buildId, deploymentId: active.deploymentId, stopped: stop.stopped, error: stop.error, at })).receiptId;
      if (stop.stopped) {
        current = await p.store.update(p.slug, (cur) => {
          const m = cur.manufact;
          if (!m?.active || m.active.deploymentId !== active.deploymentId) return cur;
          const stoppedRec = { ...m.active, status: "stopped", action: "stop", at, receiptId: stop.receiptId! };
          const hist = cur.lifecycle?.history ?? [];
          const last = hist.at(-1);
          const lifecycle = cur.lifecycle && last ? { ...cur.lifecycle, history: [...hist.slice(0, -1), { ...last, stoppedDeploymentId: active.deploymentId }] } : cur.lifecycle;
          return { ...cur, manufact: { ...m, active: null, history: [...m.history, stoppedRec] }, ...(lifecycle ? { lifecycle } : {}) };
        });
      }
    }
  }
  // Report the state actually stored now (a concurrent restore may have won), never the intended one.
  const state = lifecycleState(current);
  const note =
    state !== "retired"
      ? `Not retired: the stored state is "${state}" (a concurrent lifecycle change won). Nothing was hidden by this call.`
      : stop.stopped
        ? "Retired and deployment stopped: hidden from the catalog, token exchange refused, and the child no longer serves. After integration_restore, publish again to list it."
        : changed
          ? "Retired: hidden from the catalog and token exchange refused from now on. Tokens already issued stay valid at the child until they expire (<=900 s); pass stopDeployment to cut them off."
          : "Already retired (no change).";
  return { slug: p.slug, state, changed, receiptId: changed ? receiptId : null, listed: isListed(current), stop, lifecycle: current.lifecycle ?? null, note };
}

export async function restoreIntegration(p: { store: IntegrationStore; slug: string; buildId: string; reason: string; now?: () => Date }): Promise<LifecycleOutcome> {
  const rec = await p.store.get(p.slug);
  if (!rec) throw new IntegrationError("unknown_integration", `Integration ${p.slug} does not exist`);
  const stop = { requested: false, deploymentId: null, stopped: false, error: null, receiptId: null };
  if (lifecycleState(rec) === "active") {
    return { slug: p.slug, state: "active", changed: false, receiptId: null, listed: isListed(rec), stop, lifecycle: rec.lifecycle ?? null, note: "Already active." };
  }
  const at = (p.now ?? (() => new Date()))().toISOString();
  const { receiptId } = await p.store.putReceipt(p.slug, "life", {
    kind: "integration_lifecycle",
    action: "restore",
    slug: p.slug,
    buildId: p.buildId,
    reason: p.reason,
    at,
    activeDeploymentId: rec.manufact?.active?.deploymentId ?? null,
  });
  const ev: LifecycleEvent = { state: "active", at, buildId: p.buildId, reason: p.reason, receiptId };
  const current = await p.store.update(p.slug, (cur) => (lifecycleState(cur) === "active" ? cur : { ...cur, lifecycle: nextLifecycle(cur, ev) }));
  const listed = isListed(current);
  const state = lifecycleState(current);
  const changed = current.lifecycle?.history.at(-1)?.receiptId === receiptId;
  return {
    slug: p.slug,
    state,
    changed,
    receiptId: changed ? receiptId : null,
    listed,
    stop,
    lifecycle: current.lifecycle ?? null,
    note:
      state !== "active"
        ? `Not restored: the stored state is "${state}" (a concurrent lifecycle change won).`
        : !changed
          ? listed
            ? "Already active (restored concurrently); it is listed."
            : "Already active (restored concurrently), but no running probe-passed deployment is recorded: run integration_publish to list it."
          : listed
            ? "Restored: the running, probe-passed deployment is listed again."
            : "Restored, but no running probe-passed deployment is recorded: run integration_publish to list it.",
  };
}
