import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, "..", "..");
const cliPath = resolve(packageDir, "bin", "shepherd-onboard.js");

async function importCliWithTempHome() {
  const home = await mkdtemp(join(tmpdir(), "shepherd-messages-backfill-"));
  vi.stubEnv("HOME", home);
  const mod = await import(`${cliPath}?test=${Date.now()}-${Math.random()}`);
  return { home, testApi: mod.__test };
}

describe("Messages historical backfill", () => {
  it("defaults first-run Messages source backfill to all selected history while preserving explicit numeric windows", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      expect(testApi.parseMessagesInitialBackfillDays(undefined)).toBeNull();
      expect(testApi.parseMessagesInitialBackfillDays("")).toBeNull();
      expect(testApi.parseMessagesInitialBackfillDays("60")).toBe(60);
      expect(testApi.parseMessagesInitialBackfillDays("all")).toBeNull();
      expect(testApi.messagesBackfillDaysFromConfig({})).toBeNull();
      expect(testApi.messagesBackfillDaysFromConfig({ backfillDays: null })).toBeNull();
      expect(testApi.messagesBackfillDaysFromConfig({ backfillDays: 60 })).toBe(60);
      expect(testApi.messagesBackfillDaysFromConfig({ backfillDays: null, backfillAllHistory: true })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses oldest-to-newest row cursors and resumes after a queued send", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const messages = Array.from({ length: 1200 }, (_, index) => ({
        id: `msg-${index + 1}`,
        messageId: `msg-${index + 1}`,
        rowId: index + 1,
        chatId: "chat-1",
        text: `message ${index + 1}`,
        isFromMe: false,
      }));
      const queries: Array<Record<string, unknown>> = [];
      const sdk = {
        async getMessages(query: Record<string, unknown>) {
          queries.push(query);
          const sinceRowId = Number(query.sinceRowId ?? 0);
          return messages
            .filter((message) => message.rowId > sinceRowId)
            .slice(0, Number(query.limit ?? 1000));
        },
      };
      const stateCache = { observe: vi.fn() };
      const contactSync = { observeMessages: vi.fn() };
      const serializer = { serialize: (message: unknown) => message };
      let sendCalls = 0;
      const sender = {
        userId: "user_1",
        async send(batch: unknown[]) {
          sendCalls++;
          if (sendCalls === 2) return { stored: 0, updated: 0, skipped: 0, queued: batch.length };
          return { stored: batch.length, updated: 0, skipped: 0, queued: 0 };
        },
      };

      const first = await testApi.runMessagesBackfill(sdk, sender, serializer, null, ["chat-1"], contactSync, stateCache);
      expect(first).toMatchObject({ complete: false, queued: 200 });
      expect(queries.map((query) => query.sinceRowId)).toEqual([0, 1000]);
      expect(queries.every((query) => query.orderByRowIdAsc === true)).toBe(true);
      expect(queries.every((query) => !("offset" in query))).toBe(true);

      const scope = testApi.messagesBackfillScope({ backfillDays: null, allChats: false, allowedChatIds: ["chat-1"] });
      const key = testApi.messagesBackfillProgressKey("chat-1");
      expect(testApi.loadMessagesBackfillProgressCursor("user_1", scope, key)).toBe(1000);

      const beforeResumeQueryCount = queries.length;
      const resumed = await testApi.runMessagesBackfill(sdk, sender, serializer, null, ["chat-1"], contactSync, stateCache);
      expect(resumed).toMatchObject({ complete: true, queued: 0 });
      expect(queries[beforeResumeQueryCount].sinceRowId).toBe(1000);
      expect(testApi.loadMessagesBackfillProgressCursor("user_1", scope, key)).toBe(1200);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("can drain an existing Messages queue without new messages", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const sender = new testApi.MessagesBatchSender("https://example.invalid", "token", "user_2");
      sender.saveQueue([
        { messageId: "queued-1", rowId: 1, chatId: "chat-1" },
        { messageId: "queued-2", rowId: 2, chatId: "chat-1" },
      ]);
      const posted: unknown[][] = [];
      sender.postBatch = async (batch: unknown[]) => {
        posted.push(batch);
        return { stored: batch.length, updated: 0, skipped: 0 };
      };

      expect(sender.queueDepth()).toBe(2);
      const result = await sender.send([]);

      expect(result).toMatchObject({ stored: 2, queued: 0 });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toHaveLength(2);
      expect(sender.queueDepth()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  // procmem: the donor default became 500 in gigabrain 04e9481e; this expectation (a97681e6) was never updated.
  it("defaults Messages upload batches to 500 and caps env overrides at 500", async () => {
    {
      const { home, testApi } = await importCliWithTempHome();
      try {
        const sender = new testApi.MessagesBatchSender("https://example.invalid", "token", "user_default_batch");
        const posted: unknown[][] = [];
        sender.postBatch = async (batch: unknown[]) => {
          posted.push(batch);
          return { stored: batch.length, updated: 0, skipped: 0 };
        };

        await sender.send(Array.from({ length: 201 }, (_, index) => ({
          messageId: `default-${index}`,
          rowId: index,
          chatId: "chat-1",
        })));

        expect(posted.map((batch) => batch.length)).toEqual([201]);
      } finally {
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
      }
    }

    {
      const home = await mkdtemp(join(tmpdir(), "shepherd-messages-env-cap-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("SHEPHERD_MESSAGES_BATCH_SIZE", "900");
      try {
        const mod = await import(`${cliPath}?test=${Date.now()}-${Math.random()}`);
        const sender = new mod.__test.MessagesBatchSender("https://example.invalid", "token", "user_capped_batch");
        const posted: unknown[][] = [];
        sender.postBatch = async (batch: unknown[]) => {
          posted.push(batch);
          return { stored: batch.length, updated: 0, skipped: 0 };
        };

        await sender.send(Array.from({ length: 501 }, (_, index) => ({
          messageId: `capped-${index}`,
          rowId: index,
          chatId: "chat-1",
        })));

        expect(posted.map((batch) => batch.length)).toEqual([500, 1]);
      } finally {
        vi.unstubAllEnvs();
        await rm(home, { recursive: true, force: true });
      }
    }
  });

  it("uses configurable larger Messages upload batches", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const sender = new testApi.MessagesBatchSender("https://example.invalid", "token", "user_batch", undefined, {
        batchSize: 4,
        uploadConcurrency: 1,
      });
      const posted: unknown[][] = [];
      sender.postBatch = async (batch: unknown[]) => {
        posted.push(batch);
        return { stored: batch.length, updated: 0, skipped: 0 };
      };

      const messages = Array.from({ length: 9 }, (_, index) => ({
        messageId: `msg-${index + 1}`,
        rowId: index + 1,
        chatId: "chat-1",
      }));
      const result = await sender.send(messages);

      expect(result).toMatchObject({ stored: 9, queued: 0 });
      expect(posted.map((batch) => batch.length)).toEqual([4, 4, 1]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses env-driven Messages upload and queue sizing", async () => {
    const home = await mkdtemp(join(tmpdir(), "shepherd-messages-env-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("SHEPHERD_IMESSAGE_BATCH_SIZE", "3");
    vi.stubEnv("SHEPHERD_MESSAGES_POST_CONCURRENCY", "1");
    vi.stubEnv("SHEPHERD_MESSAGES_MAX_QUEUE_MESSAGES", "4");
    try {
      const mod = await import(`${cliPath}?test=${Date.now()}-${Math.random()}`);
      const sender = new mod.__test.MessagesBatchSender("https://example.invalid", "token", "user_env");
      const posted: unknown[][] = [];
      sender.postBatch = async (batch: unknown[]) => {
        posted.push(batch);
        return { stored: batch.length, updated: 0, skipped: 0 };
      };

      const result = await sender.send(Array.from({ length: 7 }, (_, index) => ({
        messageId: `msg-${index}`,
        rowId: index,
        chatId: "chat-1",
      })));

      expect(result).toMatchObject({ stored: 7, queued: 0 });
      expect(posted.map((batch) => batch.length)).toEqual([3, 3, 1]);

      sender.saveQueue(Array.from({ length: 6 }, (_, index) => ({ messageId: `queued-${index}`, rowId: index, chatId: "chat-1" })));
      expect(sender.queueDepth()).toBe(4);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uploads Messages batches with bounded concurrency", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const sender = new testApi.MessagesBatchSender("https://example.invalid", "token", "user_parallel", undefined, {
        batchSize: 2,
        uploadConcurrency: 3,
      });
      let active = 0;
      let maxActive = 0;
      sender.postBatch = async (batch: unknown[]) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { stored: batch.length, updated: 0, skipped: 0 };
      };

      const messages = Array.from({ length: 8 }, (_, index) => ({
        messageId: `msg-${index + 1}`,
        rowId: index + 1,
        chatId: "chat-1",
      }));
      const result = await sender.send(messages);

      expect(result).toMatchObject({ stored: 8, queued: 0 });
      expect(maxActive).toBe(3);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("preserves retry queue from the earliest failed parallel batch", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const sender = new testApi.MessagesBatchSender("https://example.invalid", "token", "user_partial_failure", undefined, {
        batchSize: 2,
        uploadConcurrency: 3,
      });
      sender.postBatch = async (batch: Array<{ rowId: number }>) => {
        if (batch[0]?.rowId === 3) throw new Error("temporary 502");
        return { stored: batch.length, updated: 0, skipped: 0 };
      };

      const messages = Array.from({ length: 7 }, (_, index) => ({
        messageId: `msg-${index + 1}`,
        rowId: index + 1,
        chatId: "chat-1",
      }));
      const result = await sender.send(messages);

      expect(result).toMatchObject({ stored: 2, queued: 5 });
      expect(sender.loadQueue().map((message: { rowId: number }) => message.rowId)).toEqual([3, 4, 5, 6, 7]);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats a corrupt Messages retry queue as pending source-sync work", async () => {
      const { home, testApi } = await importCliWithTempHome();
    try {
      const sender = new testApi.MessagesBatchSender("https://example.invalid", "token", "user_corrupt_queue");
      await mkdir(dirname(sender.queueFile), { recursive: true });
      await writeFile(sender.queueFile, "{not-json", { mode: 0o600 });

      expect(sender.queueDepth()).toBe(1);
      const result = await sender.send([]);

      expect(result).toMatchObject({
        stored: 0,
        queued: 1,
        error: "Messages retry queue could not be read",
      });
      expect(await readFile(sender.queueFile, "utf8")).toBe("{not-json");
      expect(sender.queueDepth()).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("clears stale completion records before a forced retryable backfill", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const scope = testApi.messagesBackfillScope({ backfillDays: 30, allChats: true, allowedChatIds: [] });
      testApi.saveMessagesBackfillComplete("user_3", scope, { complete: true, totalStored: 1200 });
      testApi.saveMessagesBackfillProgressCursor("user_3", scope, testApi.messagesBackfillProgressKey(null), 1200);
      expect(testApi.loadMessagesBackfillComplete("user_3", scope)).toMatchObject({ complete: true });
      expect(testApi.loadMessagesBackfillProgressCursor("user_3", scope, testApi.messagesBackfillProgressKey(null))).toBe(1200);

      testApi.clearMessagesBackfillComplete("user_3", scope);
      testApi.clearMessagesBackfillProgress("user_3", scope);

      expect(testApi.loadMessagesBackfillComplete("user_3", scope)).toBeNull();
      expect(testApi.loadMessagesBackfillProgressCursor("user_3", scope, testApi.messagesBackfillProgressKey(null))).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("writes aggregate backfill progress with rate and ETA fields", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const messages = Array.from({ length: 4 }, (_, index) => ({
        id: `msg-${index + 1}`,
        messageId: `msg-${index + 1}`,
        rowId: index + 1,
        chatId: "chat-1",
        text: `message ${index + 1}`,
        isFromMe: false,
      }));
      const sdk = {
        async countMessages() {
          return messages.length;
        },
        async getMessages(query: Record<string, unknown>) {
          return messages.filter((message) => message.rowId > Number(query.sinceRowId ?? 0));
        },
      };
      const sender = {
        userId: "user_progress",
        async send(batch: unknown[]) {
          return { stored: batch.length, updated: 0, skipped: 0, queued: 0 };
        },
      };

      await testApi.runMessagesBackfill(
        sdk,
        sender,
        { serialize: (message: unknown) => message },
        60,
        ["iMessage;-;+15551234567"],
      );
      const status = JSON.parse(await readFile(testApi.messagesBackfillStatusFile("user_progress"), "utf8"));

      expect(status).toMatchObject({
        status: "complete",
        scopeKind: "selected_chats",
        chatCount: 1,
        scope: {
          version: 1,
          backfillDays: 60,
          scope: { selectedChatCount: 1 },
        },
        estimatedTotalMessages: 4,
        scannedMessages: 4,
        sentMessages: 4,
        queuedMessages: 0,
      });
      expect(status).toHaveProperty("ratePerMinute");
      expect(status).toHaveProperty("etaSeconds", null);
      expect(JSON.stringify(status)).not.toContain("iMessage;-;+15551234567");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("ignores generated backfill status files when locating the latest Messages config", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const dir = join(home, ".shepherd", "raw-messages");
      await mkdir(dir, { recursive: true });
      const configPath = join(dir, "user_status.json");
      await writeFile(configPath, JSON.stringify({
        apiUrl: "https://api.test",
        userId: "user_status",
        agentToken: "gimsg_status",
        backfillDays: null,
        allChats: false,
        allowedChatIds: ["iMessage;-;+15551234567"],
      }));
      await writeFile(join(dir, "user_status-backfill-status.json"), JSON.stringify({
        version: 1,
        status: "running",
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      }));

      expect(await testApi.latestMessagesConfigPath()).toBe(configPath);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("redacts raw chat IDs from legacy backfill status records", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const status = testApi.publicMessagesBackfillStatus({
        version: 1,
        status: "running",
        scopeKind: "selected_chats",
        chatCount: 1,
        scope: {
          version: 1,
          backfillDays: "all",
          scope: { chatIds: ["iMessage;-;+15551234567"] },
        },
      });

      expect(status.scope).toEqual({
        version: 1,
        backfillDays: "all",
        scope: { selectedChatCount: 1 },
      });
      expect(JSON.stringify(status)).not.toContain("iMessage;-;+15551234567");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("remote reset commands clear stale progress before re-running backfill", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const scope = testApi.messagesBackfillScope({ backfillDays: null, allChats: true, allowedChatIds: [] });
      const key = testApi.messagesBackfillProgressKey(null);
      testApi.saveMessagesBackfillComplete("user_4", scope, { complete: true, totalStored: 1200 });
      testApi.saveMessagesBackfillProgressCursor("user_4", scope, key, 1200);

      const messages = [
        { id: "msg-1", messageId: "msg-1", rowId: 1, chatId: "chat-1", text: "early", isFromMe: false },
        { id: "msg-2", messageId: "msg-2", rowId: 2, chatId: "chat-1", text: "later", isFromMe: false },
      ];
      const queries: Array<Record<string, unknown>> = [];
      const sdk = {
        async getMessages(query: Record<string, unknown>) {
          queries.push(query);
          return messages.filter((message) => message.rowId > Number(query.sinceRowId ?? 0));
        },
      };
      const sender = {
        userId: "user_4",
        fetchCommand: vi.fn(async () => ({ id: "cmd-1", type: "messages_backfill_reset" })),
        ackCommand: vi.fn(async () => ({ ok: true })),
        send: vi.fn(async (batch: unknown[]) => ({ stored: batch.length, updated: 0, skipped: 0, queued: 0 })),
      };
      const poller = testApi.startMessagesCommandPoller({
        sdk,
        sender,
        serializer: { serialize: (message: unknown) => message },
        userId: "user_4",
        defaultBackfillDays: null,
        allChats: true,
        allowedChatIds: [],
        contactSync: { observeMessages: vi.fn(), syncNow: vi.fn(async () => ({})) },
        stateCache: { observe: vi.fn() },
        intervalMs: 60_000,
      });
      try {
        await vi.waitFor(() => {
          expect(sender.ackCommand).toHaveBeenCalledWith("cmd-1", expect.objectContaining({ status: "completed" }));
        });
      } finally {
        poller.stop();
      }

      expect(queries[0].sinceRowId).toBe(0);
      expect(testApi.loadMessagesBackfillComplete("user_4", scope)).toMatchObject({ complete: true });
      expect(testApi.loadMessagesBackfillProgressCursor("user_4", scope, key)).toBe(2);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("remote source-sync commands ack only with explicit coverage and empty queue proof", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const messages = [
        { id: "msg-1", messageId: "msg-1", rowId: 1, chatId: "chat-1", text: "early", isFromMe: false },
        { id: "msg-2", messageId: "msg-2", rowId: 2, chatId: "chat-1", text: "later", isFromMe: false },
      ];
      const queries: Array<Record<string, unknown>> = [];
      const sdk = {
        async getMessages(query: Record<string, unknown>) {
          queries.push(query);
          return messages.filter((message) => message.rowId > Number(query.sinceRowId ?? 0));
        },
      };
      const sender = {
        userId: "user_source_sync",
        fetchCommand: vi.fn(async () => ({
          id: "cmd-source-sync",
          type: "messages_source_sync",
          sourceSyncRunId: "00000000-0000-4000-8000-000000000456",
          coverageFrom: "2026-01-01T00:00:00.000Z",
          coverageTo: "2026-06-28T22:00:00.000Z",
        })),
        ackCommand: vi.fn(async () => ({ ok: true })),
        queueDepth: vi.fn(() => 0),
        send: vi.fn(async (batch: unknown[]) => ({ stored: batch.length, updated: 0, skipped: 0, queued: 0 })),
      };
      const poller = testApi.startMessagesCommandPoller({
        sdk,
        sender,
        serializer: { serialize: (message: unknown) => message },
        userId: "user_source_sync",
        defaultBackfillDays: null,
        allChats: false,
        allowedChatIds: ["chat-1"],
        contactSync: { observeMessages: vi.fn(), syncNow: vi.fn(async () => ({})) },
        stateCache: { observe: vi.fn() },
        intervalMs: 60_000,
      });
      try {
        await vi.waitFor(() => {
          expect(sender.ackCommand).toHaveBeenCalledWith("cmd-source-sync", expect.objectContaining({
            status: "completed",
            result: expect.objectContaining({
              receiptVersion: 1,
              sourceSyncRunId: "00000000-0000-4000-8000-000000000456",
              provider: "imessage",
              coverageFrom: "2026-01-01T00:00:00.000Z",
              coverageTo: "2026-06-28T22:00:00.000Z",
              highWatermark: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
              exhausted: true,
              capHit: false,
              scannedMessages: 2,
              sentMessages: 2,
              pendingMessages: 0,
              failedMessages: 0,
              scopeKind: "selected_chats",
              scopeHash: expect.any(String),
            }),
          }));
        });
      } finally {
        poller.stop();
      }

      expect(sender.queueDepth).toHaveBeenCalled();
      expect(queries[0].since).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("remote source-sync commands do not ack while the local Messages queue is nonempty", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const messages = [
        { id: "msg-1", messageId: "msg-1", rowId: 1, chatId: "chat-1", text: "early", isFromMe: false },
      ];
      const sdk = {
        async getMessages(query: Record<string, unknown>) {
          return messages.filter((message) => message.rowId > Number(query.sinceRowId ?? 0));
        },
      };
      const sender = {
        userId: "user_source_sync_blocked",
        fetchCommand: vi.fn(async () => ({
          id: "cmd-source-sync-blocked",
          type: "messages_source_sync",
          sourceSyncRunId: "00000000-0000-4000-8000-000000000457",
          coverageFrom: "2026-01-01T00:00:00.000Z",
          coverageTo: "2026-06-28T22:00:00.000Z",
        })),
        ackCommand: vi.fn(async () => ({ ok: true })),
        queueDepth: vi.fn(() => 1),
        send: vi.fn(async (batch: unknown[]) => ({ stored: batch.length, updated: 0, skipped: 0, queued: 0 })),
      };
      const poller = testApi.startMessagesCommandPoller({
        sdk,
        sender,
        serializer: { serialize: (message: unknown) => message },
        userId: "user_source_sync_blocked",
        defaultBackfillDays: null,
        allChats: true,
        allowedChatIds: [],
        contactSync: { observeMessages: vi.fn(), syncNow: vi.fn(async () => ({})) },
        stateCache: { observe: vi.fn() },
        intervalMs: 60_000,
      });
      try {
        await vi.waitFor(() => {
          expect(sender.queueDepth).toHaveBeenCalled();
        });
      } finally {
        poller.stop();
      }

      expect(sender.ackCommand).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("remote reset commands clear progress only once for the same pending command", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const messages = Array.from({ length: 1200 }, (_, index) => ({
        id: `msg-${index + 1}`,
        messageId: `msg-${index + 1}`,
        rowId: index + 1,
        chatId: "chat-1",
        text: `message ${index + 1}`,
        isFromMe: false,
      }));
      const queries: Array<Record<string, unknown>> = [];
      const sdk = {
        async getMessages(query: Record<string, unknown>) {
          queries.push(query);
          const sinceRowId = Number(query.sinceRowId ?? 0);
          return messages
            .filter((message) => message.rowId > sinceRowId)
            .slice(0, Number(query.limit ?? 1000));
        },
      };
      let sendCalls = 0;
      const sender = {
        userId: "user_5",
        fetchCommand: vi.fn(async () => ({ id: "cmd-2", type: "messages_backfill_reset" })),
        ackCommand: vi.fn(async () => ({ ok: true })),
        async send(batch: unknown[]) {
          sendCalls++;
          if (sendCalls >= 2) return { stored: 0, updated: 0, skipped: 0, queued: batch.length };
          return { stored: batch.length, updated: 0, skipped: 0, queued: 0 };
        },
      };
      const poller = testApi.startMessagesCommandPoller({
        sdk,
        sender,
        serializer: { serialize: (message: unknown) => message },
        userId: "user_5",
        defaultBackfillDays: null,
        allChats: true,
        allowedChatIds: [],
        contactSync: { observeMessages: vi.fn(), syncNow: vi.fn(async () => ({})) },
        stateCache: { observe: vi.fn() },
        intervalMs: 20,
      });
      try {
        await vi.waitFor(() => {
          expect(queries.length).toBeGreaterThanOrEqual(3);
        });
      } finally {
        poller.stop();
      }

      expect(queries.map((query) => query.sinceRowId).slice(0, 3)).toEqual([0, 1000, 1000]);
      expect(sender.ackCommand).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("remote reset commands are failed when command handling throws", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const sdk = {
        async getMessages() {
          throw new Error("chat db unavailable");
        },
      };
      const sender = {
        userId: "user_6",
        fetchCommand: vi.fn(async () => ({ id: "cmd-3", type: "messages_backfill_reset" })),
        ackCommand: vi.fn(async () => ({ ok: true })),
        send: vi.fn(),
      };
      const poller = testApi.startMessagesCommandPoller({
        sdk,
        sender,
        serializer: { serialize: (message: unknown) => message },
        userId: "user_6",
        defaultBackfillDays: null,
        allChats: true,
        allowedChatIds: [],
        contactSync: { observeMessages: vi.fn(), syncNow: vi.fn(async () => ({})) },
        stateCache: { observe: vi.fn() },
        intervalMs: 60_000,
      });
      try {
        await vi.waitFor(() => {
          expect(sender.ackCommand).toHaveBeenCalledWith("cmd-3", expect.objectContaining({
            status: "failed",
            error: expect.stringContaining("chat db unavailable"),
          }));
        });
      } finally {
        poller.stop();
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps command state when failure acking also fails", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const sdk = {
        async getMessages() {
          throw new Error("chat db unavailable");
        },
      };
      const sender = {
        userId: "user_7",
        fetchCommand: vi.fn(async () => ({ id: "cmd-4", type: "messages_backfill_reset" })),
        ackCommand: vi.fn(async () => {
          throw new Error("network down");
        }),
        send: vi.fn(),
      };
      const poller = testApi.startMessagesCommandPoller({
        sdk,
        sender,
        serializer: { serialize: (message: unknown) => message },
        userId: "user_7",
        defaultBackfillDays: null,
        allChats: true,
        allowedChatIds: [],
        contactSync: { observeMessages: vi.fn(), syncNow: vi.fn(async () => ({})) },
        stateCache: { observe: vi.fn() },
        intervalMs: 60_000,
      });
      try {
        await vi.waitFor(() => {
          expect(sender.ackCommand).toHaveBeenCalledWith("cmd-4", expect.objectContaining({ status: "failed" }));
        });
      } finally {
        poller.stop();
      }

      expect(testApi.loadMessagesAgentCommandState("user_7")).toMatchObject({ commandId: "cmd-4" });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("serializes historical backfill runners with a non-queueing gate", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      const gate = testApi.createMessagesBackfillGate();
      let release!: () => void;
      const first = testApi.runWithMessagesBackfillGate(gate, () => new Promise<string>((resolve) => {
        release = () => resolve("first");
      }));

      await vi.waitFor(() => {
        expect(gate.running).toBe(true);
      });
      await expect(testApi.runWithMessagesBackfillGate(gate, async () => "second")).resolves.toEqual({ skipped: true });
      release();
      await expect(first).resolves.toEqual({ skipped: false, value: "first" });
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("resumes configured backfill maintenance after a pending remote command clears", async () => {
    const { home, testApi } = await importCliWithTempHome();
    try {
      let remoteCommandPending = true;
      const messages = [
        { id: "msg-1", messageId: "msg-1", rowId: 1, chatId: "chat-1", text: "hello", isFromMe: false },
      ];
      const sdk = {
        async getMessages(query: Record<string, unknown>) {
          return messages.filter((message) => message.rowId > Number(query.sinceRowId ?? 0));
        },
      };
      const sender = {
        userId: "user_maintenance_resume",
        send: vi.fn(async (batch: unknown[]) => ({ stored: batch.length, updated: 0, skipped: 0, queued: 0 })),
      };
      const maintenance = testApi.startMessagesBackfillMaintenance({
        sdk,
        sender,
        serializer: { serialize: (message: unknown) => message },
        userId: "user_maintenance_resume",
        backfillDays: null,
        allChats: true,
        allowedChatIds: [],
        contactSync: { observeMessages: vi.fn() },
        stateCache: { observe: vi.fn() },
        backfillScope: testApi.messagesBackfillScope({ backfillDays: null, allChats: true, allowedChatIds: [] }),
        backfillGate: testApi.createMessagesBackfillGate(),
        enabled: true,
        intervalMs: 60_000,
        deferWhen: () => remoteCommandPending,
      });

      try {
        maintenance.kick("remote-command-pending");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sender.send).not.toHaveBeenCalled();

        remoteCommandPending = false;
        maintenance.kick("remote-command-settled");
        await vi.waitFor(() => {
          expect(sender.send).toHaveBeenCalledTimes(1);
        });
      } finally {
        maintenance.stop();
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
