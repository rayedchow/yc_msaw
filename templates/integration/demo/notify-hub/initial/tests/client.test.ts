import { test } from "node:test";
import assert from "node:assert/strict";
import { NotifyHubClient } from "../src/client.ts";
import { createSimulatedFetch } from "../src/simulated-upstream.ts";

const mk = (cfg: Parameters<typeof createSimulatedFetch>[0]) => new NotifyHubClient({ baseUrl: "https://sim.invalid", token: "t", fetchImpl: createSimulatedFetch(cfg) });

test("lists notifications", async () => {
  const r = await mk({ seed: 3 }).listAll();
  assert.equal(r.items.length, 3);
});

test("sends a notification", async () => {
  const c = mk({ seed: 0 });
  const r = await c.send({ recipient: "a@example.test", message: "hi" });
  assert.match(r.notification.id, /^ntf_/);
});
