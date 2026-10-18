import { beforeEach, describe, expect, it, vi } from "vitest";

const notionApiWithTokenMock = vi.hoisted(() => vi.fn());
const storeTokenMock = vi.hoisted(() => vi.fn());
const upsertConnectionMock = vi.hoisted(() => vi.fn());
const startNotionPollingMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn());
const ensureDefaultKbForTenantMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/integrations/notion/client.js", () => ({
  notionApiWithToken: notionApiWithTokenMock,
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  storeToken: storeTokenMock,
}));

vi.mock("../../../src/db/connections.js", () => ({
  upsertConnection: upsertConnectionMock,
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  startNotionPolling: startNotionPollingMock,
}));

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/graph/wiring/default-kb.js", () => ({
  ensureDefaultKbForTenant: ensureDefaultKbForTenantMock,
}));

import { connectNotionWithOAuthToken, connectNotionWithToken } from "../../../src/integrations/notion/connect.js";

describe("Notion connect", () => {
  beforeEach(() => {
    notionApiWithTokenMock.mockReset().mockResolvedValue({
      id: "bot-1",
      name: "Shepherd",
      bot: { workspace_id: "workspace-1", workspace_name: "Acme" },
    });
    storeTokenMock.mockReset().mockResolvedValue(undefined);
    upsertConnectionMock.mockReset().mockResolvedValue(undefined);
    startNotionPollingMock.mockReset().mockResolvedValue(undefined);
    enqueueTaskMock.mockReset().mockResolvedValue("task-1");
    ensureDefaultKbForTenantMock.mockReset().mockResolvedValue({ kbId: "kb-1", attachedProviders: ["notion"] });
  });

  it("writes a connection row and schedules ingestion for manual token connects", async () => {
    const result = await connectNotionWithToken("tenant-1", " secret-token ");

    expect(result).toEqual({
      success: true,
      botId: "bot-1",
      workspaceId: "workspace-1",
      workspaceName: "Acme",
    });
    expect(notionApiWithTokenMock).toHaveBeenCalledWith("secret-token", "/users/me");
    expect(storeTokenMock).toHaveBeenCalledWith("tenant-1", "notion", "secret-token", expect.objectContaining({
      auth_mode: "manual_token",
      botId: "bot-1",
      workspaceId: "workspace-1",
      workspaceName: "Acme",
    }));
    expect(upsertConnectionMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      provider: "notion",
      externalAccountId: "workspace-1",
      status: "active",
      metadata: { authMode: "manual_token" },
    });
    expect(startNotionPollingMock).toHaveBeenCalledWith("tenant-1");
    expect(enqueueTaskMock).toHaveBeenCalledWith({
      queue: "backfill",
      tenantId: "tenant-1",
      kind: "notion.backfill",
      payload: { userId: "tenant-1", days: null, maxPages: null },
      groupKey: "tenant-1:notion",
      dedupeKey: "tenant-1:notion:backfill:initial",
    });
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-1");
  });

  it("writes a connection row for OAuth completion", async () => {
    const result = await connectNotionWithOAuthToken("tenant-1", {
      access_token: "oauth-token",
      refresh_token: "refresh-token",
      workspace_id: "workspace-1",
      workspace_name: "Acme",
    }, { startIngestion: false });

    expect(result).toEqual({
      success: true,
      botId: undefined,
      workspaceId: "workspace-1",
      workspaceName: "Acme",
    });
    expect(storeTokenMock).toHaveBeenCalledWith("tenant-1", "notion", "oauth-token", expect.objectContaining({
      auth_mode: "oauth",
      workspaceId: "workspace-1",
      workspaceName: "Acme",
    }), "refresh-token");
    expect(upsertConnectionMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      provider: "notion",
      externalAccountId: "workspace-1",
      status: "active",
      metadata: { authMode: "oauth" },
    });
    expect(startNotionPollingMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-1");
  });
});
