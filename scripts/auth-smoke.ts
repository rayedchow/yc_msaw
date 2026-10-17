/**
 * Live auth smoke for a deployed (or local) procmem MCP server.
 *
 *   PROCMEM_MCP_URL=https://<host>/mcp npx tsx scripts/auth-smoke.ts
 *   PROCMEM_MCP_URL=... PROCMEM_TEST_ACCESS_TOKEN=<AuthKit access token> npx tsx scripts/auth-smoke.ts
 *
 * Optional env:
 *   PROCMEM_SMOKE_EXPECT_ISSUER   e.g. https://<x>.authkit.app (fail if PRM advertises another AS)
 *   PROCMEM_SMOKE_TOOL            tool to call after tools/list (no arguments), e.g. whoami
 *   PROCMEM_SMOKE_REPORT          output path (default reports/auth-smoke.json)
 *
 * Checks: RFC 9728 protected-resource metadata -> authorization server
 * metadata (RFC 8414 / OIDC discovery) -> JWKS reachable -> unauthenticated
 * MCP initialize is 401 with a resource_metadata challenge -> forged token is
 * 401 -> (with a token) authorized initialize + tools/list via the MCP SDK
 * client. The access token is never printed or written; the report contains
 * only non-secret metadata.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decodeJwt } from "jose";
import { fetchDiscovery } from "../src/auth/config.js";
import { protectedResourceMetadataUrl } from "../src/auth/http.js";

interface Check {
  name: string;
  /** "skipped" checks are neither passes nor failures and never count as authorized proof. */
  status: "pass" | "fail" | "skipped";
  ok: boolean;
  detail?: unknown;
}

const target = process.env.PROCMEM_MCP_URL ?? process.argv[2];
const token = process.env.PROCMEM_TEST_ACCESS_TOKEN?.trim() || undefined;
const expectIssuer = process.env.PROCMEM_SMOKE_EXPECT_ISSUER?.replace(/\/+$/, "");
const toolToCall = process.env.PROCMEM_SMOKE_TOOL;
const reportPath = process.env.PROCMEM_SMOKE_REPORT ?? path.join("reports", "auth-smoke.json");
const checks: Check[] = [];

function redact(text: string): string {
  let out = text;
  if (token) out = out.split(token).join("[redacted-token]");
  return out.replace(/Bearer\s+(?!(?:error|realm|scope|resource_metadata|error_description)=)[A-Za-z0-9._~+\/-]+=*/g, "Bearer [redacted]").replace(/pmk_[A-Za-z0-9_-]+/g, "pmk_[redacted]");
}

