import { beforeEach, describe, expect, it, vi } from "vitest";

// Connect-time task fan-out: the content backfill chain must be enqueued so
// every existing doc's content is captured (discovery -> per-doc snapshot ->
// mirror), not just future changes.
const enqueueTaskMock = vi.hoisted(() => vi.fn());
const upsertConnectionMock = vi.hoisted(() => vi.fn());
const startGooglePollingMock = vi.hoisted(() => vi.fn());
const ensureDefaultKbForTenantMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/queue/queue.js", () => ({
  enqueueTask: enqueueTaskMock,
}));
vi.mock("../../../src/queue/dispatch.js", () => ({
  startGooglePolling: startGooglePollingMock,
}));
vi.mock("../../../src/db/connections.js", () => ({
  upsertConnection: upsertConnectionMock,
}));
vi.mock("../../../src/graph/wiring/default-kb.js", () => ({
  ensureDefaultKbForTenant: ensureDefaultKbForTenantMock,
}));
vi.mock("../../../src/vault/google-auth.js", () => ({
  connectGoogleWorkspaceDelegation: vi.fn(async (_tenantId: string, email: string) => ({ email })),
  isGoogleWorkspaceDelegationEmailSupported: vi.fn(() => true),
}));

import { connectGoogleWorkspace } from "../../../src/integrations/google/connect.js";

beforeEach(() => {
  vi.clearAllMocks();
  enqueueTaskMock.mockResolvedValue(undefined);
  upsertConnectionMock.mockResolvedValue(undefined);
  startGooglePollingMock.mockResolvedValue(undefined);
  ensureDefaultKbForTenantMock.mockResolvedValue({ kbId: "kb-1", attachedProviders: ["gmail", "calendar", "google-docs"] });
});

describe("connectGoogleWorkspace initial task fan-out", () => {
  it("enqueues the gdocs content backfill chain: unbounded discovery plus history backfill", async () => {
    const result = await connectGoogleWorkspace({ tenantId: "t1", body: { userEmail: "jane@corp.com" } });

    expect(result.status).toBe(200);
    expect(ensureDefaultKbForTenantMock).toHaveBeenCalledWith(expect.anything(), "t1");
    const tasks = enqueueTaskMock.mock.calls.map((call) => call[0]);
    expect(tasks.map((task) => task.kind).sort()).toEqual([
      "calendar.setup",
      "gdocs.backfill",
      "gdocs.discovery",
      "gmail.backfill",
    ]);

    // Discovery covers the FULL corpus (no days bound): a doc that never
    // changes after connect must still get its content captured.
    const discovery = tasks.find((task) => task.kind === "gdocs.discovery");
    expect(discovery).toMatchObject({
      queue: "backfill",
      tenantId: "t1",
      groupKey: "t1:gdocs",
      dedupeKey: "t1:google:gdocs.discovery:initial",
    });
    expect(discovery.payload.query).toContain("modifiedTime > ");
    expect(discovery.payload.days).toBeUndefined();

    // History hydration (Activity edits + comments) mirrors the gmail window.
    const backfill = tasks.find((task) => task.kind === "gdocs.backfill");
    expect(backfill).toMatchObject({
      queue: "backfill",
      tenantId: "t1",
      groupKey: "t1:gdocs",
      dedupeKey: "t1:google:gdocs.backfill:initial",
      payload: { tenantId: "t1", days: 30 },
    });
  });

  it("re-connect enqueues the same deterministic dedupe keys (idempotent fan-out)", async () => {
    await connectGoogleWorkspace({ tenantId: "t1", body: { userEmail: "jane@corp.com" } });
    const firstKeys = enqueueTaskMock.mock.calls.map((call) => call[0].dedupeKey).sort();
    enqueueTaskMock.mockClear();

    await connectGoogleWorkspace({ tenantId: "t1", body: { userEmail: "jane@corp.com" } });
    const secondKeys = enqueueTaskMock.mock.calls.map((call) => call[0].dedupeKey).sort();

    expect(secondKeys).toEqual(firstKeys);
    expect(new Set(firstKeys).size).toBe(firstKeys.length);
  });
});
