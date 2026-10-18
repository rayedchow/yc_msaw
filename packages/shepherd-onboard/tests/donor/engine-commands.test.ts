// Schema-parity tests for the CLI "engine" subcommands the macOS app drives.
// These spawn the real CLI with HOME pointed at a temp dir, so they exercise
// the exact files (and modes) the app relies on.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.resolve(__dirname, "../../bin/shepherd-onboard.js");

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "shepherd-engine-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[], input?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, HOME: home } },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.write(input);
    child.stdin?.end();
  });
}

async function startIngestServer() {
  const requests: Array<Record<string, any>> = [];
  const commands: Array<Record<string, any>> = [];
  const commandRequests: Array<Record<string, any>> = [];
  const ackRequests: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/coding-sessions/ingest/command") {
      commandRequests.push({ headers: req.headers });
      const command = commands.shift() ?? null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ command }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/coding-sessions/ingest/command/ack") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        ackRequests.push(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ command: { id: parsed.id, status: parsed.status } }));
      });
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/api/coding-sessions/ingest") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        stored: Array.isArray(parsed.sessions) ? parsed.sessions.length : 0,
        updated: 0,
        skipped: 0,
      }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test ingest server did not bind a TCP port");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    requests,
    commands,
    commandRequests,
    ackRequests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

describe("write-agent-state", () => {
  it("writes the CLI state file with 0600 and merges over existing state", async () => {
    const first = await runCli(["write-agent-state"], JSON.stringify({
      apiUrl: "https://api.test",
      sessionId: "user_1",
      sessionToken: "shrob_a",
      sources: { google: true, slack: false, granola: false, messages: true },
    }));
    const { statePath } = JSON.parse(first.stdout);
    expect(statePath).toBe(path.join(home, ".shepherd", "raw-onboarding-agent.json"));
    expect(statSync(statePath).mode & 0o777).toBe(0o600);

    await runCli(["write-agent-state"], JSON.stringify({ sessionToken: "shrob_b" }));
    const merged = JSON.parse(readFileSync(statePath, "utf8"));
    expect(merged.sessionId).toBe("user_1");
    expect(merged.sessionToken).toBe("shrob_b");
  });

  it("rejects non-object input", async () => {
    await expect(runCli(["write-agent-state"], JSON.stringify([1, 2]))).rejects.toMatchObject({
      stderr: expect.stringContaining("expects a JSON object"),
    });
  });
});

