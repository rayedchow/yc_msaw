import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as unknown[]));
const upsertConnectionMock = vi.hoisted(() => vi.fn());
const setConnectionStatusMock = vi.hoisted(() => vi.fn());
const startNangoPollingMock = vi.hoisted(() => vi.fn());
const enqueueCollectedEventMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "task-1"));
const createConnectSessionMock = vi.hoisted(() => vi.fn());
const deleteConnectionMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const ensureDefaultKbForTenantMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../../src/db/connections.js", () => ({
  upsertConnection: upsertConnectionMock,
  setConnectionStatus: setConnectionStatusMock,
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  startNangoPolling: startNangoPollingMock,
  enqueueCollectedEventForProcessing: enqueueCollectedEventMock,
}));

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/graph/wiring/default-kb.js", () => ({
  ensureDefaultKbForTenant: ensureDefaultKbForTenantMock,
}));

vi.mock("../../../src/integrations/nango/client.js", () => ({
  NangoClient: class {
    createConnectSession = createConnectSessionMock;
    deleteConnection = deleteConnectionMock;
    listConnections = listConnectionsMock;
    listRecords = vi.fn();
  },
  NangoRequestError: class NangoRequestError extends Error {},
}));

import { connectNangoProvider, disconnectNangoProvider } from "../../../src/integrations/nango/connect.js";
import { handleNangoPollTask, nangoSyncDedupeKey } from "../../../src/integrations/nango/tasks.js";
import { clearProcessorsForTests, registerProcessor, registeredModelsForProvider, type NangoExecutor } from "../../../src/integrations/nango/types.js";
import { registerAtlassianProcessors } from "../../../src/integrations/atlassian/processors.js";
import { registerBitbucketProcessors } from "../../../src/integrations/bitbucket/processors.js";
import { registerGithubProcessors } from "../../../src/integrations/github/processors.js";

