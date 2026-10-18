import { describe, expect, it } from "vitest";
import {
  hasCalcomAlias,
  parseArgs,
  runCalcomAliasBackfill,
  type BackfillExecutor,
} from "../../scripts/backfill-calcom-aliases.js";

const CALCOM_UID = "wLDVU78KVvby7vf6C6ivh9";

function candidateRow(overrides: Partial<{
  id: string;
  tenant_id: string;
  aliases: unknown;
  content: string;
}> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    tenant_id: "org_01KWZZDFNEVJ9JRJPAFMG2FDEQ",
    aliases: [{ kind: "gcal_event", value: "_c9gm4cj3evt" }],
    content: `# 15 Min Meeting\n\n- Meet/URL: https://cal.com/video/${CALCOM_UID}\n`,
    ...overrides,
  };
}

class FakeDb implements BackfillExecutor {
  updates: Array<{ text: string; values: unknown[] }> = [];
  selects = 0;

  constructor(private readonly rows: unknown[]) {}

  async execute(query: unknown): Promise<unknown> {
    const text = sqlText(query);
    if (text.includes("SELECT") && text.includes("FROM source_documents document")) {
      this.selects += 1;
      return this.rows;
    }
    if (text.includes("UPDATE source_documents")) {
      this.updates.push({ text, values: sqlValues(query) });
      return [];
    }
    return [];
  }
}

describe("backfill-calcom-aliases", () => {
  it("dry-run counts planned rows without writing", async () => {
    const db = new FakeDb([candidateRow()]);
    const report = await runCalcomAliasBackfill(db, { apply: false });
    expect(report).toMatchObject({ candidates: 1, planned: 1, updated: 0 });
    expect(db.updates).toHaveLength(0);
  });

  it("apply appends exactly the calcom_booking alias, guarded against re-adding", async () => {
    const db = new FakeDb([candidateRow()]);
    const report = await runCalcomAliasBackfill(db, { apply: true });
    expect(report).toMatchObject({ candidates: 1, planned: 1, updated: 1 });
    expect(db.updates).toHaveLength(1);
    const update = db.updates[0];
    expect(update.values).toContain(JSON.stringify([{ kind: "calcom_booking", value: CALCOM_UID }]));
    // Idempotency guard lives in the statement itself.
    expect(update.text).toContain("NOT (COALESCE(aliases, '[]'::jsonb) @>");
  });

  it("skips rows already aliased and rows whose cal.com link is not a booking URL", async () => {
    const db = new FakeDb([
      candidateRow({
        id: "00000000-0000-4000-8000-000000000011",
        aliases: [{ kind: "calcom_booking", value: CALCOM_UID }],
      }),
      candidateRow({
        id: "00000000-0000-4000-8000-000000000012",
        content: "book me at https://cal.com/ishan/15min",
      }),
      candidateRow({
        id: "00000000-0000-4000-8000-000000000013",
        content: "short uid https://cal.com/video/abc1234",
      }),
    ]);
    const report = await runCalcomAliasBackfill(db, { apply: true });
    expect(report).toMatchObject({ candidates: 3, planned: 0, updated: 0 });
    expect(report.skippedByReason.get("alias_already_present")).toBe(1);
    expect(report.skippedByReason.get("no_booking_url_match")).toBe(2);
    expect(db.updates).toHaveLength(0);
  });

  it("detects existing aliases in array and json-string shapes", () => {
    expect(hasCalcomAlias([{ kind: "calcom_booking", value: CALCOM_UID }])).toBe(true);
    expect(hasCalcomAlias(JSON.stringify([{ kind: "calcom_booking", value: CALCOM_UID }]))).toBe(true);
    expect(hasCalcomAlias([{ kind: "gcal_event", value: "x" }])).toBe(false);
    expect(hasCalcomAlias(null)).toBe(false);
  });

  it("parses --apply and --tenant flags", () => {
    expect(parseArgs([])).toEqual({ apply: false, tenantId: null });
    expect(parseArgs(["--apply", "--tenant", "org_01KWZZDFNEVJ9JRJPAFMG2FDEQ"]))
      .toEqual({ apply: true, tenantId: "org_01KWZZDFNEVJ9JRJPAFMG2FDEQ" });
    expect(() => parseArgs(["--tenant"])).toThrow("--tenant requires a tenant id");
  });
});

function sqlText(value: any): string {
  if (!value || !Array.isArray(value.queryChunks)) return "";
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return [sqlText(chunk)];
    return [];
  }).join(" ");
}

function sqlValues(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return [];
    if (Array.isArray(chunk?.queryChunks)) return sqlValues(chunk);
    return [chunk];
  });
}
