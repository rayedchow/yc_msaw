/**
 * A separate legacy Google Docs worker process for legacy-gdocs-durable-cooldown-pg.test.ts: fresh memory (no
 * in-process cooldown, no cached delegation token), the real gFetch / fetchDocContent / getGoogleAccessToken / Google
 * task handlers, DATABASE_URL pointing at the test's throwaway database. Google hosts (including the DWD token
 * endpoint) are routed to the test's local fake (GOOGLE_FAKE_ORIGIN). argv[2] is a JSON list of calls; the process
 * prints one JSON array with a result per call.
 */
const fake = process.env.GOOGLE_FAKE_ORIGIN!;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith("googleapis.com")) return realFetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set("x-google-host", url.host);
  return realFetch(`${fake}${url.pathname}${url.search}`, { ...init, headers });
}) as typeof fetch;

const { gFetch } = await import("../../../../../src/polling/_archived-gdocs/gdocs-api.js");
const { fetchDocContent } = await import("../../../../../src/integrations/google/gdocs/content.js");
const { getGoogleAccessToken, GOOGLE_DOCS_DELEGATION_SCOPES } = await import("../../../../../src/vault/google-auth.js");

type Call =
  | { kind: "gfetch"; url: string; token: string }
  | { kind: "content"; docId: string; token: string }
  | { kind: "dwd"; tenantId: string; mailbox: string; url: string }
  | { kind: "connect"; tenantId: string; mailbox: string }
  | { kind: "task"; taskKind: string; payload: Record<string, unknown>; task: Record<string, unknown> };

const out: unknown[] = [];
for (const call of JSON.parse(process.argv[2]!) as Call[]) {
  try {
    if (call.kind === "gfetch") out.push({ ok: true, status: (await gFetch(call.url, call.token)).status });
    else if (call.kind === "content") out.push({ ok: true, title: (await fetchDocContent("unused", call.docId, call.token)).title ?? null });
    else if (call.kind === "dwd") {
      const token = await getGoogleAccessToken(call.tenantId, call.mailbox, GOOGLE_DOCS_DELEGATION_SCOPES);
      out.push({ ok: true, status: (await gFetch(call.url, token)).status });
    } else if (call.kind === "connect") {
      const { storeToken } = await import("../../../../../src/vault/tokens.js");
      await storeToken(call.tenantId, "google", "dwd-placeholder", { delegation: true, authMode: "domain_wide_delegation", email: call.mailbox });
      out.push({ ok: true });
    } else {
      const { googleIntegration } = await import("../../../../../src/integrations/google/index.js");
      const handler = googleIntegration.taskHandlers!()[call.taskKind]!;
      out.push({ ok: true, result: await handler(call.payload, { task: call.task as never, heartbeat: async () => {} }) });
    }
  } catch (err) {
    const e = err as { name?: string; service?: string; reason?: string; retryAfterSeconds?: number; message?: string };
    out.push({ ok: false, name: e.name, service: e.service, reason: e.reason, retryAfterSeconds: e.retryAfterSeconds, message: e.name === "GoogleRateLimitError" ? undefined : e.message });
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
