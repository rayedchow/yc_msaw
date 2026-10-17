import { test } from "node:test";
import assert from "node:assert/strict";
import { NotifyHubClient } from "../src/client.ts";
import { createSimulatedFetch } from "../src/simulated-upstream.ts";

const noSleep = async () => {};
function mk(cfg: Parameters<typeof createSimulatedFetch>[0]) {
  const calls: Array<{ method: string; url: string; key: string | null }> = [];
  const sim = createSimulatedFetch(cfg);
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), key: new Headers(init?.headers).get("idempotency-key") });
    return sim(input, init);
  }) as typeof fetch;
  return { client: new NotifyHubClient({ baseUrl: "https://sim.invalid", token: "t", fetchImpl, sleep: noSleep }), calls };
}

test("follows cursors past the server page cap", async () => {
  const { client } = mk({ seed: 25, maxPageSize: 10 });
  const r = await client.listAll();
  assert.equal(r.items.length, 25);
  assert.equal(r.pages, 3);
  assert.equal(new Set(r.items.map((n) => n.id)).size, 25);
});

test("recipient filter paginates too", async () => {
  const { client } = mk({ seed: 30, maxPageSize: 4 });
  assert.equal((await client.listAll({ recipient: "user2@example.test" })).items.length, 10);
});

test("a 503 after commit is retried with the same idempotency key and does not duplicate", async () => {
  const { client, calls } = mk({ seed: 0, postFailures: ["503_after_commit"] });
  const r = await client.send({ recipient: "a@example.test", message: "hi" });
  assert.equal(r.attempts, 2);
  assert.equal(r.replayed, true);
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(new Set(posts.map((p) => p.key)).size, 1);
  assert.equal((await client.listAll()).items.length, 1);
});

test("429 then 503-before-commit then success", async () => {
  const { client } = mk({ seed: 0, postFailures: ["429", "503_before_commit"] });
  const r = await client.send({ recipient: "a@example.test", message: "hi" });
  assert.equal(r.attempts, 3);
  assert.equal((await client.listAll()).items.length, 1);
});

test("caller-supplied idempotency key replays a repeated logical send", async () => {
  const { client } = mk({ seed: 0 });
  const a = await client.send({ recipient: "a@example.test", message: "hi", idempotencyKey: "logical-send-1" });
  const b = await client.send({ recipient: "a@example.test", message: "hi", idempotencyKey: "logical-send-1" });
  assert.equal(a.notification.id, b.notification.id);
  assert.equal(b.replayed, true);
  assert.equal((await client.listAll()).items.length, 1);
});
