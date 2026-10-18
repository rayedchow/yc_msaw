import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGranolaNoteViaMcp } from "../../../src/integrations/granola/mcp-client.js";
import { classifyGranolaNoteFetchFailure } from "../../../src/integrations/granola/poller.js";

describe("Granola MCP client tool errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on isError tool results (deleted note) instead of normalizing a shell note", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: string };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id, { protocolVersion: "2025-06-18", capabilities: {} });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        return jsonRpcResponse(body.id, {
          tools: [
            { name: "get_note", inputSchema: { properties: { note_id: {} } } },
            { name: "list_notes", inputSchema: { properties: { cursor: {} } } },
          ],
        });
      }
      // tools/call for the deleted note.
      return jsonRpcResponse(body.id, {
        isError: true,
        content: [{ type: "text", text: "Note not found" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchGranolaNoteViaMcp("token-1", "gone-note").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Note not found");
    // The taxonomy must read this as a deletion, not a transient failure.
    expect(classifyGranolaNoteFetchFailure(error)).toBe("not_found");
  });
});

function jsonRpcResponse(id: string | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
