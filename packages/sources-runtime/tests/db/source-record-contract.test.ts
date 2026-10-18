import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityEvents, sourceDocuments } from "../../src/db/schema.js";

describe("source record schema", () => {
  it("exposes the minimal raw and projection columns", () => {
    expect(getTableColumns(activityEvents)).toMatchObject({
      sourceNamespace: expect.anything(),
      sourceObjectId: expect.anything(),
      recordKind: expect.anything(),
    });
    expect(getTableColumns(sourceDocuments)).toMatchObject({
      sourceNamespace: expect.anything(),
      representedType: expect.anything(),
      sourceLinks: expect.anything(),
    });
  });
});

describe("0066 source record migration", () => {
  const migration = readFileSync(new URL("../../drizzle/0066_source_record_contract.sql", import.meta.url), "utf8");

  it("adds the object history index and namespace-safe projection uniqueness", () => {
    expect(migration).toContain('ADD COLUMN "source_namespace" text');
    expect(migration).toContain('"record_kind" IN (\'snapshot\', \'activity\', \'tombstone\')');
    expect(migration).toContain('CREATE INDEX "idx_event_object_history"');
    expect(migration).toContain('("user_id", "source", "source_namespace", "source_object_id", "timestamp")');
    expect(migration).toContain('CREATE UNIQUE INDEX "uq_source_document_kb_provider_namespace_external_kind"');
    expect(migration).toContain('NULLS NOT DISTINCT');
    expect(migration).not.toMatch(/CREATE\s+TABLE/iu);
  });

  it("backfills only three payload-exact connector cases", () => {
    const updates = migration.match(/UPDATE "activity_events"/gu) ?? [];
    expect(updates).toHaveLength(3);
    expect(migration).toContain('WHERE "source" = \'gmail\'');
    expect(migration).toContain('WHERE "source" = \'granola\'');
    expect(migration).toContain('WHERE "source" = \'calendar\'');
    expect(migration).toContain("Ambiguous legacy rows remain NULL");
    expect(migration).not.toContain('WHERE "source" = \'slack\'');
  });
});

describe("active capture writers", () => {
  it("never update previously captured activity event payloads", () => {
    const writers = [
      "../../src/integrations/gmail/poller.ts",
      "../../src/integrations/slack/poller.ts",
      "../../src/integrations/slack/realtime.ts",
      "../../src/polling/_archived-gdocs/gdocs.ts",
    ];

    for (const writer of writers) {
      const source = readFileSync(new URL(writer, import.meta.url), "utf8");
      expect(source, writer).not.toMatch(/\.update\(activityEvents\)|UPDATE\s+activity_events/iu);
    }
  });
});
