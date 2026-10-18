import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearProcessorsForTests,
  dispatchRecords,
  registerProcessor,
} from "../../../src/integrations/nango/types.js";
import {
  cursorConversationId,
  handleNangoSyncRecordsTask,
  MAX_NANGO_SYNC_PAGES,
} from "../../../src/integrations/nango/tasks.js";

describe("Nango record dispatch", () => {
  beforeEach(() => {
    clearProcessorsForTests();
  });

  it("routes records to the matching provider/model processor", async () => {
    const executor = { execute: vi.fn() };
    const seen: string[] = [];
    registerProcessor({
      provider: "bitbucket",
      model: "PullRequest",
      async process(_executor, record, ctx) {
        seen.push(`${ctx.tenantId}:${String(record.id)}`);
      },
    });

    await expect(dispatchRecords(executor, {
      provider: "bitbucket",
      model: "PullRequest",
      records: [{ id: "1" }, { id: "2" }],
      ctx: { tenantId: "tenant-1" },
    })).resolves.toEqual({ processed: 2, skipped: 0, matched: 2, generic: 0 });
    expect(seen).toEqual(["tenant-1:1", "tenant-1:2"]);
  });

  it("skips empty lists and unknown processor routes", async () => {
    const executor = { execute: vi.fn() };

    await expect(dispatchRecords(executor, {
      provider: "bitbucket",
      model: "PullRequest",
      records: [],
      ctx: { tenantId: "tenant-1" },
    })).resolves.toEqual({ processed: 0, skipped: 0, matched: 0, generic: 0 });
    await expect(dispatchRecords(executor, {
      provider: "bitbucket",
      model: "Commit",
      records: [{ id: "1" }],
      ctx: { tenantId: "tenant-1" },
    })).resolves.toEqual({ processed: 1, skipped: 1, matched: 0, generic: 1 });
  });
});

describe("Nango sync_records task", () => {
  beforeEach(() => {
    clearProcessorsForTests();
  });

  it("resumes from the stored cursor and persists the returned cursor", async () => {
    const executor = { execute: vi.fn() };
    executor.execute.mockResolvedValueOnce([{ last_seen_ts: "cursor-1" }]);
    executor.execute.mockResolvedValueOnce([]);
    registerProcessor({
      provider: "bitbucket",
      model: "Commit",
      async process() {},
    });
    const client = {
      listRecords: vi.fn()
        .mockResolvedValueOnce({ records: [{ id: "a" }], nextCursor: "cursor-2" })
        .mockResolvedValueOnce({ records: [{ id: "b" }], nextCursor: null }),
    };

    const result = await handleNangoSyncRecordsTask(executor, {
      tenantId: "tenant-1",
      provider: "bitbucket",
      providerConfigKey: "bitbucket",
      connectionId: "conn-1",
      model: "Commit",
    }, { client });

    expect(client.listRecords).toHaveBeenNthCalledWith(1, {
      providerConfigKey: "bitbucket",
      connectionId: "conn-1",
      model: "Commit",
      cursor: "cursor-1",
    });
    expect(client.listRecords).toHaveBeenNthCalledWith(2, {
      providerConfigKey: "bitbucket",
      connectionId: "conn-1",
      model: "Commit",
      cursor: "cursor-2",
    });
    expect(result).toMatchObject({ pages: 2, fetched: 2, processed: 2, skipped: 0, cursor: "cursor-2" });
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it("uses the payload cursor when no stored cursor exists", async () => {
    const executor = { execute: vi.fn() };
    executor.execute.mockResolvedValueOnce([]);
    const client = {
      listRecords: vi.fn().mockResolvedValueOnce({ records: [], nextCursor: null }),
    };

    await handleNangoSyncRecordsTask(executor, {
      tenantId: "tenant-1",
      provider: "bitbucket",
      providerConfigKey: "bitbucket",
      connectionId: "conn-1",
      model: "Commit",
      cursor: "webhook-cursor",
    }, { client });

    expect(client.listRecords).toHaveBeenCalledWith(expect.objectContaining({ cursor: "webhook-cursor" }));
  });

  it("keys cursor watermarks by connection and model", () => {
    expect(cursorConversationId({ connectionId: "conn-1", model: "Commit" })).toBe("conn-1:Commit");
  });

  it("breaks on non-advancing cursors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const executor = { execute: vi.fn() };
    executor.execute.mockResolvedValueOnce([{ last_seen_ts: "cursor-1" }]);
    registerProcessor({
      provider: "bitbucket",
      model: "Commit",
      async process() {},
    });
    const client = {
      listRecords: vi.fn().mockResolvedValueOnce({ records: [{ id: "a" }], nextCursor: "cursor-1" }),
    };

    const result = await handleNangoSyncRecordsTask(executor, {
      tenantId: "tenant-1",
      provider: "bitbucket",
      providerConfigKey: "bitbucket",
      connectionId: "conn-1",
      model: "Commit",
    }, { client });

    expect(client.listRecords).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pages: 1, fetched: 1, processed: 1, cursor: "cursor-1" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("non-advancing cursor"));
    warn.mockRestore();
  });

  it("fails when pagination exceeds the page cap", async () => {
    const executor = { execute: vi.fn() };
    executor.execute.mockResolvedValueOnce([]);
    executor.execute.mockResolvedValue([]);
    registerProcessor({
      provider: "bitbucket",
      model: "Commit",
      async process() {},
    });
    let page = 0;
    const client = {
      listRecords: vi.fn().mockImplementation(async () => {
        page += 1;
        return { records: [], nextCursor: `cursor-${page}` };
      }),
    };

    await expect(handleNangoSyncRecordsTask(executor, {
      tenantId: "tenant-1",
      provider: "bitbucket",
      providerConfigKey: "bitbucket",
      connectionId: "conn-1",
      model: "Commit",
    }, { client })).rejects.toThrow(`exceeded ${MAX_NANGO_SYNC_PAGES}`);
    expect(client.listRecords).toHaveBeenCalledTimes(MAX_NANGO_SYNC_PAGES);
  });
});
