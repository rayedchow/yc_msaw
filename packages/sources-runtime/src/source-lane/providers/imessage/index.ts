import type { SourceProviderModule } from "../../core/types.js";
import { imessageCoverage } from "./coverage.js";
import { imessageMutationsTable, imessageRejectionsTable, mapImessageEvent, mapImessageMirror } from "./export.js";
import { createBindingAuthority, type DeviceAuthority } from "./authority.js";
import { imessageTaskHandlers, registerImessageInternalRoutes, registerImessagePublicRoutes } from "./routes.js";
import type { ImessageDb } from "./util.js";

/**
 * iMessage (Mac uploader receiver) source-lane module.
 *
 * Receiver: port of gigabrain@5448774e brain/src/routes/imessage-ingest.ts (the five
 * /api/imessage/ingest* endpoints, served on the runtime's public host) onto the runtime's
 * Postgres, authorized by yc_msaw device bindings (device-auth.ts, authority.ts). Exports raw activity_events rows, the raw mutation and
 * rejection ledgers, and the conversation/month projections (projector.ts) under
 * sources/imessage/. See README.md for the wire, auth, layout and limitations.
 */

export interface ImessageProviderOptions {
  /** Database for the receiver routes and tasks (default: the donor drizzle client, loaded on first use). */
  db?: ImessageDb;
  /** Device-key authority (default: yc_msaw at the tenant's binding publish URL, authority.ts). */
  authority?: DeviceAuthority;
}

let defaultDb: Promise<ImessageDb> | null = null;
async function donorDb(): Promise<ImessageDb> {
  defaultDb ??= import("../../../db/client.js").then((m) => m.db as unknown as ImessageDb);
  return defaultDb;
}

/** A database handle that resolves the donor client lazily (so importing the registry opens no connection). */
function lazyDb(): ImessageDb {
  return {
    execute: (async (q: unknown) => (await donorDb()).execute(q as never)) as unknown as ImessageDb["execute"],
    transaction: (async (fn: unknown, cfg?: unknown) => (await donorDb()).transaction(fn as never, cfg as never)) as unknown as ImessageDb["transaction"],
  };
}

export function createImessageProvider(opts: ImessageProviderOptions = {}): SourceProviderModule {
  const db = opts.db ?? lazyDb();
  const authority = opts.authority ?? createBindingAuthority(db);
  return {
    id: "imessage",
    // imessage_alias: the donor's archived duplicates stay raw records under sources/imessage/_raw/.
    eventSources: ["imessage", "imessage_alias"],
    mirrorRoots: ["sources/imessage/"],
    connectionProviders: [],
    mapEvent: mapImessageEvent,
    mapMirror: mapImessageMirror,
    extraTables: [imessageMutationsTable, imessageRejectionsTable],
    coverage: imessageCoverage,
    publicRoutes: (app) => registerImessagePublicRoutes(app, { db, authority }),
    internalRoutes: (app, deps) => registerImessageInternalRoutes(app, deps, { db }),
    taskHandlers: () => imessageTaskHandlers(db),
  };
}

export const imessageProvider: SourceProviderModule = createImessageProvider();