describe("write-messages-config", () => {
  it("writes the messages agent config in the CLI schema", async () => {
    const { stdout } = await runCli(["write-messages-config"], JSON.stringify({
      apiUrl: "https://api.test/",
      userId: "user_1",
      agentToken: "gimsg_x",
      allowedChatIds: ["iMessage;-;+15551234567"],
      selectedChats: [{ chatId: "iMessage;-;+15551234567", label: "Ada", kind: "dm", service: "iMessage", lastMessageAt: null, participants: [] }],
    }));
    const { configPath } = JSON.parse(stdout);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config).toMatchObject({
      apiUrl: "https://api.test",
      userId: "user_1",
      agentToken: "gimsg_x",
      backfillDays: null,
      backfillAllHistory: true,
      allChats: false,
      allowedChatIds: ["iMessage;-;+15551234567"],
      excludedMessageHandles: ["+17282355781", "+13054098546", "+12054012556"],
    });
    expect(config.selectedChats[0].chatId).toBe("iMessage;-;+15551234567");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("preserves explicit all-history Messages backfill config", async () => {
    const { stdout } = await runCli(["write-messages-config"], JSON.stringify({
      apiUrl: "https://api.test",
      userId: "user_all_history",
      agentToken: "gimsg_all",
      backfillDays: "all",
      allowedChatIds: ["iMessage;-;+15551234567"],
    }));
    const config = JSON.parse(readFileSync(JSON.parse(stdout).configPath, "utf8"));
    expect(config.backfillDays).toBeNull();
    expect(config.backfillAllHistory).toBe(true);
  });

  it("maps 'all' to the all-chats sentinel with empty allowedChatIds", async () => {
    const { stdout } = await runCli(["write-messages-config"], JSON.stringify({
      apiUrl: "https://api.test",
      userId: "user_2",
      agentToken: "gimsg_y",
      allowedChatIds: ["all"],
    }));
    const config = JSON.parse(readFileSync(JSON.parse(stdout).configPath, "utf8"));
    expect(config.allChats).toBe(true);
    expect(config.allowedChatIds).toEqual([]);
  });

  it("sanitizes hostile userIds so the config cannot escape raw-messages", async () => {
    const { stdout } = await runCli(["write-messages-config"], JSON.stringify({
      apiUrl: "https://api.test",
      userId: "../../evil",
      agentToken: "gimsg_t",
      allowedChatIds: ["all"],
    }));
    const { configPath } = JSON.parse(stdout);
    expect(configPath.startsWith(path.join(home, ".shepherd", "raw-messages") + path.sep)).toBe(true);
    expect(configPath).not.toContain(".." + path.sep);
  });

  it("refuses an empty chat selection", async () => {
    await expect(runCli(["write-messages-config"], JSON.stringify({
      apiUrl: "https://api.test",
      userId: "user_3",
      agentToken: "gimsg_z",
      allowedChatIds: [],
    }))).rejects.toMatchObject({
      stderr: expect.stringContaining("Select at least one Messages chat"),
    });
  });
});

describe("write-coding-sessions-config", () => {
  it("writes enabled coding-session providers into the local config", async () => {
    const { stdout } = await runCli(["write-coding-sessions-config"], JSON.stringify({
      apiUrl: "https://api.test/",
      userId: "user_1",
      agentToken: "gics_x",
      intervalSeconds: 45,
      providers: { openai: true, anthropic: false },
    }));
    const config = JSON.parse(readFileSync(JSON.parse(stdout).configPath, "utf8"));
    expect(config).toMatchObject({
      apiUrl: "https://api.test",
      userId: "user_1",
      agentToken: "gics_x",
      intervalSeconds: 45,
      providers: { openai: true, anthropic: false },
      claudeProjectsDir: null,
    });
    expect(config.codexDirs.length).toBeGreaterThan(0);
  });

  it("refuses an empty coding-session provider selection", async () => {
    await expect(runCli(["write-coding-sessions-config"], JSON.stringify({
      apiUrl: "https://api.test",
      userId: "user_2",
      agentToken: "gics_y",
      providers: { openai: false, anthropic: false },
    }))).rejects.toMatchObject({
      stderr: expect.stringContaining("Select at least one Coding Agent Sessions source"),
    });
  });
});

describe("coding-sessions-agent", () => {
  it("uploads structured transcript messages without local usefulness summaries or inferred fields", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    const repoDir = path.join(home, "repo");
    const longCommentary = "commentary ".repeat(500);
    const longFinalAnswer = "final ".repeat(1_000).trim();
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(path.join(codexDir, "session-1.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:00:00.000Z",
        payload: { session_id: "session-1", timestamp: "2026-06-24T10:00:00.000Z", cwd: repoDir },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:01:00.000Z",
        payload: {
          id: "user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix src/app.ts, run npm test, and follow up later." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:02:00.000Z",
        payload: {
          id: "agent-commentary-1",
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: longCommentary }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:03:00.000Z",
        payload: {
          id: "agent-1",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: longFinalAnswer }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-24T10:04:00.000Z",
        payload: { command: "npm test", exit_code: 1, stdout: "failing test suite" },
      }),
    ].join("\n") + "\n");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
    }));

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    const session = ingest.requests[0].sessions[0];
    expect(session).toMatchObject({
      schemaVersion: 2,
      provider: "codex",
      sessionId: "session-1",
      userMessages: [{
        id: "user-1",
        order: 0,
        role: "user",
        text: "Fix src/app.ts, run npm test, and follow up later.",
        timestamp: "2026-06-24T10:01:00.000Z",
        providerType: "message",
        phase: null,
        source: "response_item",
      }],
      agentResponses: [{
        id: "agent-1",
        order: 1,
        role: "assistant",
        text: longFinalAnswer,
        timestamp: "2026-06-24T10:03:00.000Z",
        providerType: "message",
        phase: "final_answer",
        source: "response_item",
      }],
    });
    expect(session.agentResponses.map((message: { id: string }) => message.id)).not.toContain("agent-commentary-1");
    expect(session.agentResponses[0].text.length).toBeGreaterThan(4_000);
    expect(session).not.toHaveProperty("goal");
    expect(session).not.toHaveProperty("summary");
    expect(session).not.toHaveProperty("commands");
    expect(session).not.toHaveProperty("decisions");
    expect(session).not.toHaveProperty("omittedCounts");
  });

  it("selects coding-session files by filesystem mtime", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });

    const writeSession = (sessionId: string, timestamp: string, mtime: string) => {
      const filePath = path.join(codexDir, `${sessionId}.jsonl`);
      writeFileSync(filePath, [
        JSON.stringify({
          type: "session_meta",
          timestamp,
          payload: { session_id: sessionId, timestamp },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            id: `${sessionId}-user`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `User request for ${sessionId}.` }],
          },
        }),
      ].join("\n") + "\n");
      utimesSync(filePath, new Date(mtime), new Date(mtime));
    };

    for (let index = 0; index < 3; index++) {
      writeSession(
        `codex-newer-mtime-${String(index).padStart(3, "0")}`,
        `2026-06-24T10:0${index}:00.000Z`,
        `2026-06-24T18:0${index}:00.000Z`,
      );
    }
    writeSession("codex-newest-low-mtime", "2026-06-24T12:00:00.000Z", "2026-06-24T09:00:00.000Z");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
      actorEmail: "agent@example.com",
      actorName: "Agent",
    }));

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0].sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "codex-newer-mtime-002",
      "codex-newer-mtime-001",
      "codex-newer-mtime-000",
      "codex-newest-low-mtime",
    ]);
  });

  it("honors existing maxFilesPerProvider configs as per-provider mtime caps", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    const claudeDir = path.join(home, ".claude", "projects", "repo");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });

    const writeCodexSession = (sessionId: string, mtime: string) => {
      const timestamp = "2026-06-24T10:00:00.000Z";
      const filePath = path.join(codexDir, `${sessionId}.jsonl`);
      writeFileSync(filePath, [
        JSON.stringify({ type: "session_meta", timestamp, payload: { session_id: sessionId, timestamp } }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            id: `${sessionId}-user`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `User request for ${sessionId}.` }],
          },
        }),
      ].join("\n") + "\n");
      utimesSync(filePath, new Date(mtime), new Date(mtime));
    };

    const writeClaudeSession = (sessionId: string, mtime: string) => {
      const timestamp = "2026-06-24T10:00:00.000Z";
      const filePath = path.join(claudeDir, `${sessionId}.jsonl`);
      writeFileSync(filePath, [
        JSON.stringify({
          type: "user",
          uuid: `${sessionId}-user`,
          sessionId,
          timestamp,
          message: { role: "user", content: `User request for ${sessionId}.` },
        }),
      ].join("\n") + "\n");
      utimesSync(filePath, new Date(mtime), new Date(mtime));
    };

    writeCodexSession("codex-1", "2026-06-24T18:00:00.000Z");
    writeCodexSession("codex-2", "2026-06-24T17:00:00.000Z");
    writeCodexSession("codex-3", "2026-06-24T16:00:00.000Z");
    writeClaudeSession("claude-1", "2026-06-24T19:00:00.000Z");
    writeClaudeSession("claude-2", "2026-06-24T15:00:00.000Z");
    writeClaudeSession("claude-3", "2026-06-24T14:00:00.000Z");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: true },
      codexDirs: [codexDir],
      claudeProjectsDir: path.join(home, ".claude", "projects"),
      maxFilesPerProvider: 2,
    }));

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests[0].sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "claude-1",
      "codex-1",
      "codex-2",
      "claude-2",
    ]);
  });

  it("accepts a server command to force-reupload unchanged parsed sessions", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    const repoDir = path.join(home, "repo");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(path.join(codexDir, "session-1.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:00:00.000Z",
        payload: { session_id: "session-1", timestamp: "2026-06-24T10:00:00.000Z", cwd: repoDir },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:01:00.000Z",
        payload: {
          id: "user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please re-upload this transcript." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:02:00.000Z",
        payload: {
          id: "agent-1",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Re-uploadable final response." }],
        },
      }),
    ].join("\n") + "\n");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
    }));

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
      ingest.commands.push({
        id: "cmd_1",
        type: "force_rescan",
        payload: { maxFiles: 1, providers: ["codex"], force: true },
      });
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.commandRequests).toHaveLength(2);
    expect(ingest.requests).toHaveLength(2);
    expect(ingest.requests[0]).not.toHaveProperty("force");
    expect(ingest.requests[1].force).toBe(true);
    expect(ingest.requests[1].sessions).toHaveLength(1);
    expect(ingest.requests[1].sessions[0]).toMatchObject({
      parserVersion: "visible-transcript-v2",
      provider: "codex",
      sessionId: "session-1",
    });
    expect(ingest.ackRequests).toHaveLength(1);
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_1",
      status: "completed",
      result: expect.objectContaining({
        commandType: "force_rescan",
        force: true,
        selectedForUpload: 1,
        sessionsWithVisibleTranscript: 1,
        userMessages: 1,
        agentResponses: 1,
      }),
    });
  });

  it("handles source_sync commands with a full-inventory receipt instead of a capped rescan", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });

    for (let index = 0; index < 3; index++) {
      const sessionId = `source-sync-${index}`;
      const timestamp = new Date(Date.UTC(2026, 5, 24, 10, index, 0)).toISOString();
      writeFileSync(path.join(codexDir, `${sessionId}.jsonl`), [
        JSON.stringify({
          type: "session_meta",
          timestamp,
          payload: { session_id: sessionId, timestamp },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            id: `${sessionId}-user`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `User request for ${sessionId}.` }],
          },
        }),
      ].join("\n") + "\n");
    }

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
      maxFilesPerProvider: 1,
    }));

    ingest.commands.push({
      id: "cmd_source_sync",
      type: "source_sync",
      payload: {
        sourceSyncRunId: "00000000-0000-4000-8000-000000000123",
        coverageFrom: "2026-01-01T00:00:00.000Z",
        coverageTo: "2026-06-28T22:00:00.000Z",
        maxFiles: 1,
      },
    });

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0].force).toBe(true);
    expect(ingest.requests[0].sessions).toHaveLength(3);
    expect(ingest.ackRequests).toHaveLength(1);
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_source_sync",
      status: "completed",
      result: expect.objectContaining({
        receiptVersion: 1,
        sourceSyncRunId: "00000000-0000-4000-8000-000000000123",
        provider: "coding_sessions",
        coverageFrom: "2026-01-01T00:00:00.000Z",
        coverageTo: "2026-06-28T22:00:00.000Z",
        fullInventory: true,
        exhausted: true,
        capHit: false,
        filesDiscovered: 3,
        filesParsed: 3,
        sessionsSeen: 3,
        sessionsUploaded: 3,
        pendingUploads: 0,
        failedUploads: 0,
        pendingCount: 0,
        failedCount: 0,
      }),
    });
    expect(ingest.ackRequests[0].result.manifestHash).toEqual(expect.any(String));
    expect(ingest.ackRequests[0].result.rootProbes[0]).not.toHaveProperty("path");
    expect(ingest.commandRequests[0].headers["x-shepherd-agent-capabilities"]).toBe("source_sync_receipts");
  });

  it("does not fail source_sync when generated config includes a missing optional Codex archive dir", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(codexDir, "session-1.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:00:00.000Z",
        payload: { session_id: "session-1", timestamp: "2026-06-24T10:00:00.000Z" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:01:00.000Z",
        payload: {
          id: "session-1-user",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Only the primary sessions dir exists." }],
        },
      }),
    ].join("\n") + "\n");

    const ingest = await startIngestServer();
    const { stdout } = await runCli(["write-coding-sessions-config"], JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
    }));
    const configPath = JSON.parse(stdout).configPath;

    ingest.commands.push({
      id: "cmd_source_sync_default_config",
      type: "source_sync",
      payload: {
        sourceSyncRunId: "00000000-0000-4000-8000-000000000128",
        coverageFrom: null,
        coverageTo: "2026-06-28T22:00:00.000Z",
      },
    });

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_source_sync_default_config",
      status: "completed",
      result: expect.objectContaining({
        exhausted: true,
        filesDiscovered: 1,
        parseErrors: 0,
        failedCount: 0,
      }),
    });
  });

  it("reports malformed coding-session JSONL as incomplete source_sync inventory", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(codexDir, "bad-session.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:00:00.000Z",
        payload: { session_id: "bad-session", timestamp: "2026-06-24T10:00:00.000Z" },
      }),
      "{not-json",
    ].join("\n") + "\n");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
    }));

    ingest.commands.push({
      id: "cmd_source_sync_bad_jsonl",
      type: "source_sync",
      payload: {
        sourceSyncRunId: "00000000-0000-4000-8000-000000000125",
        coverageFrom: null,
        coverageTo: "2026-06-28T22:00:00.000Z",
      },
    });

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(0);
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_source_sync_bad_jsonl",
      status: "completed",
      result: expect.objectContaining({
        exhausted: false,
        parseErrors: 1,
        sessionsSeen: 0,
        pendingUploads: 0,
        failedUploads: 0,
        pendingCount: 0,
        failedCount: 1,
      }),
    });
  });

  it("drains existing coding-session retries before completing a source_sync receipt", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(codexDir, "session-1.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:00:00.000Z",
        payload: { session_id: "session-1", timestamp: "2026-06-24T10:00:00.000Z" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:01:00.000Z",
        payload: {
          id: "session-1-user",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Queued retry should drain too." }],
        },
      }),
    ].join("\n") + "\n");

    const queueDir = path.join(home, ".shepherd", "coding-sessions");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(path.join(queueDir, "user-1-queue.json"), JSON.stringify([{
      provider: "codex",
      sessionId: "queued-session",
      sourcePathHash: "queued-path",
      contentHash: "queued-content",
      userMessages: [],
      agentResponses: [],
    }]));

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
    }));

    ingest.commands.push({
      id: "cmd_source_sync_queue",
      type: "source_sync",
      payload: {
        sourceSyncRunId: "00000000-0000-4000-8000-000000000124",
        coverageFrom: null,
        coverageTo: "2026-06-28T22:00:00.000Z",
      },
    });

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0].sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "queued-session",
      "session-1",
    ]);
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_source_sync_queue",
      status: "completed",
      result: expect.objectContaining({
        sessionsSeen: 1,
        sessionsUploaded: 2,
        pendingUploads: 0,
        failedUploads: 0,
        pendingCount: 0,
      }),
    });
    expect(() => readFileSync(path.join(queueDir, "user-1-queue.json"), "utf8")).toThrow();
  });

  it("fails source_sync receipts when the coding-session retry queue is corrupt", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(path.join(codexDir, "session-1.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:00:00.000Z",
        payload: { session_id: "session-1", timestamp: "2026-06-24T10:00:00.000Z" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:01:00.000Z",
        payload: {
          id: "session-1-user",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "A valid session should not hide a corrupt queue." }],
        },
      }),
    ].join("\n") + "\n");

    const queueDir = path.join(home, ".shepherd", "coding-sessions");
    mkdirSync(queueDir, { recursive: true });
    const queueFile = path.join(queueDir, "user-1-queue.json");
    writeFileSync(queueFile, "{not-json");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
    }));

    ingest.commands.push({
      id: "cmd_source_sync_corrupt_queue",
      type: "source_sync",
      payload: {
        sourceSyncRunId: "00000000-0000-4000-8000-000000000126",
        coverageFrom: null,
        coverageTo: "2026-06-28T22:00:00.000Z",
      },
    });

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(0);
    expect(readFileSync(queueFile, "utf8")).toBe("{not-json");
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_source_sync_corrupt_queue",
      status: "failed",
      result: expect.objectContaining({
        exhausted: false,
        sessionsSeen: 1,
        pendingUploads: 1,
        failedUploads: 1,
        pendingCount: 1,
        failedCount: 1,
        sent: expect.objectContaining({
          error: "Coding sessions retry queue could not be read",
        }),
      }),
    });
  });

  it("force-rescans newest files per provider by filesystem mtime for legacy maxFiles commands", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    const claudeDir = path.join(home, ".claude", "projects", "repo");
    const repoDir = path.join(home, "repo");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    const writeCodexSession = (fileName: string, sessionId: string, timestamp: string, mtime: string) => {
      const filePath = path.join(codexDir, fileName);
      writeFileSync(filePath, [
        JSON.stringify({
          type: "session_meta",
          timestamp,
          payload: { session_id: sessionId, timestamp, cwd: repoDir },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            id: `${sessionId}-user`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `User request for ${sessionId}.` }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            id: `${sessionId}-agent`,
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: `Agent response for ${sessionId}.` }],
          },
        }),
      ].join("\n") + "\n");
      utimesSync(filePath, new Date(mtime), new Date(mtime));
    };

    const writeClaudeSession = (fileName: string, sessionId: string, timestamp: string, mtime: string) => {
      const filePath = path.join(claudeDir, fileName);
      writeFileSync(filePath, [
        JSON.stringify({
          type: "user",
          uuid: `${sessionId}-user`,
          sessionId,
          timestamp,
          cwd: repoDir,
          message: { role: "user", content: `User request for ${sessionId}.` },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: `${sessionId}-agent`,
          sessionId,
          timestamp,
          cwd: repoDir,
          message: { role: "assistant", content: [{ type: "text", text: `Agent response for ${sessionId}.` }] },
        }),
      ].join("\n") + "\n");
      utimesSync(filePath, new Date(mtime), new Date(mtime));
    };

    writeCodexSession("01-newest-mtime.jsonl", "codex-newest-mtime", "2026-06-24T10:00:00.000Z", "2026-06-24T18:00:00.000Z");
    writeCodexSession("02-second-mtime.jsonl", "codex-second-mtime", "2026-06-24T12:00:00.000Z", "2026-06-24T17:00:00.000Z");
    writeCodexSession("03-third-mtime.jsonl", "codex-third-mtime", "2026-06-24T16:00:00.000Z", "2026-06-24T08:00:00.000Z");
    writeClaudeSession("04-newest-mtime.jsonl", "claude-newest-mtime", "2026-06-24T11:00:00.000Z", "2026-06-24T19:00:00.000Z");
    writeClaudeSession("05-second-mtime.jsonl", "claude-second-mtime", "2026-06-24T13:00:00.000Z", "2026-06-24T16:00:00.000Z");
    writeClaudeSession("06-third-mtime.jsonl", "claude-third-mtime", "2026-06-24T15:00:00.000Z", "2026-06-24T07:00:00.000Z");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: true },
      codexDirs: [codexDir],
      claudeProjectsDir: path.join(home, ".claude", "projects"),
    }));

    ingest.commands.push({
      id: "cmd_global",
      type: "force_rescan",
      payload: { maxFiles: 2, providers: ["codex", "claude"], force: true },
    });

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0].force).toBe(true);
    expect(ingest.requests[0].sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual([
      "claude-newest-mtime",
      "codex-newest-mtime",
      "codex-second-mtime",
      "claude-second-mtime",
    ]);
    expect(ingest.requests[0].sessions.every((session: { parserVersion?: string }) => session.parserVersion === "visible-transcript-v2")).toBe(true);
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_global",
      status: "completed",
      result: expect.objectContaining({
        filesDiscovered: 6,
        filesParsed: 4,
        capped: true,
        selectedForUpload: 4,
        maxFiles: 2,
        sessionsWithVisibleTranscript: 4,
      }),
    });
  });

  it("force-rescans exactly the newest 100 sessions in forced batches", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    mkdirSync(codexDir, { recursive: true });

    for (let index = 0; index <= 100; index++) {
      const sessionId = `codex-${String(index).padStart(3, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 5, 24, 10, index, 0)).toISOString();
      const filePath = path.join(codexDir, `${sessionId}.jsonl`);
      writeFileSync(filePath, [
        JSON.stringify({
          type: "session_meta",
          timestamp,
          payload: { session_id: sessionId, timestamp },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            id: `${sessionId}-user`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `User request for ${sessionId}.` }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            id: `${sessionId}-agent`,
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: `Agent response for ${sessionId}.` }],
          },
        }),
      ].join("\n") + "\n");
      utimesSync(filePath, new Date(timestamp), new Date(timestamp));
    }

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
      actorEmail: "agent@example.com",
      actorName: "Agent",
    }));
    const queueDir = path.join(home, ".shepherd", "coding-sessions");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(path.join(queueDir, "user-1-queue.json"), JSON.stringify([{
      provider: "codex",
      sessionId: "queued-older-retry",
      sourcePathHash: "queued-older-retry",
      contentHash: "queued-older-retry",
    }]));

    ingest.commands.push({
      id: "cmd_100",
      type: "force_rescan",
      payload: { maxFiles: 100, providers: ["codex"], force: true },
    });

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(2);
    expect(ingest.requests.every((request) => request.force === true)).toBe(true);
    expect(ingest.requests.map((request) => request.sessions.length)).toEqual([50, 50]);
    const uploadedIds = ingest.requests.flatMap((request) => (
      request.sessions.map((session: { sessionId: string }) => session.sessionId)
    ));
    expect(uploadedIds).toHaveLength(100);
    expect(uploadedIds[0]).toBe("codex-100");
    expect(uploadedIds).toContain("codex-001");
    expect(uploadedIds).not.toContain("codex-000");
    expect(uploadedIds).not.toContain("queued-older-retry");
    expect(ingest.ackRequests[0]).toMatchObject({
      id: "cmd_100",
      status: "completed",
      result: expect.objectContaining({
        selectedForUpload: 100,
        maxFiles: 100,
        sessionsWithVisibleTranscript: 100,
      }),
    });
  });

  it("skips separate Codex child agent session files", async () => {
    const codexDir = path.join(home, ".codex", "sessions");
    const repoDir = path.join(home, "repo");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(path.join(codexDir, "root-session.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:00:00.000Z",
        payload: { session_id: "root-session", timestamp: "2026-06-24T10:00:00.000Z", cwd: repoDir },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:01:00.000Z",
        payload: {
          id: "root-user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Summarize the main thread only." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:02:00.000Z",
        payload: {
          id: "root-agent-1",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done from the main thread." }],
        },
      }),
    ].join("\n") + "\n");

    writeFileSync(path.join(codexDir, "child-session.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-24T10:03:00.000Z",
        payload: {
          session_id: "child-session",
          timestamp: "2026-06-24T10:03:00.000Z",
          cwd: repoDir,
          parent_thread_id: "root-session",
          agent_path: ["root-session", "child-session"],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:04:00.000Z",
        payload: {
          id: "child-user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Subagent prompt that should not upload." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-24T10:05:00.000Z",
        payload: {
          id: "child-agent-1",
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Subagent response that should not upload." }],
        },
      }),
    ].join("\n") + "\n");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: true, anthropic: false },
      codexDirs: [codexDir],
      claudeProjectsDir: null,
    }));

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0].sessions).toHaveLength(1);
    expect(ingest.requests[0].sessions[0]).toMatchObject({
      provider: "codex",
      sessionId: "root-session",
    });
  });

  it("skips separate Claude sidechain session files", async () => {
    const claudeDir = path.join(home, ".claude", "projects", "repo");
    const repoDir = path.join(home, "repo");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(path.join(claudeDir, "root-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "root-user-1",
        sessionId: "root-session",
        timestamp: "2026-06-24T10:00:00.000Z",
        cwd: repoDir,
        message: { role: "user", content: "Summarize the visible Claude thread." },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "root-agent-1",
        sessionId: "root-session",
        timestamp: "2026-06-24T10:01:00.000Z",
        cwd: repoDir,
        message: { role: "assistant", content: [{ type: "text", text: "Visible Claude response." }] },
      }),
    ].join("\n") + "\n");

    writeFileSync(path.join(claudeDir, "sidechain-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "side-user-1",
        sessionId: "sidechain-session",
        timestamp: "2026-06-24T10:02:00.000Z",
        cwd: repoDir,
        isSidechain: true,
        message: { role: "user", content: "Sidechain prompt that should not upload." },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "side-agent-1",
        sessionId: "sidechain-session",
        timestamp: "2026-06-24T10:03:00.000Z",
        cwd: repoDir,
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "Sidechain response that should not upload." }] },
      }),
    ].join("\n") + "\n");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: false, anthropic: true },
      codexDirs: [],
      claudeProjectsDir: path.join(home, ".claude", "projects"),
    }));

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0].sessions).toHaveLength(1);
    expect(ingest.requests[0].sessions[0]).toMatchObject({
      provider: "claude",
      sessionId: "root-session",
    });
  });

  it("excludes Claude Agent tool results from visible transcript messages", async () => {
    const claudeDir = path.join(home, ".claude", "projects", "repo");
    const repoDir = path.join(home, "repo");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    writeFileSync(path.join(claudeDir, "root-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "root-user-1",
        sessionId: "root-session",
        timestamp: "2026-06-24T10:00:00.000Z",
        cwd: repoDir,
        message: { role: "user", content: "Use the reviewer agent, then tell me what matters." },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "root-agent-1",
        sessionId: "root-session",
        timestamp: "2026-06-24T10:01:00.000Z",
        cwd: repoDir,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll ask the reviewer agent and keep the main thread focused." },
            { type: "tool_use", id: "toolu_agent", name: "Agent", input: { subagent_type: "reviewer", prompt: "Review the change." } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "root-tool-result-1",
        sessionId: "root-session",
        timestamp: "2026-06-24T10:02:00.000Z",
        cwd: repoDir,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_agent",
            content: [{ type: "text", text: "Subagent transcript/result that should not upload." }],
          }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "root-agent-2",
        sessionId: "root-session",
        timestamp: "2026-06-24T10:03:00.000Z",
        cwd: repoDir,
        message: { role: "assistant", content: [{ type: "text", text: "The important part is ready in the main response." }] },
      }),
    ].join("\n") + "\n");

    const ingest = await startIngestServer();
    const configPath = path.join(home, "coding-sessions.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: ingest.apiUrl,
      userId: "user_1",
      agentToken: "gics_test",
      providers: { openai: false, anthropic: true },
      codexDirs: [],
      claudeProjectsDir: path.join(home, ".claude", "projects"),
    }));

    try {
      await runCli(["coding-sessions-agent", "--config", configPath, "--once"]);
    } finally {
      await ingest.close();
    }

    expect(ingest.requests).toHaveLength(1);
    const session = ingest.requests[0].sessions[0];
    expect(session.userMessages).toEqual([expect.objectContaining({
      role: "user",
      text: "Use the reviewer agent, then tell me what matters.",
    })]);
    expect(session.agentResponses.map((message: { text: string }) => message.text)).toEqual([
      "I'll ask the reviewer agent and keep the main thread focused.",
      "The important part is ready in the main response.",
    ]);
    expect(JSON.stringify(session)).not.toContain("Subagent transcript/result");
  });
});

describe("install-messages-agent --dry-run", () => {
  function writeConfig(userId: string) {
    const configPath = path.join(home, `${userId}.json`);
    writeFileSync(configPath, JSON.stringify({
      apiUrl: "https://api.test",
      userId,
      agentToken: "gimsg_x",
      allChats: false,
      allowedChatIds: ["iMessage;-;+15551234567"],
    }));
    return configPath;
  }

  it("defaults to the npx launcher and appends --config", async () => {
    const configPath = writeConfig("user_1");
    const { stdout } = await runCli(["install-messages-agent", `--config=${configPath}`, "--dry-run"]);
    const install = JSON.parse(stdout);
    expect(install.label).toBe("ai.shepherd.raw-messages.user-1");
    expect(install.programArguments.slice(0, 4)).toEqual(["/usr/bin/env", "npx", "-y", "askshepherd@latest"]);
    expect(install.programArguments.slice(-2)).toEqual(["--config", configPath]);
    expect(install.plist).toContain("<key>ThrottleInterval</key>");
    expect(install.plist).toContain("<key>WorkingDirectory</key>");
  });

  it("honors --program and --env overrides for app-identity installs", async () => {
    const configPath = writeConfig("user_2");
    const program = [
      "/Applications/Shepherd.app/Contents/MacOS/Shepherd",
      "/Applications/Shepherd.app/Contents/Resources/engine/bin/shepherd-onboard.js",
      "messages-agent",
    ];
    const { stdout } = await runCli([
      "install-messages-agent",
      `--config=${configPath}`,
      "--dry-run",
      `--program=${JSON.stringify(program)}`,
      "--env={\"ELECTRON_RUN_AS_NODE\":\"1\"}",
    ]);
    const install = JSON.parse(stdout);
    expect(install.programArguments).toEqual([...program, "--config", configPath]);
    expect(install.environment.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(install.environment.PATH).toBeTruthy();
    expect(install.plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    // XML escaping must hold for arbitrary values.
    expect(install.plist).not.toContain("<string></string>");
  });

  it("rejects malformed --program JSON", async () => {
    const configPath = writeConfig("user_3");
    await expect(runCli([
      "install-messages-agent",
      `--config=${configPath}`,
      "--dry-run",
      "--program=not-json",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--program must be a JSON array of strings"),
    });
  });
});

describe("mcp-install app proxy override", () => {
  it("rejects Cursor as an unsupported MCP target", async () => {
    const stateDir = path.join(home, ".shepherd");
    mkdirSync(stateDir, { recursive: true });
    const statePath = path.join(stateDir, "mcp.json");
    writeFileSync(statePath, JSON.stringify({
      mcpUrl: "https://api.test/mcp",
      token: "token",
      expiresAt: "2999-01-01T00:00:00.000Z",
    }));

    await expect(runCli([
      "mcp-install",
      "--install=cursor",
      "--json",
      `--state=${statePath}`,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown MCP install target \"cursor\""),
    });
  });
});
