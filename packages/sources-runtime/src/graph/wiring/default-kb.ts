import type { db } from "../../db/client.js";

/**
 * SOURCE-LANE SHIM for Aqueduct `src/graph/wiring/default-kb.ts`
 * (askshepherd/aqueduct@b26d3f46236a36d64f841539abff2b1ffdace5cf).
 *
 * Donor connect/reconcile flows call `ensureDefaultKbForTenant` to create a graph
 * knowledge-base container and attach provider selectors. The source lane has no
 * knowledge base: this replacement touches no table and returns `kbId: null` so a
 * caller can never mistake it for a real container.
 */

type WiringExecutor = Pick<typeof db, "execute">;

export async function ensureDefaultKbForTenant(
  _executor: WiringExecutor,
  _tenantId: string,
): Promise<{ kbId: null; attachedProviders: string[] }> {
  return { kbId: null, attachedProviders: [] };
}
