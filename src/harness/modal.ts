import { createModalLease, type ModalLeaseOptions } from "../sandbox/modal.js";
import { ModalBuildWorkspace, type BuildWorkspaceFactory } from "./workspace.js";

/**
 * Hosted build workspaces: one isolated Modal sandbox per build agent
 * (network blocked by default, inputs/published protected by the OS).
 * If a lease cannot be created, the spawn/build fails explicitly; there is no
 * fallback to LocalBuildWorkspace.
 */
export function createModalBuildWorkspaceFactory(opts: ModalLeaseOptions & { execTimeoutMs?: number } = {}): BuildWorkspaceFactory {
  const { execTimeoutMs, ...lease } = opts;
  return (spec) =>
    new ModalBuildWorkspace(
      () => createModalLease({ ...lease, blockNetwork: lease.blockNetwork ?? true, tags: { ...(lease.tags ?? {}), purpose: "procmem-build", build: spec.buildId.slice(0, 60), agent: spec.agentId.slice(0, 60) } }),
      { execTimeoutMs },
    );
}
