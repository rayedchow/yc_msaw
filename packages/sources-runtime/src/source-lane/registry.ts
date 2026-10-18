import { SOURCE_PROVIDERS } from "./providers/index.js";
import type { ExtraTableExport, SourceProviderModule } from "./core/types.js";

export type * from "./core/types.js";

/**
 * Source-lane provider registry. Provider modules live in
 * `providers/<id>/index.ts` (owned by the per-integration agents) and are listed
 * once in `providers/index.ts`. The exporter, internal API, public API and worker
 * read only this registry, so a provider is enabled by adding its module.
 */

export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class SourceProviderRegistry {
  readonly #byId = new Map<string, SourceProviderModule>();
  readonly #byEventSource = new Map<string, SourceProviderModule>();
  readonly #mirrorRoots: Array<[string, SourceProviderModule]> = [];
  readonly #tables = new Map<string, { provider: SourceProviderModule; table: ExtraTableExport }>();

  constructor(readonly modules: readonly SourceProviderModule[]) {
    for (const m of modules) {
      if (!PROVIDER_ID_RE.test(m.id)) throw new Error(`source provider id ${JSON.stringify(m.id)} must match ${PROVIDER_ID_RE}`);
      if (this.#byId.has(m.id)) throw new Error(`duplicate source provider ${m.id}`);
      this.#byId.set(m.id, m);
      for (const s of m.eventSources) {
        const other = this.#byEventSource.get(s);
        if (other) throw new Error(`activity_events.source ${s} claimed by both ${other.id} and ${m.id}`);
        this.#byEventSource.set(s, m);
      }
      for (const root of m.mirrorRoots) {
        if (!root.startsWith(`sources/${m.id}/`) && root !== `sources/${m.id}/`) {
          throw new Error(`provider ${m.id} mirror root ${root} must live under sources/${m.id}/`);
        }
        this.#mirrorRoots.push([root, m]);
      }
      for (const t of m.extraTables ?? []) {
        if (this.#tables.has(t.table)) throw new Error(`extra table ${t.table} claimed twice`);
        this.#tables.set(t.table, { provider: m, table: t });
      }
    }
    // Longest prefix wins so nested roots can be owned by a more specific module.
    this.#mirrorRoots.sort((a, b) => b[0].length - a[0].length);
  }

  get(id: string): SourceProviderModule | undefined {
    return this.#byId.get(id);
  }

  forEventSource(source: string): SourceProviderModule | undefined {
    return this.#byEventSource.get(source);
  }

  forMirrorPath(path: string): SourceProviderModule | undefined {
    return this.#mirrorRoots.find(([root]) => path.startsWith(root))?.[1];
  }

  extraTable(table: string): { provider: SourceProviderModule; table: ExtraTableExport } | undefined {
    return this.#tables.get(table);
  }

  get providerIds(): string[] {
    return [...this.#byId.keys()].sort();
  }
}

export function defaultRegistry(): SourceProviderRegistry {
  return new SourceProviderRegistry(SOURCE_PROVIDERS);
}

/**
 * Provider directory for an activity_events.source value no module claims (e.g. a newly
 * enabled Nango provider): lowercased, non [a-z0-9-] runs become "-". Such rows still
 * export raw under sources/<dir>/_raw/ and are reported as `pending` coverage.
 */
export function fallbackProviderDir(source: string): string {
  const dir = source.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return PROVIDER_ID_RE.test(dir) ? dir : "unknown-source";
}
