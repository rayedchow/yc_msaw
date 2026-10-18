import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.COMPOSIO_API_KEY = "synthetic-composio-key";
  process.env.COMPOSIO_API_BASE_URL = "https://composio.example.test";
  process.env.COMPOSIO_GOOGLE_AUTH_CONFIG_ID = "ac_google_super";
  process.env.COMPOSIO_GOOGLE_GMAIL_AUTH_CONFIG_ID = "ac_gmail";
  process.env.SOURCES_RUNTIME_PUBLIC_URL = "https://runtime.example.test";
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON;
});

vi.mock("../../../../src/db/client.js", async () => {
  const { createGoogleAuthTestDb } = await import("./pglite-db.js");
  const { client, db } = await createGoogleAuthTestDb();
  return { db, pgClient: null, __pglite: client };
});

import * as dbClient from "../../../../src/db/client.js";
import type { PGlite } from "@electric-sql/pglite";
import {
  fetchGoogleApi,
  getGoogleAccessToken,
  getGoogleApiCredential,
  GoogleBearerUnavailableError,
  GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES,
} from "../../../../src/vault/google-auth.js";
import {
  completeGoogleComposioCallback,
  googleComposioUserId,
  startGoogleComposioAuthorization,
} from "../../../../src/vault/google-composio.js";
import { launchGoogleAuthorization } from "../../../../src/vault/google-oauth.js";
import { resetGoogleAuthTables } from "./pglite-db.js";

const pg = (dbClient as unknown as { __pglite: PGlite }).__pglite;
const ADA = { subject: "user_ada", issuer: "https://auth.example.test", email: "ada@corp.example" };