describe("Nango polling floor", () => {
  beforeEach(() => {
    executeMock.mockReset().mockResolvedValue([]);
    upsertConnectionMock.mockReset().mockResolvedValue(undefined);
    setConnectionStatusMock.mockReset().mockResolvedValue(undefined);
    startNangoPollingMock.mockReset().mockResolvedValue(undefined);
    enqueueTaskMock.mockReset().mockResolvedValue("task-1");
    createConnectSessionMock.mockReset().mockResolvedValue({ sessionToken: "nango-session-token", connectLink: "https://connect.nango.dev/x" });
    deleteConnectionMock.mockReset().mockResolvedValue(undefined);
    listConnectionsMock.mockReset().mockResolvedValue([]);
    ensureDefaultKbForTenantMock.mockReset().mockResolvedValue({ kbId: "kb-1", attachedProviders: [] });
  });

  it("model enumeration covers every registered processor per Nango provider", () => {
    // Idempotent re-registration: replace-in-place keeps this stable even if
    // another test in this file touched the registry.
    registerAtlassianProcessors();
    registerGithubProcessors();
    registerBitbucketProcessors();

    // Rendered models + the generic live-verified sync models (raw-only).
    expect(registeredModelsForProvider("jira").sort()).toEqual(
      ["Field", "Issue", "IssueComment", "IssueType", "Project", "ProjectComponent", "ProjectVersion", "User"],
    );
    expect(registeredModelsForProvider("confluence").sort()).toEqual(
      ["Attachment", "BlogPost", "FooterComment", "InlineComment", "Page", "Space"],
    );
    expect(registeredModelsForProvider("github").sort()).toEqual(
      ["Commit", "GithubCommit", "GithubPullRequest", "Issue", "PullRequest", "Repository"],
    );
    expect(registeredModelsForProvider("bitbucket").sort()).toEqual(
      ["Branch", "Commit", "Pipeline", "PullRequest", "Repository", "Tag", "Workspace", "WorkspaceMember"],
    );

    // Every Nango-backed integration in src/integrations/registry.ts must
    // have a non-empty floor fan-out, or that provider gets NO data on the
    // lane without webhooks.
    for (const provider of ["jira", "confluence", "github", "bitbucket"]) {
      expect(registeredModelsForProvider(provider).length).toBeGreaterThan(0);
    }
  });

  it("starts the floor schedule when a Nango connect session is created", async () => {
    const result = await connectNangoProvider({ tenantId: "tenant-1", body: {} }, "jira");

    expect(result.status).toBe(200);
    expect(startNangoPollingMock).toHaveBeenCalledWith("tenant-1", "jira");
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-1");
  });

  it("does not start the floor schedule when connect-session creation fails", async () => {
    createConnectSessionMock.mockRejectedValue(new Error("NANGO_SECRET_KEY is not configured"));

    const result = await connectNangoProvider({ tenantId: "tenant-1", body: {} }, "jira");

    expect(result.status).toBe(503);
    expect(startNangoPollingMock).not.toHaveBeenCalled();
  });

  it("disables the floor schedule on disconnect", async () => {
    executeMock.mockImplementation(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("FROM connections")) {
        return [{ external_account_id: "conn-1", nango_connection_id: null, provider_config_key: "jira" }];
      }
      return [];
    });

    await disconnectNangoProvider({ tenantId: "tenant-1", provider: "jira" });

    expect(deleteConnectionMock).toHaveBeenCalledWith({ providerConfigKey: "jira", connectionId: "conn-1" });
    const scheduleUpdate = executeMock.mock.calls
      .map(([query]) => ({ text: sqlText(query), params: sqlParams(query) }))
      .find((call) => call.text.includes("UPDATE task_schedules"));
    expect(scheduleUpdate).toBeDefined();
    expect(scheduleUpdate?.params).toEqual(expect.arrayContaining(["tenant-1", "nango.poll", "tenant-1:nango:jira"]));
  });

  it("enqueues one stored-cursor sync per active connection x registered model with webhook-compatible dedupe keys", async () => {
    registerProcessor({ provider: "acme", model: "Ticket", process: vi.fn() });
    registerProcessor({ provider: "acme", model: "Comment", process: vi.fn() });
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("SELECT DISTINCT provider")) return [];
      if (text.includes("status = 'active'")) {
        return [
          { external_account_id: "conn-1", nango_connection_id: null, provider_config_key: "acme-key" },
          { external_account_id: null, nango_connection_id: null, provider_config_key: "acme-key" },
        ];
      }
      return [];
    });
    const executor = { execute } as unknown as NangoExecutor;

    const result = await handleNangoPollTask(executor, { tenantId: "tenant-1", provider: "acme" });

    expect(result).toEqual({ connections: 1, models: 2, enqueued: 2 });
    expect(enqueueTaskMock).toHaveBeenCalledTimes(2);
    for (const model of ["Ticket", "Comment"]) {
      const payload = {
        tenantId: "tenant-1",
        provider: "acme",
        providerConfigKey: "acme-key",
        connectionId: "conn-1",
        model,
      };
      expect(enqueueTaskMock).toHaveBeenCalledWith({
        queue: "sync",
        tenantId: "tenant-1",
        groupKey: "nango:tenant-1:acme:conn-1",
        kind: "nango.sync_records",
        payload,
        // Cursor-less floor payloads collapse with cursor-less webhook enqueues.
        dedupeKey: nangoSyncDedupeKey(payload),
      }, executor);
    }
    expect(nangoSyncDedupeKey({
      tenantId: "tenant-1",
      provider: "acme",
      providerConfigKey: "acme-key",
      connectionId: "conn-1",
      model: "Ticket",
    })).toBe("nango:sync_records:tenant-1:acme-key:acme:conn-1:Ticket:start");
  });

  it("runs pull reconcile before poll fan-out so pending Nango rows self-heal", async () => {
    // Single-model registry so the fan-out/enqueue counts below stay exact.
    clearProcessorsForTests();
    registerProcessor({ provider: "jira", model: "Issue", process: vi.fn() });
    const local = {
      status: "pending",
      externalAccountId: null as string | null,
      metadata: { providerConfigKey: "jira" } as Record<string, unknown>,
    };
    listConnectionsMock.mockResolvedValueOnce([{
      connectionId: "conn-1",
      providerConfigKey: "jira",
      endUserId: "tenant-1",
      raw: {},
    }]);
    enqueueTaskMock
      .mockResolvedValueOnce("initial-sync")
      .mockResolvedValueOnce(null);
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (text.includes("SELECT DISTINCT provider")) {
        const [tenantId, provider] = params as [string, string];
        return tenantId === "tenant-1"
          && provider === "jira"
          && (local.status === "pending" || local.status === "error")
          && local.externalAccountId === null
          ? [{ provider: "jira" }]
          : [];
      }
      if (text.includes("UPDATE connections") && text.includes("RETURNING id")) {
        const [connectionId, metadataJson, tenantId, provider] = params as [string, string, string, string];
        if (tenantId !== "tenant-1" || provider !== "jira" || local.status !== "pending") return [];
        local.status = "active";
        local.externalAccountId = connectionId;
        local.metadata = { ...local.metadata, ...(JSON.parse(metadataJson) as Record<string, unknown>) };
        return [{ id: "local-1" }];
      }
      if (text.includes("AND status = 'active'")) {
        return local.status === "active"
          ? [{ external_account_id: local.externalAccountId, nango_connection_id: null, provider_config_key: "jira" }]
          : [];
      }
      return [];
    });
    const executor = { execute } as unknown as NangoExecutor;

    const result = await handleNangoPollTask(executor, { tenantId: "tenant-1", provider: "jira" });

    expect(local).toEqual(expect.objectContaining({
      status: "active",
      externalAccountId: "conn-1",
      metadata: expect.objectContaining({ nangoConnectionId: "conn-1" }),
    }));
    expect(result).toEqual({ connections: 1, models: 1, enqueued: 0 });
    expect(startNangoPollingMock).toHaveBeenCalledWith("tenant-1", "jira");
    expect(enqueueTaskMock).toHaveBeenCalledTimes(2);
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(executor, "tenant-1");
  });

  it("enqueues nothing when a provider has no registered models", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const execute = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
    const executor = { execute } as unknown as NangoExecutor;

    const result = await handleNangoPollTask(executor, { tenantId: "tenant-1", provider: "unknown-provider" });

    expect(result).toEqual({ connections: 0, models: 0, enqueued: 0 });
    // A provider with no registered models is not a real Nango provider, so the
    // floor exits before reconcile — no DB hit, no fan-out.
    expect(execute).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown-provider"));
    warnSpy.mockRestore();
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
