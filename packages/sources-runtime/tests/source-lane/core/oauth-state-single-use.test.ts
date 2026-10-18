import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://localhost:5432/unused";
  process.env.ENCRYPTION_KEY ??= "synthetic-encryption-key-for-tests";
  process.env.API_KEY_PEPPER ??= "synthetic-api-key-pepper";
  process.env.SLACK_CLIENT_ID = "synthetic-slack-client";
  process.env.SLACK_CLIENT_SECRET = "synthetic-slack-secret";
  process.env.SLACK_REDIRECT_URI = "https://runtime.example.test/slack/callback";
});

vi.mock("../../../src/db/client.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const pg = new PGlite();
  return { db: drizzle(pg), pgClient: null, __pg: pg };
});

import * as dbClient from "../../../src/db/client.js";
import { MIGRATIONS_DIR } from "../../../src/source-lane/core/migrations.js";
import { consumeOAuthStateOnce } from "../../../src/source-lane/core/oauth-state.js";
import { createSlackOAuthState } from "../../../src/integrations/slack/connect.js";
import { slackCallbackRoute } from "../../../src/routes/slack-callback.js";

/** final-audit L3: a donor HMAC OAuth state (Slack, Notion) is accepted once, not until it expires. */
const pg = (dbClient as unknown as { __pg: { exec(sql: string): Promise<unknown> } }).__pg;

beforeAll(async () => {
  await pg.exec(readFileSync(join(MIGRATIONS_DIR, "10300_oauth_state_single_use.sql"), "utf8"));
});
afterEach(() => vi.unstubAllGlobals());

describe("single-use OAuth state", () => {
  it("accepts a state once per value", async () => {
    expect(await consumeOAuthStateOnce(dbClient.db as never, "slack", "s-1")).toBe(true);
    expect(await consumeOAuthStateOnce(dbClient.db as never, "slack", "s-1")).toBe(false);
    expect(await consumeOAuthStateOnce(dbClient.db as never, "notion", "s-2")).toBe(true);
  });

  it("refuses a replayed Slack callback before contacting Slack", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: false, error: "invalid_code" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const state = createSlackOAuthState("tenant-l3");
    const first = await slackCallbackRoute.request(`/?code=c1&state=${encodeURIComponent(state)}`);
    expect(first.status).not.toBe(200); // the synthetic code is refused by the fake Slack, but the state is spent
    expect(calls.filter((u) => u.includes("oauth.v2.access"))).toHaveLength(1);
    const replay = await slackCallbackRoute.request(`/?code=c2&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("Invalid or expired request");
    expect(calls.filter((u) => u.includes("oauth.v2.access"))).toHaveLength(1);
  });
});
