import type { db } from "../../db/client.js";
import type { StagedDocumentMeta } from "../../mirror/envelope.js";

/**
 * SOURCE-LANE SHIM for Aqueduct `src/graph/wiring/ingest-hook.ts`
 * (askshepherd/aqueduct@b26d3f46236a36d64f841539abff2b1ffdace5cf).
 *
 * The donor module turns every mirror write into `graph.*` queue tasks (chunking,
 * extraction, LLM claims). The source lane never builds a graph: this replacement
 * keeps the donor export names and signatures that copied sourcing code imports,
 * and none of them read kb tables or enqueue anything. Mirror changes reach the
 * sources/ filesystem through the `source_export_journal` triggers
 * (drizzle/9000_source_lane_export.sql), which see every insert/update/delete
 * regardless of which call site produced it.
 */

type WiringExecutor = Pick<typeof db, "execute">;

export interface MirrorGraphIngestInput {
  tenantId: string;
  path: string;
  contentSha: string | null;
  meta?: StagedDocumentMeta | null;
  metadataOnly?: boolean;
  updatedAt?: string | Date | null;
}

export interface MirrorGraphDeleteInput {
  tenantId: string;
  path: string;
}

export interface GoogleDocScopeEntryInput {
  tenantId: string;
  docId: string;
  mirrorPathPrefix: string | null;
  folderIds: readonly string[];
  previousFolderIds: readonly string[];
}

/** Graph ingestion is structurally disabled in the source lane. */
export const SOURCE_LANE_GRAPH_DISABLED = true as const;

/** Always false: donor call sites that gate graph delete fan-out on this skip it. */
export function graphIngestEnabled(): boolean {
  return false;
}

export async function enqueueGraphIngestForMirrorFile(_executor: WiringExecutor, _input: MirrorGraphIngestInput): Promise<void> {}

export async function enqueueGraphDeleteForMirrorFile(_executor: WiringExecutor, _input: MirrorGraphDeleteInput): Promise<void> {}

export async function enqueueGraphIngestForGoogleDocScopeEntry(_executor: WiringExecutor, _input: GoogleDocScopeEntryInput): Promise<void> {}

/** Donor helper kept verbatim in behaviour (pure path normalization, no graph state). */
export function normalizeMirrorPath(path: string): string {
  return path.replace(/^\/+/u, "").replace(/\/{2,}/gu, "/");
}
