import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * gmail.backfill reschedules itself when a Google rate limit escapes the run. Its 1 h cap bounds only the exponential
 * backoff: a longer, valid Retry-After stays the floor of the rescheduled task (RFC 9110 §10.2.3). The real task
 * handler; the run, run bookkeeping and the queue insert are stubbed.
 */
const enqueued = vi.hoisted(() => [] as Array<{ runAt: Date; payload: Record<string, unknown> }>);
const failure = vi.hoisted(() => ({ seconds: 0 }));
vi.mock("../../../src/queue/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/queue/queue.js")>()),
  enqueueTask: vi.fn(async (input: { runAt: Date; payload: Record<string, unknown> }) => {
    enqueued.push(input);
    return "task-id";
  }),
}));
vi.mock("../../../src/integrations/source-sync-task.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/integrations/source-sync-task.js")>()),
  runRecordedSourceSyncTask: vi.fn(async (_input: unknown, run: () => Promise<unknown>) => run()),
}));
vi.mock("../../../src/integrations/gmail/jobs.js", async (importOriginal) => {
  const { GoogleRateLimitError } = await import("../../../src/vault/google-rate-limit.js");
  return {
    ...(await importOriginal<typeof import("../../../src/integrations/gmail/jobs.js")>()),
    runGmailBackfill: vi.fn(async () => {
      throw new GoogleRateLimitError("gmail:q", 429, failure.seconds, "rateLimitExceeded");
    }),
  };
});

import { googleIntegration } from "../../../src/integrations/google/index.js";

const handler = googleIntegration.taskHandlers!()["gmail.backfill"]!;
const run = (reschedules: number) => handler({ tenantId: "t1", mailbox: "a@x.test", rateLimitReschedules: reschedules }, { task: { id: "t", queue: "backfill", tenantId: "t1" } } as never);

describe("gmail.backfill rate-limit reschedule", () => {
  beforeEach(() => {
    enqueued.length = 0;
  });

  it("keeps a Retry-After longer than the 1 h backoff cap as the floor of the rescheduled run", async () => {
    failure.seconds = 14 * 86_400;
    const t0 = Date.now();
    expect(await run(0)).toMatchObject({ deferred: true, retryAfterSeconds: 14 * 86_400 });
    expect(enqueued[0]!.runAt.getTime() - t0).toBeGreaterThanOrEqual(14 * 86_400_000 - 1_000);
  });

  it("still backs off exponentially up to 1 h above a short Retry-After", async () => {
    failure.seconds = 60;
    expect(await run(0)).toMatchObject({ retryAfterSeconds: 120 });
    expect(await run(3)).toMatchObject({ retryAfterSeconds: 960 });
    expect(await run(5)).toMatchObject({ retryAfterSeconds: 3_600 });
  });
});
