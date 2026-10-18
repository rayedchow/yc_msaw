import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

import { setConnectionStatus, upsertConnection } from "../../src/db/connections.js";

describe("connection helpers", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  it("upserts on tenant, provider, and coalesced external account", async () => {
    await upsertConnection({
      tenantId: "t1",
      provider: "google",
      externalAccountId: "admin@example.com",
      status: "active",
      metadata: { authMode: "domain_wide_delegation" },
    });

    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("INSERT INTO connections");
    expect(parts).toContain("ON CONFLICT (tenant_id, provider, (COALESCE(external_account_id, ''))) DO UPDATE");
    expect(parts).toContain("metadata = EXCLUDED.metadata");
    expect(sqlParams(executeMock.mock.calls[0][0])).toEqual([
      "t1",
      "google",
      "admin@example.com",
      "active",
      "{\"authMode\":\"domain_wide_delegation\"}",
    ]);
  });

  it("updates all provider connections when no external account is supplied", async () => {
    await setConnectionStatus("t1", "google", "revoked");

    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("UPDATE connections");
    expect(parts).toContain("provider =");
    expect(parts).not.toContain("COALESCE(external_account_id");
  });

  it("can scope a status update to one external account", async () => {
    await setConnectionStatus("t1", "google", "paused", "admin@example.com");

    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("COALESCE(external_account_id, '') =");
    expect(sqlParams(executeMock.mock.calls[0][0])).toContain("admin@example.com");
  });
});

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function sqlParams(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return [chunk];
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk);
    if (Array.isArray(chunk.value)) return [];
    if ("value" in chunk) return [chunk.value];
    return [];
  });
}
