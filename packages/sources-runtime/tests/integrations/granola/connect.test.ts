import { beforeEach, describe, expect, it, vi } from "vitest";

const listGranolaNotesMock = vi.hoisted(() => vi.fn());
const listGranolaNotesViaMcpMock = vi.hoisted(() => vi.fn());
const getTokenMetadataMock = vi.hoisted(() => vi.fn());
const storeTokenMock = vi.hoisted(() => vi.fn());
const upsertConnectionMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn());
const startGranolaPollingMock = vi.hoisted(() => vi.fn());
const ensureDefaultKbForTenantMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/integrations/granola/poller.js", () => ({
  listGranolaNotes: listGranolaNotesMock,
}));

vi.mock("../../../src/integrations/granola/mcp-client.js", () => ({
  listGranolaNotesViaMcp: listGranolaNotesViaMcpMock,
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  deleteToken: vi.fn(),
  getTokenFull: vi.fn(),
  getTokenMetadata: getTokenMetadataMock,
  storeToken: storeTokenMock,
}));

vi.mock("../../../src/db/connections.js", () => ({
  upsertConnection: upsertConnectionMock,
}));

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  startGranolaPolling: startGranolaPollingMock,
}));

vi.mock("../../../src/graph/wiring/default-kb.js", () => ({
  ensureDefaultKbForTenant: ensureDefaultKbForTenantMock,
}));

import { connectGranolaWithOAuthToken, connectGranolaWithToken } from "../../../src/integrations/granola/connect.js";

describe("Granola connect", () => {
  beforeEach(() => {
    listGranolaNotesMock.mockReset().mockResolvedValue({ notes: [], hasMore: false, cursor: null });
    listGranolaNotesViaMcpMock.mockReset().mockResolvedValue({ notes: [], hasMore: false, cursor: null });
    getTokenMetadataMock.mockReset();
    storeTokenMock.mockReset().mockResolvedValue(undefined);
    upsertConnectionMock.mockReset().mockResolvedValue(undefined);
    enqueueTaskMock.mockReset().mockResolvedValue("task-1");
    startGranolaPollingMock.mockReset().mockResolvedValue(undefined);
    ensureDefaultKbForTenantMock.mockReset().mockResolvedValue({ kbId: "kb-1", attachedProviders: ["granola"] });
  });

  it("preserves reconnect watermark and scope when API key opts are omitted", async () => {
    getTokenMetadataMock.mockResolvedValue({
      connectedAt: "2024-01-01T00:00:00.000Z",
      lastUpdatedAt: "2024-01-02T00:00:00.000Z",
      folderId: "folder-old",
      includeTranscript: false,
    });

    const result = await connectGranolaWithToken("tenant-1", " api-key ");

    expect(result).toEqual({ success: true, hasMore: false });
    expect(listGranolaNotesMock).toHaveBeenCalledWith("api-key", { folderId: "folder-old", pageSize: 1 });
    expect(storeTokenMock).toHaveBeenCalledWith("tenant-1", "granola", "api-key", expect.objectContaining({
      auth_mode: "api_key",
      connectedAt: "2024-01-01T00:00:00.000Z",
      lastUpdatedAt: "2024-01-02T00:00:00.000Z",
      folderId: "folder-old",
      includeTranscript: false,
    }));
    expect(upsertConnectionMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      provider: "granola",
      externalAccountId: undefined,
      status: "active",
      metadata: { authMode: "api_key" },
    });
    expect(startGranolaPollingMock).toHaveBeenCalledWith("tenant-1");
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-1");
  });

  it("starts polling and enqueues one initial backfill on first API key connect", async () => {
    getTokenMetadataMock.mockResolvedValue(null);

    await connectGranolaWithToken("tenant-1", "api-key", {
      folderId: "folder-new",
      includeTranscript: false,
    });

    expect(storeTokenMock).toHaveBeenCalledWith("tenant-1", "granola", "api-key", expect.objectContaining({
      folderId: "folder-new",
      includeTranscript: false,
    }));
    expect(startGranolaPollingMock).toHaveBeenCalledWith("tenant-1");
    expect(enqueueTaskMock).toHaveBeenCalledWith({
      queue: "backfill",
      tenantId: "tenant-1",
      kind: "granola.backfill",
      payload: { tenantId: "tenant-1" },
      groupKey: "tenant-1:granola",
      dedupeKey: "tenant-1:granola:backfill:initial",
    });
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-1");
  });

  it("preserves reconnect watermark and scope on OAuth callback reconnects", async () => {
    getTokenMetadataMock.mockResolvedValue({
      lastUpdatedAt: "2024-01-02T00:00:00.000Z",
      folderId: "folder-old",
      includeTranscript: false,
    });

    const result = await connectGranolaWithOAuthToken("tenant-1", { access_token: "oauth-token", refresh_token: "refresh" }, {
      clientId: "client-1",
      tokenEndpointAuthMethod: "none",
    });

    expect(result).toEqual({ success: true, hasMore: false });
    expect(listGranolaNotesViaMcpMock).toHaveBeenCalledWith("oauth-token", { folderId: "folder-old", pageSize: 1 });
    expect(storeTokenMock).toHaveBeenCalledWith("tenant-1", "granola", "oauth-token", expect.objectContaining({
      auth_mode: "oauth_mcp",
      lastUpdatedAt: "2024-01-02T00:00:00.000Z",
      folderId: "folder-old",
      includeTranscript: false,
    }), "refresh");
    expect(upsertConnectionMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      provider: "granola",
      externalAccountId: undefined,
      status: "active",
      metadata: { authMode: "oauth_mcp" },
    });
    expect(startGranolaPollingMock).toHaveBeenCalledWith("tenant-1");
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-1");
  });
});
