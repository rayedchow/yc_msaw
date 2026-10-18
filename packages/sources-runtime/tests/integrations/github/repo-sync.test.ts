import { describe, expect, it, vi } from "vitest";

// The purge refreshes source-wiki indexes through the materializer, which
// talks to the real global db - stub just that; the path scheme stays real.
const materializeSourceWikiIndexesMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../../../src/mirror/materializer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/mirror/materializer.js")>();
  return { ...actual, materializeSourceWikiIndexes: materializeSourceWikiIndexesMock };
});

import {
  capturedGithubRepos,
  enabledGithubRepos,
  githubRepoSyncSelection,
  listGithubInstallationRepos,
  mergeGithubRepoLists,
  purgeGithubRepoData,
  reconcileGithubRepoSelection,
  setGithubRepoSyncing,
} from "../../../src/integrations/github/repo-sync.js";
import type { NangoExecutor } from "../../../src/integrations/nango/types.js";

function executorWith(rows: unknown[]): NangoExecutor & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(async (..._args: unknown[]) => rows) } as never;
}

describe("github repo sync selection", () => {
  it("upserts the selection row with tenant, repo, and syncing flag", async () => {
    const executor = executorWith([]);
    await setGithubRepoSyncing(executor, "tenant-1", "octo/hello", false);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const query = executor.execute.mock.calls[0]![0];
    const text = sqlText(query);
    expect(text).toContain("INSERT INTO github_repo_sync");
    expect(text).toContain("ON CONFLICT (tenant_id, repo_full_name)");
    expect(text).toContain("DO UPDATE SET syncing = EXCLUDED.syncing");
    expect(sqlParams(query)).toEqual(["tenant-1", "octo/hello", false]);
  });

  it("reads the selection map, defaulting missing syncing to true", async () => {
    const executor = executorWith([
      { repo_full_name: "octo/stopped", syncing: false },
      { repo_full_name: "octo/active", syncing: true },
      { repo_full_name: null, syncing: false },
    ]);
    const selection = await githubRepoSyncSelection(executor, "tenant-1");
    expect(selection.get("octo/stopped")).toBe(false);
    expect(selection.get("octo/active")).toBe(true);
    expect(selection.size).toBe(2);
  });

  it("returns only repos explicitly enabled (opt-in), sorted; stopped repos drop", async () => {
    const executor = executorWith([
      { repo_full_name: "octo/zeta", syncing: true },
      { repo_full_name: "octo/enabled", syncing: true },
      { repo_full_name: "octo/stopped", syncing: false },
    ]);
    expect(await enabledGithubRepos(executor, "tenant-1")).toEqual(["octo/enabled", "octo/zeta"]);
  });

  it("returns NO repos when the tenant has no selection rows (nothing enabled = sync nothing)", async () => {
    const executor = executorWith([]);
    expect(await enabledGithubRepos(executor, "tenant-1")).toEqual([]);
  });
});

describe("github installation repo listing", () => {
  it("pages /installation/repositories and returns fullName/id/private", async () => {
    const proxy = vi.fn(async (input: { params?: Record<string, unknown> }) => {
      if (input.params?.page === 1) {
        return {
          status: 200,
          data: { repositories: [{ full_name: "octo/hello", id: 42, private: true }] },
        };
      }
      return { status: 200, data: { repositories: [] } };
    });

    const repos = await listGithubInstallationRepos({ proxy } as never, {
      providerConfigKey: "github",
      connectionId: "conn-1",
    });
    expect(repos).toEqual([{ fullName: "octo/hello", id: 42, private: true }]);
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "/installation/repositories" }));
  });

  it("returns null (fail-soft) on an app-permission 403 instead of throwing", async () => {
    const proxy = vi.fn(async () => ({ status: 403, data: {} }));
    const repos = await listGithubInstallationRepos({ proxy } as never, {
      providerConfigKey: "github",
      connectionId: "conn-1",
    });
    expect(repos).toBeNull();
  });
});

