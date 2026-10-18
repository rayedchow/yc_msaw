/**
 * A separate legacy Google Docs worker process for durable-cooldown-pg.test.ts: fresh memory (no in-process cooldown),
 * the real gFetch / fetchDocContent, DATABASE_URL pointing at the test's throwaway database. Google hosts are routed to
 * the test's local fake (GOOGLE_FAKE_ORIGIN). argv[2] is a JSON list of calls; one JSON result line per call.
 */
const fake = process.env.GOOGLE_FAKE_ORIGIN!;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  return realFetch(`${fake}${url.pathname}${url.search}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-google-host": url.host } });
}) as typeof fetch;

const { gFetch } = await import("../../../../../src/polling/_archived-gdocs/gdocs-api.js");
const { fetchDocContent } = await import("../../../../../src/integrations/google/gdocs/content.js");

type Call = { kind: "gfetch"; url: string; token: string } | { kind: "content"; docId: string; token: string };
const out: unknown[] = [];
for (const call of JSON.parse(process.argv[2]!) as Call[]) {
  try {
    if (call.kind === "gfetch") out.push({ ok: true, status: (await gFetch(call.url, call.token)).status });
    else out.push({ ok: true, title: (await fetchDocContent("unused", call.docId, call.token)).title ?? null });
  } catch (err) {
    const e = err as { name?: string; service?: string; reason?: string; retryAfterSeconds?: number; message?: string };
    out.push({ ok: false, name: e.name, service: e.service, reason: e.reason, retryAfterSeconds: e.retryAfterSeconds, message: e.name ? undefined : e.message });
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
