import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/env.js", () => ({ env: { NOTION_WEBHOOK_VERIFICATION_TOKEN: "unused" } }));
vi.mock("../../../../src/db/client.js", () => ({ db: {} }));
vi.mock("../../../../src/queue/dispatch.js", () => ({ enqueueCustomerBackendJob: vi.fn(), enqueueEventProcessing: vi.fn() }));
vi.mock("../../../../src/integrations/notion/poller.js", () => ({
  markNotionDataSourcePagesDirty: vi.fn(),
  markNotionPageDirty: vi.fn(),
  removeNotionDataSourceContent: vi.fn(),
  removeNotionPageContent: vi.fn(),
}));

import { handleNotionWebhook } from "../../../../src/integrations/notion/webhook.js";
import { notionIntegration } from "../../../../src/integrations/notion/index.js";

/** The Notion handshake token is the webhook's signing secret: logs carry its fingerprint unless the operator opts in. */
describe("Notion webhook verification token logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NOTION_WEBHOOK_LOG_VERIFICATION_TOKEN;
  });

  it("logs only a fingerprint by default and the token only when opted in", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const token = "secret_synthetic_verification_token_0123";
    const r = await handleNotionWebhook({ body: JSON.stringify({ verification_token: token }) });
    expect(r.status).toBe(200);
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).toMatch(/sha256 [0-9a-f]{12}/);
    process.env.NOTION_WEBHOOK_LOG_VERIFICATION_TOKEN = "1";
    await handleNotionWebhook({ body: JSON.stringify({ verification_token: token }) });
    expect(lines.at(-1)).toContain(token);
  });
});

describe("Notion disconnect scope", () => {
  it("lists every scheduled Notion task kind, so disconnect disables the backfill and the deep sweep too", () => {
    expect(notionIntegration.taskKinds!()).toEqual(expect.arrayContaining(["notion.poll", "notion.render", "notion.reconcile", "notion.backfill", "notion.source_sweep"]));
  });
});
