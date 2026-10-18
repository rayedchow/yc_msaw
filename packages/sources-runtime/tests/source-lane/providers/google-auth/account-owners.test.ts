import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.SOURCES_RUNTIME_PUBLIC_URL = "https://runtime.example.test";
  delete process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON;
  delete process.env.GOOGLE_DWD_TENANT_APPROVALS;
});

vi.mock("../../../../src/db/client.js", async () => {
  const { createGoogleAuthTestDb } = await import("./pglite-db.js");
  const { client, db } = await createGoogleAuthTestDb();
  return { db, pgClient: null, __pglite: client };
});

import * as dbClient from "../../../../src/db/client.js";
import type { PGlite } from "@electric-sql/pglite";
import { completeGoogleOAuthCallback, launchGoogleAuthorization, resetGoogleOAuthStateForTests, startGoogleOAuthAuthorization } from "../../../../src/vault/google-oauth.js";
import { resetGoogleRateLimitCooldownsForTests } from "../../../../src/vault/google-rate-limit.js";
import { GOOGLE_UNATTRIBUTED_ACCOUNT, googleAccountOwners, googleAuthProvider } from "../../../../src/source-lane/providers/google-auth/index.js";
import { fakeGoogle } from "./fake-google.js";
import { resetGoogleAuthTables } from "./pglite-db.js";

/**
 * Account owners reported to yc_msaw (owner-only personal sources, yc_msaw src/sources/access.ts): the owner
 * of a Google address is the yc_msaw principal whose OAuth grant Google confirmed for exactly that address.
 */
const pg = (dbClient as unknown as { __pglite: PGlite }).__pglite;
const ADA = { subject: "user_ada", issuer: "https://auth.example.test", email: "ada@corp.example" };
const db = dbClient.db as never;

describe("Google account owners", () => {
  let fake: ReturnType<typeof fakeGoogle>;
  beforeEach(async () => {
    await resetGoogleAuthTables(pg);
    resetGoogleOAuthStateForTests();
    resetGoogleRateLimitCooldownsForTests();
    fake = fakeGoogle();
    vi.stubGlobal("fetch", fake.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names the principal of the verified OAuth grant, no owner for DWD-only mailboxes, and flags unattributed data", async () => {
    const start = await startGoogleOAuthAuthorization({ tenantId: "tenant-a", principal: ADA });
    const state = new URL(start.launchUrl).searchParams.get("state")!;
    const launch = await launchGoogleAuthorization(state);
    fake.authorize(launch.redirectUrl);
    await completeGoogleOAuthCallback({ state, code: "4/synthetic-code", bindingCookie: launch.bindingCookie });
    await pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ('tenant-a', 'google', 'dwd-only@corp.example', 'active')`);
    await pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ('tenant-b', 'google', 'other@corp.example', 'active')`);

    const owners = await googleAccountOwners("tenant-a", db);
    expect(owners.sort((a, b) => a.account.localeCompare(b.account))).toEqual([
      { account: "ada@corp.example", subject: "user_ada", issuer: "https://auth.example.test" },
      { account: "dwd-only@corp.example", subject: null, issuer: null },
    ]);
    expect(await googleAuthProvider.accountOwners!({ tenantId: "tenant-a", executor: db })).toHaveLength(2);

    // A donor tenant-wide Google connection carries no mailbox: its data cannot be attributed to anyone.
    await pg.query(`INSERT INTO connections (tenant_id, provider, external_account_id, status) VALUES ('tenant-c', 'google', NULL, 'active')`);
    expect(await googleAccountOwners("tenant-c", db)).toEqual([{ account: GOOGLE_UNATTRIBUTED_ACCOUNT, subject: null, issuer: null }]);
  });
});
