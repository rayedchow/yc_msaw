import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, planMigrations } from "../../../src/source-lane/core/migrations.js";
import { setTenantBinding } from "../../../src/source-lane/export/bindings.js";
import { SourceExporter } from "../../../src/source-lane/export/exporter.js";
import { defaultRegistry, SourceProviderRegistry } from "../../../src/source-lane/registry.js";

/**
 * Coordinator regression for final-audit H1: the per-tenant export backlog in coverage is aggregated in SQL and joins
 * activity_events through its uuid primary key, so a large backfill journal no longer costs one table scan per
 * journal row inside the export loop. Real migrations on PGlite.
 */

const pg = new PGlite();
const db = drizzle(pg);
const T = "tenant-backlog";

beforeAll(async () => {
  for (const file of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  for (let i = 0; i < 30; i++) {
    const source = i % 3 === 0 ? "gmail" : "slack";
    await pg.query(
      `INSERT INTO activity_events (user_id, source, event_type, timestamp, raw_payload, source_event_id) VALUES ($1, $2, 'message', now(), '{}'::jsonb, $3)`,
      [T, source, `${source}:evt:${i}`],
    );
  }
  await pg.query(`INSERT INTO mirror_files (path, user_id, content, updated_at) VALUES ('sources/notion/page.md', $1, 'x', now())`, [T]);
  // A journal row whose key is not a uuid (corrupt or foreign) must not break the query.
  await pg.query(`INSERT INTO source_lane_journal (tenant_id, table_name, row_key, op) VALUES ($1, 'activity_events', 'not-a-uuid', 'INSERT')`, [T]);
  await pg.query(
    `UPDATE source_lane_journal SET dead_lettered_at = now(), last_error = 'store rejected' WHERE id = (SELECT j.id FROM source_lane_journal j JOIN activity_events a ON a.id::text = j.row_key WHERE a.source = 'gmail' ORDER BY j.id LIMIT 1)`,
  );
});

describe("exporter backlog coverage", () => {
  it("counts backlog and dead letters per provider directory from one aggregated query", async () => {
    const exporter = new SourceExporter({ db: db as never, registry: defaultRegistry(), log: () => {} });
    const exportScopes = Object.fromEntries((await exporter.coverage(T)).filter((c) => c.scope === "export").map((c) => [c.provider, c]));
    expect(exportScopes.slack).toMatchObject({ state: "pending", counts: { backlog: 20, deadLettered: 0 } });
    expect(exportScopes.gmail).toMatchObject({ state: "partial", counts: { backlog: 9, deadLettered: 1 } });
    expect(exportScopes.gmail!.reason).toMatch(/store rejected/);
    expect(exportScopes.notion).toMatchObject({ counts: { backlog: 1 } });
    expect(exportScopes["unknown-source"]).toMatchObject({ counts: { backlog: 1 } });
  });

  it("never looks rows up by casting a uuid primary key to text in the source lane", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /\bid::text\s*(=|IN\s*\()/u.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(__dirname, "../../../src/source-lane"));
    expect(offenders).toEqual([]);
  });
});

describe("status heartbeat off the export critical path", () => {
  it("keeps exporting while a slow coverage check is pending, and reports account owners with the heartbeat", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bodies: Array<Record<string, unknown>> = [];
    const registry = new SourceProviderRegistry([
      {
        id: "slow",
        eventSources: [],
        mirrorRoots: [],
        coverage: async () => {
          await gate;
          return [{ provider: "slow", scope: "all", state: "complete" }];
        },
        accountOwners: async () => [{ account: "ada@corp.example", subject: "user_ada", issuer: "https://auth.example.test" }],
      },
    ]);
    await setTenantBinding(db as never, { tenantId: "tenant-heartbeat", bindingId: "sb-0123456789abcdef", token: `psb_tenant-heartbeat.sb-0123456789abcdef.${"a".repeat(43)}`, publishUrl: "http://127.0.0.1:9", providers: ["*"] });
    class Counting extends SourceExporter {
      passes = 0;
      override async runOnce() {
        this.passes++;
        return { claimed: 1, acked: 1, deadLettered: 0, released: 0, tenants: 1 };
      }
    }
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const exporter = new Counting({ db: db as never, registry, fetchImpl, reportIntervalSeconds: 10, log: () => {} });
    const abort = new AbortController();
    const running = exporter.run(abort.signal);
    await new Promise((r) => setTimeout(r, 600));
    // Coverage is still blocked, yet the export loop kept running passes.
    expect(exporter.passes).toBeGreaterThanOrEqual(3);
    expect(bodies).toHaveLength(0);
    release();
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await running;
    expect(bodies[0]).toMatchObject({ googleAccounts: [{ account: "ada@corp.example", subject: "user_ada" }] });
  });
});
