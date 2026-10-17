import { test } from "node:test";
import assert from "node:assert/strict";
import manifest from "../integration.json" with { type: "json" };

test("manifest declares at least one tool and a smoke case", () => {
  assert.ok(manifest.tools.length > 0);
  assert.ok(manifest.smoke.length > 0);
});
