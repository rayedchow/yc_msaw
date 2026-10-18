import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({ NOTION_WEBHOOK_VERIFICATION_TOKEN: "notion-secret" }));
const enqueueCustomerBackendJobMock = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  })),
}));
const markNotionDataSourcePagesDirtyMock = vi.hoisted(() => vi.fn());
const markNotionPageDirtyMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/env.js", () => ({ env: envMock }));
vi.mock("../../../src/db/client.js", () => ({ db: dbMock }));
vi.mock("../../../src/queue/dispatch.js", () => ({
  enqueueCustomerBackendJob: enqueueCustomerBackendJobMock,
  enqueueEventProcessing: vi.fn(),
}));
vi.mock("../../../src/integrations/notion/poller.js", () => ({
  markNotionDataSourcePagesDirty: markNotionDataSourcePagesDirtyMock,
  markNotionPageDirty: markNotionPageDirtyMock,
  removeNotionDataSourceContent: vi.fn(),
  removeNotionPageContent: vi.fn(),
}));

import { handleNotionWebhook } from "../../../src/integrations/notion/webhook.js";

describe("Notion webhook", () => {
  beforeEach(() => {
    envMock.NOTION_WEBHOOK_VERIFICATION_TOKEN = "notion-secret";
    enqueueCustomerBackendJobMock.mockReset();
    markNotionDataSourcePagesDirtyMock.mockReset();
    markNotionPageDirtyMock.mockReset();
    dbMock.select.mockReset();
  });

  it("enqueues the registered notion.poll handler for polling webhook events", async () => {
    dbMock.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{
          userId: "user-1",
          metadata: { workspaceId: "workspace-1", botId: "bot-1" },
        }]),
      })),
    });
    const body = JSON.stringify({
      type: "data_source.content_updated",
      workspace_id: "workspace-1",
      entity: { id: "ds-1", type: "data_source" },
      accessible_by: [{ id: "bot-1", type: "bot" }],
    });
    const signature = `sha256=${createHmac("sha256", "notion-secret").update(body).digest("hex")}`;

    const result = await handleNotionWebhook({ body, signature });

    expect(result.status).toBe(204);
    expect(markNotionDataSourcePagesDirtyMock).toHaveBeenCalledWith("user-1", "ds-1");
    expect(enqueueCustomerBackendJobMock).toHaveBeenCalledWith("notion-poll", "notion.poll", { userId: "user-1" });
  });

  it("marks the affected page dirty for comment webhooks so comment bodies get refetched", async () => {
    dbMock.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{
          userId: "user-1",
          metadata: { workspaceId: "workspace-1", botId: "bot-1" },
        }]),
      })),
    });
    const body = JSON.stringify({
      type: "comment.created",
      workspace_id: "workspace-1",
      entity: { id: "comment-1", type: "comment" },
      data: { page_id: "page-9" },
      accessible_by: [{ id: "bot-1", type: "bot" }],
    });
    const signature = `sha256=${createHmac("sha256", "notion-secret").update(body).digest("hex")}`;

    const result = await handleNotionWebhook({ body, signature });

    expect(result.status).toBe(204);
    expect(markNotionPageDirtyMock).toHaveBeenCalledWith("user-1", "page-9");
  });
});
