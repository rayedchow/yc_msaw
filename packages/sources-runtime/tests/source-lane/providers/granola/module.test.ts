import { describe, expect, it } from "vitest";

// Imported in production order (registry first): the provider module must still carry its
// extra table, i.e. no import cycle leaves GRANOLA_EXTRA_TABLES uninitialised.
import { defaultRegistry } from "../../../../src/source-lane/registry.js";
import { planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { sourceLaneTaskHandlers } from "../../../../src/source-lane/worker.js";

describe("granola source-lane module registration", () => {
  it("registers raw/mirror ownership, the native catalog table and coverage through the real registry", () => {
    const registry = defaultRegistry();
    const granola = registry.get("granola")!;
    expect(granola.eventSources).toEqual(["granola"]);
    expect(registry.forMirrorPath("sources/granola/Weekly-meeting-abc/summary.md")?.id).toBe("granola");
    expect(registry.extraTable("granola_source_notes")?.provider.id).toBe("granola");
    expect(registry.extraTable("granola_source_notes")?.table).toMatchObject({ tenantColumn: "tenant_id", keyColumn: "note_id" });
    expect(typeof granola.coverage).toBe("function");
  });

  it("ships its migration in the lane plan and keeps the donor granola task kinds on the source worker", () => {
    expect(planMigrations().apply).toContain("9500_granola_source_lane.sql");
    const handlers = sourceLaneTaskHandlers(defaultRegistry());
    expect(typeof handlers["granola.poll"]).toBe("function");
    expect(typeof handlers["granola.backfill"]).toBe("function");
  });
});
