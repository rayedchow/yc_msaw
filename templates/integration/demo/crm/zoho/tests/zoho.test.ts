// Unit tests with a FAKE fetch (no network in the sandbox).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rawRequest } from "../src/client.ts";

test("forwards method/path/query/body unchanged and injects auth", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "x-fixture-request-id": "req-1" } });
  }) as unknown as typeof fetch;
  const r = await rawRequest({ baseUrl: "http://127.0.0.1:9/", authHeaders: { "x-test": "t" }, fetchImpl }, { method: "POST", path: "/crm/v8/x", query: { a: 1 }, body: { b: 2 } });
  assert.equal(r.http_status, 201);
  assert.equal(r.request_id, "req-1");
  assert.ok(seen!.url.endsWith("?a=1"));
  assert.equal((seen!.init.headers as Record<string, string>)["x-test"], "t");
  assert.equal(seen!.init.body, JSON.stringify({ b: 2 }));
});