describe("github repo list merge", () => {
  it("unions installation and captured repos; only explicitly enabled repos show as syncing", () => {
    const merged = mergeGithubRepoLists({
      installation: [
        { fullName: "octo/hello", id: 42, private: false },
        { fullName: "octo/private", id: 43, private: true },
      ],
      captured: [
        { fullName: "octo/hello", lastEventAt: "2026-07-01T00:00:00.000Z" },
        { fullName: "octo/legacy", lastEventAt: "2026-06-01T00:00:00.000Z" },
      ],
      selection: new Map([["octo/hello", true], ["octo/private", false]]),
    });

    expect(merged).toEqual([
      { fullName: "octo/hello", id: 42, private: false, syncing: true, lastEventAt: "2026-07-01T00:00:00.000Z" },
      { fullName: "octo/legacy", id: null, private: null, syncing: false, lastEventAt: "2026-06-01T00:00:00.000Z" },
      { fullName: "octo/private", id: 43, private: true, syncing: false, lastEventAt: null },
    ]);
  });

  it("defaults every repo to NOT syncing when the tenant has no selection rows", () => {
    const merged = mergeGithubRepoLists({
      installation: null,
      captured: [{ fullName: "octo/hello", lastEventAt: null }],
      selection: new Map(),
    });
    expect(merged).toEqual([
      { fullName: "octo/hello", id: null, private: null, syncing: false, lastEventAt: null },
    ]);
  });
});

describe("github repo purge on unsync", () => {
  function purgeExecutor(idRows: unknown[]): NangoExecutor & { execute: ReturnType<typeof vi.fn> } {
    return {
      execute: vi.fn(async (query: unknown) => (sqlText(query).includes("SELECT DISTINCT") ? idRows : [])),
    } as never;
  }

  it("deletes the repo's events, mirror files, and cursors, all scoped to tenant + repo", async () => {
    materializeSourceWikiIndexesMock.mockClear();
    const executor = purgeExecutor([{ repo_id: "42" }]);
    await purgeGithubRepoData(executor, "tenant-1", "octo/hello");

    const calls = executor.execute.mock.calls.map(([query]) => ({ text: sqlText(query), params: sqlParams(query) }));
    expect(calls).toHaveLength(5);

    // Repo-id lookup happens first (before its source rows are deleted).
    expect(calls[0]!.text).toContain("SELECT DISTINCT");
    expect(calls[0]!.params).toEqual(["tenant-1", "octo/hello"]);

    const mirrorSelection = calls[1]!;
    expect(mirrorSelection.text).toContain("SELECT path");
    expect(mirrorSelection.text).toContain("FROM mirror_files");
    expect(mirrorSelection.params).toEqual(["tenant-1", "sources/github/octo/hello/"]);

    const events = calls[2]!;
    expect(events.text).toContain("DELETE FROM activity_events");
    expect(events.text).toContain("user_id =");
    expect(events.text).toContain("source = 'github'");
    expect(events.params[0]).toBe("tenant-1");
    // Payload-shape matches: full name, api urls, and web urls for THIS repo.
    expect(events.params).toContain("octo/hello");
    expect(events.params).toContain("https://api.github.com/repos/octo/hello");
    expect(events.params).toContain("https://api.github.com/repos/octo/hello/");
    expect(events.params).toContain("https://github.com/octo/hello/");
    // Key prefixes cover the full-name AND numeric-repo-id key forms.
    expect(events.params).toContain("github:issue:octo/hello:");
    expect(events.params).toContain("github:commit:42:");
    expect(events.params).toContain("github:repo:42:");
    expect(events.params).toContain("nango:github:pull_request_detail:octo/hello#");

    const mirror = calls[3]!;
    expect(mirror.text).toContain("DELETE FROM mirror_files");
    expect(mirror.params).toEqual(["tenant-1", "sources/github/octo/hello/"]);
    expect(materializeSourceWikiIndexesMock).toHaveBeenCalledWith("tenant-1");

    const cursors = calls[4]!;
    expect(cursors.text).toContain("DELETE FROM conversation_watermarks");
    expect(cursors.text).toContain("provider = 'github'");
    expect(cursors.params).toEqual([
      "tenant-1",
      "issues:octo/hello",
      "issue_comments:octo/hello",
      "pr_review_comments:octo/hello",
    ]);
  });

  it("never references another repo in any delete parameter", async () => {
    const executor = purgeExecutor([{ repo_id: "42" }]);
    await purgeGithubRepoData(executor, "tenant-1", "octo/hello");
    for (const [query] of executor.execute.mock.calls) {
      for (const param of sqlParams(query)) {
        if (typeof param !== "string" || param === "tenant-1") continue;
        expect(param).toMatch(/octo\/hello|github:(issue|pr|commit|repo):42:/u);
      }
    }
  });

  it("is idempotent: a second run with nothing captured still issues scoped deletes", async () => {
    const executor = purgeExecutor([]);
    await purgeGithubRepoData(executor, "tenant-1", "octo/hello");
    const texts = executor.execute.mock.calls.map(([query]) => sqlText(query));
    expect(texts.filter((text) => text.includes("DELETE FROM"))).toHaveLength(3);
  });
});