function fakeComposio(account: { status?: string; userId?: string | null; authConfigId?: string; email?: string } = {}) {
  const calls: Array<{ url: string; method: string; json: any; headers: Headers }> = [];
  let linkUserId: string | null = null;
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", json, headers: new Headers(init.headers) });
    if (url === "https://composio.example.test/api/v3/connected_accounts/link") {
      linkUserId = json.user_id;
      return Response.json({ redirect_url: "https://connect.composio.example/link/lk_synthetic", connected_account_id: "ca_synthetic_1", link_token: "lk_synthetic" });
    }
    if (url === "https://composio.example.test/api/v3/connected_accounts/ca_synthetic_1") {
      return Response.json({
        id: "ca_synthetic_1",
        status: account.status ?? "ACTIVE",
        user_id: account.userId === undefined ? linkUserId : account.userId,
        auth_config: { id: account.authConfigId ?? "ac_google_super" },
        toolkit: { slug: "googlesuper" },
      });
    }
    if (url === "https://composio.example.test/api/v3/tools/execute/proxy") {
      if (json.endpoint === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
        return Response.json({ data: { emailAddress: account.email ?? "ada@corp.example", historyId: "9" }, status: 200, headers: {} });
      }
      if (json.endpoint.includes("/rate-limited")) {
        return Response.json({ data: { error: { code: 429 } }, status: 429, headers: { "retry-after": "17" } });
      }
      if (json.endpoint.includes("/export")) {
        return Response.json({ binary_data: { url: "https://files.composio.example/blob/1" }, status: 200 });
      }
    }
    if (url === "https://files.composio.example/blob/1") {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

async function startAndLaunch(tenantId = "tenant-a") {
  const start = await startGoogleComposioAuthorization({ tenantId, principal: ADA });
  const state = new URL(start.launchUrl).searchParams.get("state")!;
  const launch = await launchGoogleAuthorization(state);
  return { start, state, launch };
}

describe("Composio proxy lane (composio_proxy)", () => {
  let fake: ReturnType<typeof fakeComposio>;

  beforeEach(async () => {
    await resetGoogleAuthTables(pg);
    fake = fakeComposio();
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates a tenant+principal scoped Composio user and redirects through the launch step", async () => {
    const { launch } = await startAndLaunch();
    const link = fake.calls[0];
    expect(link.headers.get("x-api-key")).toBe("synthetic-composio-key");
    expect(link.json.user_id).toBe(googleComposioUserId("tenant-a", ADA));
    expect(link.json.user_id).not.toContain("user_ada");
    expect(link.json.callback_url).toMatch(/^https:\/\/runtime\.example\.test\/auth\/google\/composio\/callback\?state=/);
    expect(launch.redirectUrl).toBe("https://connect.composio.example/link/lk_synthetic");
    // The Composio link token is cleared from storage once launched.
    const [row] = (await pg.query<{ composio_redirect_url: string | null }>("SELECT composio_redirect_url FROM google_oauth_states")).rows;
    expect(row.composio_redirect_url).toBeNull();
  });

  it("verifies the account server-side and never hands a bearer to direct callers", async () => {
    const { state, launch } = await startAndLaunch();
    const account = await completeGoogleComposioCallback({ state, connectedAccountId: "ca_synthetic_1", bindingCookie: launch.bindingCookie });
    expect(account).toMatchObject({ tenantId: "tenant-a", mode: "composio_proxy", email: "ada@corp.example" });
    expect(fake.calls.some((c) => c.url.endsWith("/connected_accounts/ca_synthetic_1") && c.method === "GET")).toBe(true);

    const err = await getGoogleAccessToken("tenant-a", "ada@corp.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleBearerUnavailableError);
    const credential = await getGoogleApiCredential("tenant-a", "ada@corp.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);
    expect(credential).toMatchObject({ kind: "composio_proxy", connectedAccountId: "ca_synthetic_1", account: "ada@corp.example" });
  });

  it("rejects a callback naming a connected account that was not initiated for this state/tenant", async () => {
    const { state, launch } = await startAndLaunch();
    await expect(completeGoogleComposioCallback({ state, connectedAccountId: "ca_someone_else", bindingCookie: launch.bindingCookie }))
      .rejects.toMatchObject({ code: "invalid_state" });
    expect(fake.calls.some((c) => c.url.includes("/connected_accounts/ca_"))).toBe(false);
    expect((await pg.query("SELECT * FROM google_oauth_grants")).rows).toHaveLength(0);
  });

  it.each([
    ["not ACTIVE", { status: "INITIATED" }, "access_denied"],
    ["another Composio user", { userId: "procmem:tenant-b:deadbeef" }, "account_mismatch"],
    ["another auth config", { authConfigId: "ac_attacker" }, "account_mismatch"],
    ["another Google account", { email: "mallory@other.example" }, "account_mismatch"],
  ])("rejects a Composio account that is %s", async (_label, account, code) => {
    fake = fakeComposio(account);
    vi.stubGlobal("fetch", fake.fetch);
    const { state, launch } = await startAndLaunch();
    await expect(completeGoogleComposioCallback({ state, connectedAccountId: "ca_synthetic_1", bindingCookie: launch.bindingCookie }))
      .rejects.toMatchObject({ code });
    expect((await pg.query("SELECT * FROM google_oauth_grants")).rows).toHaveLength(0);
  });

  it("cannot be replayed and binds a connected account to only one tenant", async () => {
    const a = await startAndLaunch("tenant-a");
    await completeGoogleComposioCallback({ state: a.state, connectedAccountId: "ca_synthetic_1", bindingCookie: a.launch.bindingCookie });
    await expect(completeGoogleComposioCallback({ state: a.state, connectedAccountId: "ca_synthetic_1", bindingCookie: a.launch.bindingCookie }))
      .rejects.toMatchObject({ code: "invalid_state" });
    // Same Composio account id surfacing for another tenant's flow is refused by the unique binding.
    const b = await startAndLaunch("tenant-b");
    await expect(completeGoogleComposioCallback({ state: b.state, connectedAccountId: "ca_synthetic_1", bindingCookie: b.launch.bindingCookie }))
      .rejects.toThrow();
    const rows = (await pg.query<{ tenant_id: string }>("SELECT tenant_id FROM google_oauth_grants")).rows;
    expect(rows).toEqual([{ tenant_id: "tenant-a" }]);
  });

  it("fetchGoogleApi proxies with v3 header params, passes upstream Retry-After and keeps binaries as bytes", async () => {
    const { state, launch } = await startAndLaunch();
    await completeGoogleComposioCallback({ state, connectedAccountId: "ca_synthetic_1", bindingCookie: launch.bindingCookie });
    const credential = await getGoogleApiCredential("tenant-a", "ada@corp.example", GOOGLE_GMAIL_READONLY_DELEGATION_SCOPES);

    const limited = await fetchGoogleApi(credential, "https://gmail.googleapis.com/gmail/v1/users/me/rate-limited", { headers: { Authorization: "Bearer leak", Accept: "application/json" } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");
    const proxyCall = fake.calls.filter((c) => c.url.endsWith("/tools/execute/proxy")).at(-1)!;
    expect(proxyCall.json.parameters).toEqual(expect.arrayContaining([
      { name: "accept", value: "application/json", type: "header" },
      expect.objectContaining({ name: "x-goog-quota-user", type: "header" }),
    ]));
    expect(JSON.stringify(proxyCall.json)).not.toContain("leak");

    const pdf = await fetchGoogleApi(credential, "https://www.googleapis.com/drive/v3/files/f1/export?mimeType=application/pdf");
    expect(new Uint8Array(await pdf.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
  });
});
