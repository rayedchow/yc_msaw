import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

import { processBitbucketPullRequestRecord, registerBitbucketProcessors } from "../../../src/integrations/bitbucket/processors.js";
import { clearProcessorsForTests, dispatchRecords } from "../../../src/integrations/nango/types.js";

describe("Bitbucket Nango processors", () => {
  const executor = { execute: executeMock };

  beforeEach(() => {
    executeMock.mockReset().mockResolvedValue([{ id: "event-1" }]);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    clearProcessorsForTests();
  });

  it("captures a PullRequest row and materializes its mirror markdown", async () => {
    await processBitbucketPullRequestRecord(executor, {
      id: 7,
      title: "Ship OAuth flow",
      state: "OPEN",
      description: "Adds the Nango connect screen.",
      author: { display_name: "Avery Author", email: "avery@example.com" },
      destination: { repository: { full_name: "team/workspace-api" } },
      updated_on: "2026-07-04T12:00:00.000Z",
    }, { tenantId: "tenant-1", connectionId: "bb-connection" });

    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    expect(sqlParams(activityInsert![0])).toContain("pull_request");
    expect(sqlParams(activityInsert![0])).toContain("bitbucket:pr:team/workspace-api:7:2026-07-04T12:00:00.000Z");
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-1", "tenant-1", "bitbucket");

    const mirrorInsert = executeMock.mock.calls.find((call) => {
      const parts = sqlParts(call[0]).join(" ");
      return parts.includes("INSERT INTO mirror_files") && sqlParams(call[0]).includes("sources/bitbucket/team/workspace-api/pr-7.md");
    });
    expect(mirrorInsert).toBeTruthy();
    const content = sqlParams(mirrorInsert![0]).find((param): param is string =>
      typeof param === "string" && param.includes("# Ship OAuth flow")
    );
    expect(content).toContain("State: OPEN");
    expect(content).toContain("Avery Author <avery@example.com>");
    expect(content).toContain("Adds the Nango connect screen.");
  });

  it("captures registered raw-only Bitbucket models (Branch) with snake_case event types", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerBitbucketProcessors();

    const result = await dispatchRecords(executor, {
      provider: "bitbucket",
      model: "Branch",
      records: [{ id: "main", name: "main", updated_on: "2026-07-05T00:00:00.000Z" }],
      ctx: { tenantId: "tenant-1" },
    });

    expect(result).toEqual({ processed: 1, skipped: 0, matched: 1, generic: 0 });
    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    const params = sqlParams(activityInsert![0]);
    expect(params).toContain("branch");
    expect(params.some((param) => typeof param === "string" && param.startsWith("nango:bitbucket:branch:main:sha256-"))).toBe(true);
    logSpy.mockRestore();
  });

  it("lets unknown Bitbucket models fall back to generic capture", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerBitbucketProcessors();

    const result = await dispatchRecords(executor, {
      provider: "bitbucket",
      model: "Mystery",
      records: [{ id: "m-1", name: "mystery", updated_on: "2026-07-05T00:00:00.000Z" }],
      ctx: { tenantId: "tenant-1" },
    });

    expect(result).toEqual({ processed: 1, skipped: 0, matched: 0, generic: 1 });
    const activityInsert = executeMock.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    const params = sqlParams(activityInsert![0]);
    expect(params).toContain("mystery");
    expect(params.some((param) => typeof param === "string" && param.startsWith("nango:bitbucket:mystery:m-1:sha256-"))).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("generic=1"));
    logSpy.mockRestore();
  });
});

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
