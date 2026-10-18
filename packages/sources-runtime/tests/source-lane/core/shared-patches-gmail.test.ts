import { beforeEach, describe, expect, it, vi } from "vitest";

/** Regressions for gmail patch requests 1 and 2 (shared google connect.ts / index.ts, PROVENANCE "patched"). */
const enqueueTaskMock = vi.hoisted(() => vi.fn());
const runRecordedMock = vi.hoisted(() => vi.fn());
const runGmailBackfillMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/queue/queue.js", () => ({ enqueueTask: enqueueTaskMock }));
vi.mock("../../../src/queue/dispatch.js", () => ({ startGooglePolling: vi.fn(async () => undefined) }));
vi.mock("../../../src/db/connections.js", () => ({ upsertConnection: vi.fn(async () => undefined) }));
vi.mock("../../../src/graph/wiring/default-kb.js", () => ({ ensureDefaultKbForTenant: vi.fn(async () => ({ kbId: "kb", attachedProviders: [] })) }));
vi.mock("../../../src/vault/google-auth.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  connectGoogleWorkspaceDelegation: vi.fn(async (_t: string, email: string) => ({ email })),
  isGoogleWorkspaceDelegationEmailSupported: vi.fn(() => true),
}));
vi.mock("../../../src/integrations/source-sync-task.js", () => ({
  coverageFromDays: (d: unknown) => (typeof d === "number" ? new Date(0) : null),
  runRecordedSourceSyncTask: runRecordedMock,
}));
vi.mock("../../../src/integrations/gmail/jobs.js", () => ({ runGmailBackfill: runGmailBackfillMock, runGmailPoll: vi.fn() }));

import { connectGoogleWorkspace } from "../../../src/integrations/google/connect.js";
import { googleIntegration } from "../../../src/integrations/google/index.js";

beforeEach(() => {
  vi.clearAllMocks();
  enqueueTaskMock.mockResolvedValue(undefined);
  runRecordedMock.mockImplementation(async (_input: unknown, run: () => Promise<unknown>) => run());
  runGmailBackfillMock.mockResolvedValue({ scanned: 0, stored: 0, attachments: 0 });
});

describe("gmail shared patches", () => {
  it("connect seeds a full (unbounded, resumable) gmail.backfill instead of 30 days / 500 messages", async () => {
    await connectGoogleWorkspace({ tenantId: "t1", body: { userEmail: "jane@corp.com" } });
    const gmail = enqueueTaskMock.mock.calls.map((c) => c[0]).filter((t) => t.kind === "gmail.backfill");
    expect(gmail.length).toBeGreaterThan(0);
    for (const t of gmail) {
      expect(t.payload.mode).toBe("full");
      expect(t.payload).not.toHaveProperty("days");
      expect(t.payload).not.toHaveProperty("maxMessages");
    }
  });

  it("gmail.backfill records no days-bounded coverage window and passes no bounds to the engine", async () => {
    const handler = googleIntegration.taskHandlers!()["gmail.backfill"]!;
    await handler({ tenantId: "t1", mailbox: "jane@corp.com", days: 30, maxMessages: 500 }, { task: { id: "x", queue: "backfill", tenantId: "t1" } } as never);
    expect(runRecordedMock.mock.calls[0]![0].coverageFrom).toBeNull();
    expect(runGmailBackfillMock).toHaveBeenCalledWith("t1", { mailbox: "jane@corp.com" });
  });
});
