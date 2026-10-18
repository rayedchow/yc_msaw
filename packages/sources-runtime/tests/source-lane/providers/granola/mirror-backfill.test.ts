import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { connectGranola, mirror, query, ready, resetAll, tokens } from "./harness.js";
import { FakeGranola, note } from "./fake-granola.js";
import { runGranolaSourceBackfill, runGranolaSourcePoll } from "../../../../src/source-lane/providers/granola/lane.js";
import { granolaNoteDirectory } from "../../../../src/source-lane/providers/granola/export-map.js";
import { backfillSourceWikiMirror } from "../../../../src/mirror/backfill.js";
import { granolaCoverage } from "../../../../src/source-lane/providers/granola/coverage.js";
import { db } from "./harness.js";

/**
 * Regression for patch request granola #1 (src/mirror/backfill.ts is shared; the coordinator applies
 * the hunk). The donor `mirror.backfill` re-rendered EVERY Granola raw row (all revisions, in random
 * uuid order, concurrently) and ignored tombstones, so a backfill could leave an older revision as
 * the projection and resurrect deleted meetings.
 */

const T = "tenant-granola-backfill";
const KEY = "grn_synthetic_backfill_key";
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
});

describe("mirror.backfill renders only the current state of each Granola note", () => {
  it("renders the latest revision, never resurrects a deleted note, and keeps restored notes", async () => {
    const fake = new FakeGranola();
    fake.account(KEY);
    for (const id of ["keep", "gone"]) fake.put(KEY, note(id, ago(10)));
    vi.stubGlobal("fetch", fake.fetch);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(5) });
    await runGranolaSourceBackfill(T);
    await runGranolaSourcePoll(T);
    // Several revisions of `keep` (latest has the newest summary).
    for (let i = 1; i <= 4; i++) {
      fake.notes.set("keep", { ...fake.notes.get("keep")!, updated_at: ago(4 - i * 0.5), summary_markdown: `## v${i}` });
      await runGranolaSourcePoll(T);
    }
    // `gone` is deleted (sweep due), tombstoned and removed from the mirror.
    tokens.get(`${T}:granola`)!.metadata!.granolaDeletionSweepAt = new Date(Date.now() - 7 * 3600_000).toISOString();
    fake.delete("gone");
    await runGranolaSourcePoll(T);
    const goneDir = granolaNoteDirectory("gone", "Meeting gone");
    const keepDir = granolaNoteDirectory("keep", "Meeting keep");
    expect([...(await mirror(T)).keys()].some((p) => p.startsWith(goneDir))).toBe(false);

    await query(`DELETE FROM mirror_files WHERE user_id = $1`, [T]);
    await backfillSourceWikiMirror({ userId: T, limitPerSource: null, sources: ["granola"] } as never);

    const files = await mirror(T);
    expect(files.get(`${keepDir}/summary.md`)).toContain("## v4");
    expect([...files.keys()].some((p) => p.startsWith(goneDir))).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("Granola fidelity (granola-fidelity-findings L1/L3)", () => {
  it("renders the user's typed notes next to the AI summary, also for a note that has nothing else", async () => {
    const fake = new FakeGranola();
    fake.account(KEY);
    fake.put(KEY, note("typed", ago(10), { notes_markdown: "- my own typed line", summary_markdown: "AI summary text" } as never));
    fake.put(KEY, note("only-notes", ago(9), { notes_markdown: "- typed notes only", summary_markdown: null, summary_text: null, transcript: null } as never));
    vi.stubGlobal("fetch", fake.fetch);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(5) });
    await runGranolaSourceBackfill(T);
    await query(`DELETE FROM mirror_files WHERE user_id = $1`, [T]);
    await backfillSourceWikiMirror({ userId: T, limitPerSource: null, sources: ["granola"] } as never);
    const files = await mirror(T);
    const typed = files.get(`${granolaNoteDirectory("typed", "Meeting typed")}/summary.md`)!;
    expect(typed).toContain("AI summary text");
    expect(typed).toContain("## My notes\n\n- my own typed line");
    expect(files.get(`${granolaNoteDirectory("only-notes", "Meeting only-notes")}/summary.md`)).toContain("- typed notes only");
    vi.unstubAllGlobals();
  });

  it("never reports the OAuth/MCP transport as complete", async () => {
    const fake = new FakeGranola();
    fake.account(KEY);
    fake.put(KEY, note("n1", ago(10)));
    vi.stubGlobal("fetch", fake.fetch);
    await connectGranola(T, KEY, { lastUpdatedAt: ago(5) });
    await runGranolaSourceBackfill(T);
    await runGranolaSourcePoll(T);
    const apiKey = await granolaCoverage({ tenantId: T, executor: db as never });
    await query(`UPDATE granola_source_state SET auth_mode = 'oauth_mcp' WHERE tenant_id = $1`, [T]);
    const oauth = await granolaCoverage({ tenantId: T, executor: db as never });
    const account = (r: Array<{ scope: string; state: string; reason?: string }>) => r.find((c) => c.scope.startsWith("account:"))!;
    expect(account(apiKey).state, JSON.stringify(apiKey)).toBe("complete");
    expect(account(oauth).state).toBe("partial");
    expect(account(oauth).reason).toContain("Granola OAuth/MCP");
    vi.unstubAllGlobals();
  });
});
