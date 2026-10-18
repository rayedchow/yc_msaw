/** Minimal raw HTTP client: forwards method/path/query/body unchanged, injects auth, returns status/headers/body. */
export interface RawResponse {
  http_status: number;
  request_id: string | null;
  headers: Record<string, string>;
  body: unknown;
}

const KEEP_HEADERS = ["content-type", "x-fixture-request-id", "x-hubspot-correlation-id", "x-request-id", "retry-after", "location"];

export async function rawRequest(
  opts: { baseUrl: string; authHeaders: Record<string, string>; fetchImpl?: typeof fetch },
  req: { method: string; path: string; query?: Record<string, unknown>; body?: unknown },
): Promise<RawResponse> {
  const url = new URL(opts.baseUrl.replace(/\/+$/, "") + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
    else url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const hasBody = req.body !== undefined && req.method !== "GET";
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: req.method,
    headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}), ...opts.authHeaders },
    ...(hasBody ? { body: typeof req.body === "string" ? req.body : JSON.stringify(req.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const headers: Record<string, string> = {};
  for (const h of KEEP_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  return { http_status: res.status, request_id: res.headers.get("x-fixture-request-id") ?? res.headers.get("x-hubspot-correlation-id") ?? res.headers.get("x-request-id"), headers, body };
}
