/**
 * McpConnection per-operation failure routing over a REAL MCP connection (official client <-> SIMULATED child MCP on
 * loopback with real EdDSA child tokens). Two concurrent operations on ONE connection:
 *   A: a mutating tools/call whose handler executes, waits, then the connection drops  -> ConnectionError "ambiguous"
 *   B: started while A is in flight; its bearer() throws a credential error            -> that credential error (not sent)
 * A must never inherit B's credential failure (which would mislabel an executed mutation as "not executed").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateChildAuthKeys, mintChildToken } from "../src/integrations/child-auth.js";
import { ConnectionError, McpConnection } from "../src/sdk/live/connection.js";
import { ParentCredentialError } from "../src/sdk/live/parent.js";
import { echoTool, SimulatedChild } from "../scripts/sdk-live-tools-fixtures.js";

const keys = generateChildAuthKeys();
const ns = "tenant-conn";
let child: SimulatedChild;
let release: () => void = () => undefined;
const gate = () => new Promise<void>((r) => (release = r));

beforeAll(async () => {
  child = new SimulatedChild(keys, ns, "conn", [
    echoTool("echo"),
    {
      tool: { name: "charge", description: "Mutating (simulated).", inputSchema: { type: "object", properties: {} } },
      handler: async (_a, ctl) => {
        await gate();
        ctl.dropConnection();
        return { content: [{ type: "text", text: "charged" }] };
      },
    },
  ]);
  await child.start();
});

afterAll(async () => {
  await child?.close();
});

describe("per-operation bearer failures", () => {
  it("an executed+dropped mutation stays ambiguous while a concurrent operation's credential failure stays its own", async () => {
    const token = mintChildToken(keys, { ns, slug: "conn", subject: "t", ttlSeconds: 600 }).token;
    let failBearer = false;
    const conn = new McpConnection({
      url: child.url,
      bearer: async () => {
        if (failBearer) throw new ParentCredentialError("parent credential unavailable: simulated refresh failure", false, "network_error");
        return token;
      },
    });
    await conn.connect();
    try {
      const a = conn.callTool("charge", {}).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const start = Date.now();
      while ((child.calls.get("charge") ?? 0) < 1) {
        if (Date.now() - start > 5000) throw new Error("charge never executed");
        await new Promise((r) => setTimeout(r, 10));
      }
      failBearer = true;
      const b = await conn.callTool("echo", { message: "b" }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      expect(b.ok).toBe(false);
      expect((b as { error: unknown }).error).toBeInstanceOf(ParentCredentialError); // B: credential failure, not sent
      expect(child.calls.get("echo") ?? 0).toBe(0);
      release(); // A's handler finishes executing, then its connection drops
      const ra = await a;
      expect(ra.ok).toBe(false);
      const ea = (ra as { error: unknown }).error;
      expect(ea).toBeInstanceOf(ConnectionError);
      expect((ea as ConnectionError).kind).toBe("ambiguous");
      expect(child.calls.get("charge")).toBe(1); // executed exactly once; nothing replayed
      expect(JSON.stringify({ a: String(ea), b: String((b as { error: unknown }).error) })).not.toContain(token);
    } finally {
      await conn.close();
    }
  });
});
