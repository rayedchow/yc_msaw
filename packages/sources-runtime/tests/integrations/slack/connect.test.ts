import { beforeEach, describe, expect, it, vi } from "vitest";

const getTokenMetadataMock = vi.hoisted(() => vi.fn());
const storeTokenMock = vi.hoisted(() => vi.fn());
const upsertConnectionMock = vi.hoisted(() => vi.fn());
const startSlackPollingMock = vi.hoisted(() => vi.fn());
const enqueueTaskMock = vi.hoisted(() => vi.fn());
const executeMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const ensureDefaultKbForTenantMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../../src/vault/tokens.js", () => ({
  getTokenMetadata: getTokenMetadataMock,
  storeToken: storeTokenMock,
}));

vi.mock("../../../src/db/connections.js", () => ({
  upsertConnection: upsertConnectionMock,
}));

vi.mock("../../../src/queue/dispatch.js", () => ({
  startSlackPolling: startSlackPollingMock,
}));

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));

vi.mock("../../../src/graph/wiring/default-kb.js", () => ({
  ensureDefaultKbForTenant: ensureDefaultKbForTenantMock,
}));

import { connectSlackWithToken } from "../../../src/integrations/slack/connect.js";

describe("Slack connect", () => {
  beforeEach(() => {
    getTokenMetadataMock.mockReset().mockResolvedValue(null);
    storeTokenMock.mockReset().mockResolvedValue(undefined);
    upsertConnectionMock.mockReset().mockResolvedValue(undefined);
    startSlackPollingMock.mockReset().mockResolvedValue(undefined);
    enqueueTaskMock.mockReset().mockResolvedValue("task-1");
    executeMock.mockReset().mockResolvedValue([]);
    ensureDefaultKbForTenantMock.mockReset().mockResolvedValue({ kbId: "kb-1", attachedProviders: ["slack"] });
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: true,
      user_id: "U123",
      team_id: "T123",
      team: "Acme",
    })));
  });

  it("stores a user OAuth token, connection row, and Slack schedules", async () => {
    const result = await connectSlackWithToken("tenant-1", "xoxp-token");

    expect(result).toEqual({
      success: true,
      teamName: "Acme",
      slackUserId: "U123",
      slackTeamId: "T123",
    });
    expect(storeTokenMock).toHaveBeenCalledWith("tenant-1", "slack", "xoxp-token", expect.objectContaining({
      auth_mode: "user_oauth",
      slackUserId: "U123",
      slackTeamId: "T123",
      teamName: "Acme",
    }));
    expect(upsertConnectionMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      provider: "slack",
      externalAccountId: "T123",
      status: "active",
      metadata: {
        authMode: "user_oauth",
        slackUserId: "U123",
        slackTeamId: "T123",
        teamName: "Acme",
      },
    });
    expect(startSlackPollingMock).toHaveBeenCalledWith("tenant-1");
    expect(enqueueTaskMock).toHaveBeenCalledWith({
      queue: "sync",
      tenantId: "tenant-1",
      kind: "slack.discover",
      payload: { tenantId: "tenant-1" },
      groupKey: "tenant-1:slack",
      dedupeKey: "tenant-1:slack:discover:initial",
    });
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-1");
  });

  it("rejects reconnecting a tenant to a different Slack workspace", async () => {
    getTokenMetadataMock.mockResolvedValue({ slackTeamId: "T-OLD" });

    const result = await connectSlackWithToken("tenant-1", "xoxp-token");

    expect(result).toEqual({
      success: false,
      error: "Slack is already connected to a different workspace. Disconnect it before connecting another workspace.",
    });
    expect(storeTokenMock).not.toHaveBeenCalled();
    expect(upsertConnectionMock).not.toHaveBeenCalled();
    expect(startSlackPollingMock).not.toHaveBeenCalled();
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(ensureDefaultKbForTenantMock).not.toHaveBeenCalled();
  });

  it("rejects a workspace change recorded only on the connections row (token metadata lost)", async () => {
    getTokenMetadataMock.mockResolvedValue(null);
    executeMock.mockResolvedValue([{ external_account_id: "T-OLD", slack_team_id: null }]);

    const result = await connectSlackWithToken("tenant-1", "xoxp-token");

    expect(result).toEqual({
      success: false,
      error: "Slack is already connected to a different workspace. Disconnect it before connecting another workspace.",
    });
    expect(storeTokenMock).not.toHaveBeenCalled();
    expect(upsertConnectionMock).not.toHaveBeenCalled();
  });

  it("accepts a same-team reconnect", async () => {
    getTokenMetadataMock.mockResolvedValue({ slackTeamId: "T123", connected_at: "2024-01-01T00:00:00.000Z" });
    executeMock.mockResolvedValue([{ external_account_id: "T123", slack_team_id: "T123" }]);

    const result = await connectSlackWithToken("tenant-1", "xoxp-token");

    expect(result).toEqual({
      success: true,
      teamName: "Acme",
      slackUserId: "U123",
      slackTeamId: "T123",
    });
    expect(storeTokenMock).toHaveBeenCalledWith("tenant-1", "slack", "xoxp-token", expect.objectContaining({
      slackTeamId: "T123",
      connected_at: "2024-01-01T00:00:00.000Z",
    }));
    expect(upsertConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ externalAccountId: "T123" }));
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
