import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

import { buildGenericNangoEventValues, processGenericNangoRecord } from "../../../src/integrations/nango/capture.js";
import { clearProcessorsForTests, dispatchRecords } from "../../../src/integrations/nango/types.js";

describe("Nango generic capture", () => {
  const executor = { execute: vi.fn() };

  beforeEach(() => {
    executor.execute.mockReset().mockResolvedValue([{ id: "event-1" }]);
    enqueueCollectedEventMock.mockReset().mockResolvedValue(undefined);
    clearProcessorsForTests();
  });

  it("captures an unknown model instead of silently skipping it", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await dispatchRecords(executor, {
      provider: "jira",
      model: "Sprint",
      records: [{
        id: "sprint-1",
        name: "Launch Sprint",
        ownerEmail: "owner@example.com",
        _nango_metadata: { updated_at: "2026-07-01T10:00:00.000Z" },
      }],
      ctx: { tenantId: "tenant-1" },
      registry: [],
    });

    expect(result).toEqual({ processed: 1, skipped: 0, matched: 0, generic: 1 });
    const insert = executor.execute.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    expect(insert).toBeTruthy();
    expect(sqlParts(insert![0]).join(" ")).toContain("source_namespace");
    expect(sqlParts(insert![0]).join(" ")).toContain("source_object_id");
    expect(sqlParts(insert![0]).join(" ")).toContain("record_kind");
    const params = sqlParams(insert![0]);
    expect(params).toContain("tenant-1");
    expect(params).toContain("jira");
    expect(params).toContain("sprint");
    expect(params).toContain("nango:jira:sprint:sprint-1:2026-07-01T10:00:00.000Z");
    expect(params).toContain(JSON.stringify([{ type: "email_contact", id: "owner@example.com", email: "owner@example.com" }]));
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-1", "tenant-1", "jira");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("generic=1"));
    logSpy.mockRestore();
  });

  it("stores deleted records as tombstone events", async () => {
    await processGenericNangoRecord(executor, {
      tenantId: "tenant-1",
      provider: "confluence",
      model: "Page",
      record: {
        id: "page-1",
        _nango_metadata: {
          last_action: "DELETED",
          updated_at: "2026-07-02T00:00:00.000Z",
        },
      },
    });

    const insert = executor.execute.mock.calls.find((call) =>
      sqlParts(call[0]).join(" ").includes("INSERT INTO activity_events")
    );
    const params = sqlParams(insert![0]);
    expect(params).toContain("page.deleted");
    expect(params).toContain("nango:confluence:page:page-1:2026-07-02T00:00:00.000Z");
    expect(enqueueCollectedEventMock).toHaveBeenCalledWith("event-1", "tenant-1", "confluence");
  });

  it("fails closed on ambiguous object scope while retaining an explicit record kind", () => {
    const values = buildGenericNangoEventValues({
      tenantId: "tenant-1",
      provider: "jira",
      model: "Issue",
      record: { id: "10042", key: "ENG-42" },
    });

    expect(values).toMatchObject({
      source: "jira",
      sourceNamespace: null,
      sourceObjectId: null,
      recordKind: "snapshot",
    });
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
