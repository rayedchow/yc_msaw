/**
 * In-process simulation of the Notify Hub API (NOTIFY_HUB_SIMULATED=1) for the hosted
 * demo: same pagination cap, lost-ack 503, 429 and idempotency semantics as the
 * documented API. Simulated side effects only; nothing leaves the process.
 */
import { createHash } from "node:crypto";

export function createSimulatedFetch(cfg: { seed?: number; maxPageSize?: number; postFailures?: string[] } = {}): typeof fetch {
  const maxPageSize = cfg.maxPageSize ?? 10;
  const failures = [...(cfg.postFailures ?? [])];
  const items: Array<{ id: string; recipient: string; message: string; created_at: string }> = [];
  const idem = new Map<string, { bodyHash: string; response: unknown }>();
  for (let i = 0; i < (cfg.seed ?? 0); i++) items.push({ id: `ntf_${String(i + 1).padStart(4, "0")}`, recipient: `user${(i % 3) + 1}@example.test`, message: `seed ${i + 1}`, created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
  let next = items.length + 1;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname === "/v1/notifications") {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? maxPageSize) || maxPageSize, maxPageSize));
      const cursor = url.searchParams.get("cursor");
      const offset = cursor ? Number(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).o) : 0;
      const recipient = url.searchParams.get("recipient");
      const all = recipient ? items.filter((n) => n.recipient === recipient) : items;
      const more = offset + limit < all.length;
      return reply(200, { data: all.slice(offset, offset + limit), has_more: more, next_cursor: more ? Buffer.from(JSON.stringify({ o: offset + limit })).toString("base64url") : null });
    }
    const one = url.pathname.match(/^\/v1\/notifications\/(ntf_[0-9]{4,})$/);
    if (method === "GET" && one) {
      const n = items.find((x) => x.id === one[1]);
      return n ? reply(200, n) : reply(404, { error: "not_found" });
    }
    if (method === "POST" && url.pathname === "/v1/notifications") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (typeof body.recipient !== "string" || typeof body.message !== "string") return reply(422, { error: "validation_error" });
      const headers = new Headers(init?.headers);
      const key = headers.get("idempotency-key");
      const bodyHash = createHash("sha256").update(JSON.stringify({ r: body.recipient, m: body.message })).digest("hex");
      if (key && idem.has(key)) {
        const prior = idem.get(key)!;
        if (prior.bodyHash !== bodyHash) return reply(422, { error: "idempotency_key_reused" });
        return reply(201, prior.response, { "idempotent-replayed": "true" });
      }
      const f = failures.shift();
      if (f === "429") return reply(429, { error: "rate_limited" }, { "retry-after": "1" });
      if (f === "503_before_commit") return reply(503, { error: "unavailable" });
      const created = { id: `ntf_${String(next++).padStart(4, "0")}`, recipient: body.recipient, message: body.message, created_at: new Date().toISOString() };
      items.push(created);
      if (key) idem.set(key, { bodyHash, response: created });
      if (f === "503_after_commit") return reply(503, { error: "unavailable" });
      return reply(201, created);
    }
    return reply(404, { error: "not_found" });
  }) as typeof fetch;
}
