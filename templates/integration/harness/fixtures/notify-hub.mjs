// Host-owned API fixture: "Notify Hub", a simulated third-party notification API.
// Runs inside the integration sandbox as the harness uid; configuration arrives
// on stdin (never argv/env of a process the child could read). Simulated side
// effects only — nothing leaves the sandbox.
//
// Quirks it models (all documented in templates/integration/demo/notify-hub/API.md):
//  - cursor pagination with a server-side page cap (maxPageSize) regardless of ?limit
//  - 429 with Retry-After, 503 before commit, and 503 AFTER commit (ack lost)
//  - Idempotency-Key replay (same key+body -> original response; key reuse with a
//    different body -> 422)
//  - bearer auth on every /v1 route
import http from "node:http";
import { createHash } from "node:crypto";

const input = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => resolve(buf));
});
const cfg = JSON.parse(input || "{}");
const port = Number(cfg.port);
const token = String(cfg.token ?? "");
const adminToken = String(cfg.adminToken ?? "");
const maxPageSize = Number(cfg.maxPageSize ?? 10);
const postFailures = [...(cfg.postFailures ?? [])];
const retryAfterSeconds = Number(cfg.retryAfterSeconds ?? 1);

const state = { notifications: [], postAttempts: 0, idempotentReplays: 0, rejectedNoAuth: 0, idempotencyConflicts: 0, listCalls: 0, rateLimited: 0 };
const idem = new Map();
for (let i = 0; i < Number(cfg.seed ?? 0); i++) {
  state.notifications.push({ id: `ntf_${String(i + 1).padStart(4, "0")}`, recipient: `user${(i % 3) + 1}@example.test`, message: `seed ${i + 1}`, created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() });
}
let nextId = state.notifications.length + 1;

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const encodeCursor = (offset) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
const decodeCursor = (c) => {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")).o;
    return Number.isInteger(o) && o >= 0 ? o : null;
  } catch {
    return null;
  }
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.local");
    if (url.pathname === "/__state") {
      if (req.headers["x-fixture-admin"] !== adminToken) return send(res, 403, { error: "forbidden" });
      return send(res, 200, state);
    }
    if (!url.pathname.startsWith("/v1/")) return send(res, 404, { error: "not_found" });
    if (req.headers.authorization !== `Bearer ${token}`) {
      state.rejectedNoAuth++;
      return send(res, 401, { error: "unauthorized", message: "Missing or invalid bearer token" });
    }
    if (req.method === "GET" && url.pathname === "/v1/notifications") {
      state.listCalls++;
      const requested = Number(url.searchParams.get("limit") ?? maxPageSize);
      const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : maxPageSize, maxPageSize));
      const cursor = url.searchParams.get("cursor");
      const offset = cursor ? decodeCursor(cursor) : 0;
      if (offset === null) return send(res, 400, { error: "invalid_cursor" });
      const recipient = url.searchParams.get("recipient");
      const all = recipient ? state.notifications.filter((n) => n.recipient === recipient) : state.notifications;
      const data = all.slice(offset, offset + limit);
      const more = offset + limit < all.length;
      return send(res, 200, { data, has_more: more, next_cursor: more ? encodeCursor(offset + limit) : null });
    }
    const one = url.pathname.match(/^\/v1\/notifications\/(ntf_[0-9]{4,})$/);
    if (req.method === "GET" && one) {
      const n = state.notifications.find((x) => x.id === one[1]);
      return n ? send(res, 200, n) : send(res, 404, { error: "not_found" });
    }
    if (req.method === "POST" && url.pathname === "/v1/notifications") {
      state.postAttempts++;
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      if (typeof body?.recipient !== "string" || typeof body?.message !== "string" || !body.recipient || !body.message) {
        return send(res, 422, { error: "validation_error", message: "recipient and message are required strings" });
      }
      const key = req.headers["idempotency-key"];
      const bodyHash = createHash("sha256").update(JSON.stringify({ r: body.recipient, m: body.message })).digest("hex");
      if (typeof key === "string" && idem.has(key)) {
        const prior = idem.get(key);
        if (prior.bodyHash !== bodyHash) {
          state.idempotencyConflicts++;
          return send(res, 422, { error: "idempotency_key_reused", message: "Idempotency-Key was already used with a different request body" });
        }
        state.idempotentReplays++;
        return send(res, 201, prior.response, { "idempotent-replayed": "true" });
      }
      const failure = postFailures.shift();
      if (failure === "429") {
        state.rateLimited++;
        return send(res, 429, { error: "rate_limited" }, { "retry-after": String(retryAfterSeconds) });
      }
      if (failure === "503_before_commit") return send(res, 503, { error: "unavailable" });
      const created = { id: `ntf_${String(nextId++).padStart(4, "0")}`, recipient: body.recipient, message: body.message, created_at: new Date().toISOString() };
      state.notifications.push(created);
      if (typeof key === "string") idem.set(key, { bodyHash, response: created });
      if (failure === "503_after_commit") return send(res, 503, { error: "unavailable" });
      return send(res, 201, created);
    }
    return send(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    return send(res, 500, { error: "fixture_error", message: String(error?.message ?? error) });
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`fixture listening ${port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