function record(name: string, ok: boolean, detail?: unknown): void {
  const safe = detail === undefined ? undefined : JSON.parse(redact(JSON.stringify(detail)));
  checks.push({ name, status: ok ? "pass" : "fail", ok, ...(safe !== undefined && { detail: safe }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${safe !== undefined ? ` ${JSON.stringify(safe)}` : ""}`);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    record(name, false, { error: (error as Error).message });
    return undefined;
  }
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "procmem-auth-smoke", version: "1" } },
  });
}

async function postInitialize(url: string, bearer?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer !== undefined && { authorization: `Bearer ${bearer}` }),
    },
    body: initializeBody(),
    signal: AbortSignal.timeout(15000),
  });
}

async function main(): Promise<void> {
  if (!target) {
    console.error("usage: PROCMEM_MCP_URL=https://<host>/mcp [PROCMEM_TEST_ACCESS_TOKEN=...] npx tsx scripts/auth-smoke.ts");
    process.exitCode = 2;
    return;
  }
  const mcpUrl = new URL(target).href.replace(/\/+$/, "");
  const prmUrl = protectedResourceMetadataUrl(mcpUrl);

  // 1. Protected resource metadata
  const prm = await step("protected_resource_metadata", async () => {
    const res = await fetch(prmUrl, { signal: AbortSignal.timeout(15000) });
    const body = (await res.json()) as { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] };
    const ok = res.ok && body.resource?.replace(/\/+$/, "") === mcpUrl && (body.authorization_servers?.length ?? 0) > 0;
    record("protected_resource_metadata", ok, { url: prmUrl, status: res.status, resource: body.resource, authorization_servers: body.authorization_servers, scopes_supported: body.scopes_supported });
    return body;
  });
  const as = prm?.authorization_servers?.[0]?.replace(/\/+$/, "");
  if (expectIssuer !== undefined) record("authorization_server_expected", as === expectIssuer, { advertised: as, expected: expectIssuer });

  // 2. Authorization server metadata + 3. JWKS
  if (as) {
    const meta = await step("authorization_server_metadata", async () => {
      const doc = await fetchDiscovery(as);
      record("authorization_server_metadata", typeof doc.jwks_uri === "string" && typeof doc.authorization_endpoint === "string", {
        issuer: doc.issuer,
        authorization_endpoint: doc.authorization_endpoint,
        token_endpoint: doc.token_endpoint,
        jwks_uri: doc.jwks_uri,
        registration_endpoint: doc.registration_endpoint ?? null,
        client_id_metadata_document_supported: doc.client_id_metadata_document_supported ?? null,
        code_challenge_methods_supported: doc.code_challenge_methods_supported,
      });
      // MCP clients need DCR or CIMD to obtain a client id without manual setup.
      const dynamicClients = typeof doc.registration_endpoint === "string" || doc.client_id_metadata_document_supported === true;
      record("client_registration_available", dynamicClients, {
        hint: dynamicClients ? undefined : "Enable CIMD (and/or DCR) in WorkOS Dashboard -> Connect -> Configuration",
      });
      return doc;
    });
    if (meta?.jwks_uri) {
      await step("jwks_reachable", async () => {
        const res = await fetch(meta.jwks_uri as string, { signal: AbortSignal.timeout(15000) });
        const body = (await res.json()) as { keys?: Array<{ kid?: string; alg?: string; kty?: string }> };
        const keys = body.keys ?? [];
        record("jwks_reachable", res.ok && keys.length > 0, { status: res.status, keys: keys.map((k) => ({ kid: k.kid, alg: k.alg, kty: k.kty })) });
      });
    }
  }

  // 4. Unauthenticated MCP initialize must be challenged
  await step("unauthenticated_initialize_challenged", async () => {
    const res = await postInitialize(mcpUrl);
    const challenge = res.headers.get("www-authenticate") ?? "";
    record("unauthenticated_initialize_challenged", res.status === 401 && challenge.includes(`resource_metadata="${prmUrl}"`), {
      status: res.status,
      www_authenticate: challenge,
    });
  });

  // 5. Forged token must be rejected
  await step("forged_token_rejected", async () => {
    const forged = ["eyJhbGciOiJSUzI1NiIsImtpZCI6ImZvcmdlZCJ9", Buffer.from(JSON.stringify({ iss: as, aud: mcpUrl, sub: "forged", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url"), "c2ln"].join(".");
    const res = await postInitialize(mcpUrl, forged);
    record("forged_token_rejected", res.status === 401, { status: res.status, www_authenticate: res.headers.get("www-authenticate") });
  });

  // 6. Authorized flow via the real MCP client
  if (token) {
    let claims: Record<string, unknown> = {};
    try {
      claims = token.startsWith("pmk_") ? { kind: "static-key" } : decodeJwt(token);
    } catch {
      claims = { kind: "opaque" };
    }
    const exp = typeof claims.exp === "number" ? claims.exp : undefined;
    record("token_shape", true, {
      iss: claims.iss,
      aud: claims.aud,
      exp_in_s: exp !== undefined ? exp - Math.floor(Date.now() / 1000) : undefined,
      has_org_id: typeof claims.org_id === "string",
      kind: claims.kind ?? "jwt",
    });
    await step("authorized_initialize_tools_list", async () => {
      const client = new Client({ name: "procmem-auth-smoke", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      await client.connect(transport);
      try {
        const tools = await client.listTools();
        record("authorized_initialize_tools_list", true, { server: client.getServerVersion(), tools: tools.tools.map((t) => t.name) });
        if (toolToCall) {
          const result = (await client.callTool({ name: toolToCall, arguments: {} })) as { isError?: boolean; content?: Array<{ text?: string }> };
          const text = (result.content ?? []).map((c) => c.text ?? "").join("").slice(0, 2000);
          record(`authorized_tools_call:${toolToCall}`, result.isError !== true, { text });
        }
      } finally {
        await client.close();
      }
    });
  } else {
    checks.push({ name: "authorized_initialize_tools_list", status: "skipped", ok: false, detail: { reason: "PROCMEM_TEST_ACCESS_TOKEN not set" } });
    console.log("SKIP authorized_initialize_tools_list (no access token supplied; NOT an authorized pass)");
  }

  const ran = checks.filter((c) => c.status !== "skipped");
  const authorized = checks.find((c) => c.name === "authorized_initialize_tools_list");
  const report = {
    target: mcpUrl,
    at: new Date().toISOString(),
    tokenProvided: token !== undefined,
    // ok = every check that ran passed. fullyAuthenticated is true only when a real
    // access token completed initialize + tools/list; otherwise this is metadata/challenge-only evidence.
    ok: ran.every((c) => c.ok),
    fullyAuthenticated: authorized?.status === "pass",
    metadataOnly: authorized?.status !== "pass",
    skipped: checks.filter((c) => c.status === "skipped").map((c) => c.name),
    checks,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${redact(JSON.stringify(report, null, 2))}\n`);
  console.log(`${report.ok ? "OK" : "FAILED"}${report.metadataOnly ? " (metadata/challenge only; no authorized call)" : " (authorized call verified)"} -> ${reportPath}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(redact(String((error as Error)?.stack ?? error)));
  process.exitCode = 1;
});
