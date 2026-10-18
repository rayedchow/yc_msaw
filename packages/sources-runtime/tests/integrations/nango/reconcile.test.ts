import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startNangoPollingMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn(async () => "task-1"));
const ensureDefaultKbForTenantMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/queue/dispatch.js", () => ({
  startNangoPolling: startNangoPollingMock,
}));

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/graph/wiring/default-kb.js", () => ({
  ensureDefaultKbForTenant: ensureDefaultKbForTenantMock,
}));

import { reconcileNangoConnectionsForTenant } from "../../../src/integrations/nango/reconcile.js";
import { clearProcessorsForTests, registerProcessor, type NangoExecutor } from "../../../src/integrations/nango/types.js";

type LocalConnection = {
  id: string;
  tenant_id: string;
  provider: string;
  status: string;
  external_account_id: string | null;
  metadata: Record<string, unknown>;
};

describe("reconcileNangoConnectionsForTenant", () => {
  beforeEach(() => {
    clearProcessorsForTests();
    registerProcessor({ provider: "jira", model: "Issue", process: vi.fn() });
    startNangoPollingMock.mockReset().mockResolvedValue(undefined);
    enqueueTaskMock.mockReset().mockResolvedValue("task-1");
    ensureDefaultKbForTenantMock.mockReset().mockResolvedValue({ kbId: "kb-1", attachedProviders: ["jira"] });
  });

  afterEach(() => {
    clearProcessorsForTests();
  });

  it("promotes a matching pending local row to active and starts the initial sync fan-out", async () => {
    const rows: LocalConnection[] = [{
      id: "local-1",
      tenant_id: "tenant-1",
      provider: "jira",
      status: "pending",
      external_account_id: null,
      metadata: { authMode: "nango", providerConfigKey: "jira" },
    }];
    const executor = executorForConnections(rows);
    const client = {
      listConnections: vi.fn(async () => [{
        connectionId: "nango-conn-1",
        providerConfigKey: "jira",
        endUserId: "tenant-1",
        raw: {},
      }]),
    };

    const result = await reconcileNangoConnectionsForTenant(executor, "tenant-1", "jira", { client });

    expect(result).toEqual(expect.objectContaining({ matched: 1, promoted: 1, enqueued: 1 }));
    expect(rows[0]).toEqual(expect.objectContaining({
      status: "active",
      external_account_id: "nango-conn-1",
      metadata: expect.objectContaining({ nangoConnectionId: "nango-conn-1" }),
    }));
    expect(startNangoPollingMock).toHaveBeenCalledWith("tenant-1", "jira");
    expect(enqueueTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      queue: "sync",
      tenantId: "tenant-1",
      groupKey: "nango:tenant-1:jira:nango-conn-1",
      kind: "nango.sync_records",
      payload: expect.objectContaining({
        tenantId: "tenant-1",
        provider: "jira",
        providerConfigKey: "jira",
        connectionId: "nango-conn-1",
        model: "Issue",
      }),
    }), executor);
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(executor, "tenant-1");
  });

  it("does nothing when Nango has no tenant/provider match", async () => {
    const rows: LocalConnection[] = [{
      id: "local-1",
      tenant_id: "tenant-1",
      provider: "jira",
      status: "pending",
      external_account_id: null,
      metadata: { authMode: "nango", providerConfigKey: "jira" },
    }];
    const executor = executorForConnections(rows);
    const client = {
      listConnections: vi.fn(async () => [{
        connectionId: "nango-conn-1",
        providerConfigKey: "jira",
        endUserId: "other-tenant",
        raw: {},
      }]),
    };

    const result = await reconcileNangoConnectionsForTenant(executor, "tenant-1", "jira", { client });

    expect(result).toEqual(expect.objectContaining({ matched: 0, promoted: 0, enqueued: 0 }));
    expect(rows[0]).toEqual(expect.objectContaining({ status: "pending", external_account_id: null }));
    expect(startNangoPollingMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });
});

function executorForConnections(rows: LocalConnection[]): NangoExecutor {
  return {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      const params = sqlParams(query);

      if (text.includes("SELECT DISTINCT provider") && text.includes("FROM connections")) {
        const [tenantId, provider] = params as [string, string];
        return rows
          .filter((row) =>
            row.tenant_id === tenantId
            && row.provider === provider
            && (row.status === "pending" || row.status === "error")
            && row.external_account_id === null
          )
          .map((row) => ({ provider: row.provider }));
      }

      if (text.includes("UPDATE connections") && text.includes("RETURNING id")) {
        const [connectionId, metadataJson, tenantId, provider] = params as [string, string, string, string];
        const matched = rows.find((row) =>
          row.tenant_id === tenantId
          && row.provider === provider
          && (row.status === "pending" || row.status === "error")
          && row.external_account_id === null
        );
        if (!matched) return [];
        matched.status = "active";
        matched.external_account_id = connectionId;
        matched.metadata = { ...matched.metadata, ...(JSON.parse(metadataJson) as Record<string, unknown>) };
        return [{ id: matched.id }];
      }

      return [];
    }),
  } as unknown as NangoExecutor;
}

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