describe("github repo selection reconcile", () => {
  function reconcileExecutor(input: {
    eventRepos?: string[];
    mirrorRepos?: Array<{ owner: string; repo: string }>;
    selection?: Array<{ repo_full_name: string; syncing: boolean }>;
    failEnumeration?: boolean;
  }): NangoExecutor & { execute: ReturnType<typeof vi.fn> } {
    return {
      execute: vi.fn(async (query: unknown) => {
        const text = sqlText(query);
        // Captured-repo enumeration (repository events, GROUP BY full name).
        if (text.includes("GROUP BY")) {
          if (input.failEnumeration) throw new Error("enumeration unavailable");
          return (input.eventRepos ?? []).map((full_name) => ({ full_name, last_event_at: null }));
        }
        // Mirror-directory enumeration.
        if (text.includes("FROM mirror_files") && text.includes("split_part")) {
          return input.mirrorRepos ?? [];
        }
        if (text.includes("FROM github_repo_sync")) return input.selection ?? [];
        return [];
      }),
    } as never;
  }

  function deleteCalls(executor: { execute: ReturnType<typeof vi.fn> }): Array<{ text: string; params: unknown[] }> {
    return executor.execute.mock.calls
      .map(([query]) => ({ text: sqlText(query), params: sqlParams(query) }))
      .filter((call) => call.text.includes("DELETE FROM"));
  }

  it("tombstones repos missing from the enabled set without deleting raw history; keeps enabled", async () => {
    const executor = reconcileExecutor({
      eventRepos: ["octo/keep", "octo/stale"],
      mirrorRepos: [{ owner: "octo", repo: "filesonly" }],
      selection: [{ repo_full_name: "octo/keep", syncing: true }],
    });
    const result = await reconcileGithubRepoSelection(executor, "tenant-1");

    expect(result.tombstoned.sort()).toEqual(["octo/filesonly", "octo/stale"]);
    expect(result.keptEnabled).toEqual(["octo/keep"]);

    const tombstones = executor.execute.mock.calls
      .map(([query]) => ({ text: sqlText(query), params: sqlParams(query) }))
      .filter((call) => call.text.includes("INSERT INTO activity_events"));
    expect(tombstones).toHaveLength(2);
    for (const repo of ["octo/stale", "octo/filesonly"]) {
      const tombstone = tombstones.find((call) => call.params.some((param) => typeof param === "string" && param.includes(repo)));
      expect(tombstone?.text).toContain("'tombstone'");
      expect(tombstone?.text).toContain("'repository.moved_out_of_scope'");
      expect(tombstone?.params).toContain(`github:repo_scope:${repo}:moved_out_of_scope`);
    }

    const deletes = deleteCalls(executor);
    // Scope exit removes only derived files/cursors. The immutable raw ledger
    // is retained and represented by the tombstone above.
    expect(deletes.some((c) => c.text.includes("activity_events"))).toBe(false);
    for (const repo of ["octo/stale", "octo/filesonly"]) {
      expect(deletes.some((c) => c.text.includes("mirror_files") && c.params.includes(`sources/github/${repo}/`))).toBe(true);
      expect(deletes.some((c) => c.text.includes("conversation_watermarks") && c.params.includes(`issues:${repo}`))).toBe(true);
    }
    // The enabled repo is never referenced by any delete parameter.
    for (const call of deletes) {
      for (const param of call.params) {
        if (typeof param === "string") expect(param).not.toContain("octo/keep");
      }
    }
    // Every delete stays tenant-scoped.
    for (const call of deletes) expect(call.params).toContain("tenant-1");
  });

  it("keeps an enabled repo whose captured casing differs (GitHub names are case-insensitive)", async () => {
    const executor = reconcileExecutor({
      eventRepos: ["askShepherd/Aqueduct"],
      selection: [{ repo_full_name: "askshepherd/aqueduct", syncing: true }],
    });
    const result = await reconcileGithubRepoSelection(executor, "tenant-1");

    expect(result.tombstoned).toEqual([]);
    expect(result.keptEnabled).toEqual(["askShepherd/Aqueduct"]);
    expect(deleteCalls(executor)).toHaveLength(0);
  });

  it("tombstones ALL captured repos when nothing is enabled", async () => {
    const executor = reconcileExecutor({
      eventRepos: ["octo/a", "octo/b"],
      selection: [{ repo_full_name: "octo/b", syncing: false }],
    });
    const result = await reconcileGithubRepoSelection(executor, "tenant-1");
    expect(result.tombstoned.sort()).toEqual(["octo/a", "octo/b"]);
    expect(result.keptEnabled).toEqual([]);
    expect(deleteCalls(executor).some((call) => call.text.includes("activity_events"))).toBe(false);
  });

  it("no-ops when nothing is captured", async () => {
    const executor = reconcileExecutor({ selection: [{ repo_full_name: "octo/new", syncing: true }] });
    const result = await reconcileGithubRepoSelection(executor, "tenant-1");
    expect(result).toEqual({ tombstoned: [], keptEnabled: [] });
    expect(deleteCalls(executor)).toHaveLength(0);
  });

  it("writes NOTHING when enumeration fails (fail-soft, never tombstone on incomplete info)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const executor = reconcileExecutor({ eventRepos: ["octo/stale"], failEnumeration: true });
    const result = await reconcileGithubRepoSelection(executor, "tenant-1");
    expect(result).toEqual({ tombstoned: [], keptEnabled: [] });
    expect(deleteCalls(executor)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a mirror-derived repo whose sanitized directory belongs to an enabled repo", async () => {
    // Enabled name "octo/he llo" materializes under sources/github/octo/he-llo;
    // the dir parses back as "octo/he-llo" and must NOT be purged.
    const executor = reconcileExecutor({
      mirrorRepos: [{ owner: "octo", repo: "he-llo" }],
      selection: [{ repo_full_name: "octo/he llo", syncing: true }],
    });
    const result = await reconcileGithubRepoSelection(executor, "tenant-1");
    expect(result.tombstoned).toEqual([]);
    expect(result.keptEnabled).toEqual(["octo/he-llo"]);
    expect(deleteCalls(executor)).toHaveLength(0);
  });
});

describe("captured github repos", () => {
  it("maps captured repository events to fullName + lastEventAt and drops malformed names", async () => {
    const executor = executorWith([
      { full_name: "octo/hello", last_event_at: new Date("2026-07-01T00:00:00.000Z") },
      { full_name: "not-a-repo", last_event_at: null },
      { full_name: null, last_event_at: null },
    ]);
    const repos = await capturedGithubRepos(executor, "tenant-1");
    expect(repos).toEqual([{ fullName: "octo/hello", lastEventAt: "2026-07-01T00:00:00.000Z" }]);
    expect(sqlParams(executor.execute.mock.calls[0]![0])).toEqual(["tenant-1"]);
  });
});

function sqlText(value: unknown): string {
  return sqlParts(value).join(" ");
}

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function sqlParams(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return [chunk];
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk);
    if (Array.isArray(chunk.value)) return [];
    if ("value" in chunk) return [chunk.value];
    return [];
  });
}
