import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const { db } = await import("./pg.js");
  return { db, pgClient: null };
});

import { buildCatalog, loadCatalogFromEnv } from "../../../../src/source-lane/providers/nango-records/config.js";
import { createNangoRecordsModules, isNangoRecordsModule, withNangoRecordsProviders } from "../../../../src/source-lane/providers/nango-records/index.js";
import { laneFromEnv } from "../../../../src/source-lane/providers/nango-records/lane.js";
import { SOURCE_PROVIDERS as REGISTERED } from "../../../../src/source-lane/providers/index.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { db } from "./harness.js";

/**
 * Dynamic provider registration: only operator-declared Nango integrations become sources,
 * and none may take a directory, activity_events source or Nango integration that a
 * specialized module (or the donor Nango lane) already owns.
 */

const cfg = (sources: unknown[]) => ({ version: 1, sources });
/** The real specialized modules (the registry also holds this lane's modules once providers/index.ts appends them). */
const SOURCE_PROVIDERS = REGISTERED.filter((m) => !isNangoRecordsModule(m));

describe("generic Nango catalog vs the real provider registry", () => {
  it("refuses sources that collide with specialized modules or donor-captured integrations", () => {
    const withAlias = SOURCE_PROVIDERS.find((m) => m.eventSources.some((e) => e !== m.id))!;
    const alias = withAlias.eventSources.find((e) => e !== withAlias.id)!;
    const catalog = buildCatalog(
      cfg([
        { source: "gmail", providerConfigKey: "my-gmail", models: ["Email"] },
        { source: alias, providerConfigKey: "alias-collision", models: ["X"] },
        { source: "atlassian-wiki", providerConfigKey: "confluence", models: ["Page"] },
        { source: "jira-extra", providerConfigKey: "JIRA", models: ["Issue"] },
        { source: "nango-records", providerConfigKey: "self", models: ["X"] },
        { source: "outlook", providerConfigKey: "acme-outlook", models: ["OutlookMessage"] },
        { source: "outlook", providerConfigKey: "acme-outlook-2", models: ["OutlookMessage"] },
        { source: "outlook-2", providerConfigKey: "acme-outlook", models: ["OutlookMessage"] },
        { source: "dropbox", providerConfigKey: "acme-dropbox", models: [] },
        { source: "onedrive", providerConfigKey: "acme-onedrive", models: ["OneDriveFile"], discoverModels: false },
        { source: "hubspot", providerConfigKey: "acme-hubspot", discoverModels: true },
      ]),
      SOURCE_PROVIDERS,
    );
    expect(catalog.errors).toEqual([]);
    expect(catalog.sources.map((s) => s.source)).toEqual(["outlook", "onedrive", "hubspot"]);
    const why = Object.fromEntries(catalog.refused.map((r) => [`${r.source}|${r.providerConfigKey}`, r.reason]));
    expect(why["gmail|my-gmail"]).toMatch(/owned by a specialized provider module/);
    expect(why[`${alias}|alias-collision`]).toMatch(/claimed by a specialized provider module/);
    expect(why["atlassian-wiki|confluence"]).toMatch(/captured by a specialized integration/);
    expect(why["jira-extra|JIRA"]).toMatch(/captured by a specialized integration/);
    expect(why["nango-records|self"]).toBeTruthy();
    expect(why["outlook|acme-outlook-2"]).toMatch(/declared twice/);
    expect(why["outlook-2|acme-outlook"]).toMatch(/already mapped to source "outlook"/);
    expect(why["dropbox|acme-dropbox"]).toMatch(/no models declared/);
  });

  it("builds a registry with the real specialized modules plus the configured sources", () => {
    const env = { NANGO_RECORDS_CONFIG: JSON.stringify(cfg([{ source: "outlook", providerConfigKey: "acme-outlook", models: ["OutlookMessage"] }, { source: "box", providerConfigKey: "acme-box", models: ["BoxFile"] }])) };
    const all = withNangoRecordsProviders(SOURCE_PROVIDERS, { env, db, api: null });
    const registry = new SourceProviderRegistry(all);
    expect(registry.get("nango-records")).toBeDefined();
    expect(registry.forEventSource("outlook")?.id).toBe("outlook");
    expect(registry.forEventSource("box")?.connectionProviders).toEqual(["acme-box"]);
    for (const m of SOURCE_PROVIDERS) expect(registry.get(m.id)).toBe(m);
    // Task kinds of the lane never collide with graph/wiki handlers.
    const kinds = Object.keys(registry.get("nango-records")!.taskHandlers!());
    expect(kinds.sort()).toEqual(["nango_records.poll", "nango_records.reconcile", "nango_records.sync"]);
  });

  it("a later specialized module takes precedence over a configured generic source of the same name", () => {
    const linear = { id: "linear", eventSources: ["linear"], mirrorRoots: ["sources/linear/"] };
    const env = { NANGO_RECORDS_CONFIG: JSON.stringify(cfg([{ source: "linear", providerConfigKey: "acme-linear", models: ["LinearIssue"] }])) };
    const before = laneFromEnv(env, SOURCE_PROVIDERS, { db, api: null });
    expect(before.catalog.sources.map((s) => s.source)).toEqual(["linear"]);
    const after = laneFromEnv(env, [...SOURCE_PROVIDERS, linear], { db, api: null });
    expect(after.catalog.sources).toEqual([]);
    expect(after.catalog.refused[0]!.reason).toMatch(/owned by a specialized provider module/);
    expect(() => new SourceProviderRegistry([...SOURCE_PROVIDERS, linear, ...createNangoRecordsModules(after)])).not.toThrow();
  });

  it("captures nothing from an invalid or absent config and says why", async () => {
    expect(loadCatalogFromEnv({}, SOURCE_PROVIDERS)).toEqual({ sources: [], refused: [], errors: [] });
    const bad = loadCatalogFromEnv({ NANGO_RECORDS_CONFIG: "{not json" }, SOURCE_PROVIDERS);
    expect(bad.sources).toEqual([]);
    expect(bad.errors[0]).toMatch(/not valid JSON/);
    const unknownKey = loadCatalogFromEnv({ NANGO_RECORDS_CONFIG: JSON.stringify({ version: 1, sources: [{ source: "outlook", providerConfigKey: "k", models: ["M"], tenantId: "acme" }] }) }, SOURCE_PROVIDERS);
    expect(unknownKey.sources).toEqual([]);
    expect(unknownKey.errors.join(" ")).toMatch(/tenantId|Unrecognized/i);
    const lane = laneFromEnv({ NANGO_RECORDS_CONFIG: "{not json", NANGO_RECORDS_WEBHOOK_URL: "http://insecure.example" }, SOURCE_PROVIDERS, { db, api: null });
    expect(lane.catalog.errors).toHaveLength(2);
    const cov = await createNangoRecordsModules(lane)[0]!.coverage!({ tenantId: "acme", executor: db });
    expect(cov.map((c) => c.state)).toEqual(["blocked", "blocked"]);
  });
});
