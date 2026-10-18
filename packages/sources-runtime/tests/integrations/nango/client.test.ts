import { describe, expect, it, vi } from "vitest";
import { NangoClient, NangoRequestError } from "../../../src/integrations/nango/client.js";

function makeClient(fetchImpl: typeof fetch, overrides = {}) {
  return new NangoClient({ apiKey: "secret", fetchImpl, retryDelayMs: 0, ...overrides });
}

describe("NangoClient", () => {
  it("lists connections with provider filtering and normalizes Nango fields", async () => {
    const fetchImpl = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify({
      data: [{
        connection_id: "conn-1",
        provider_config_key: "github",
        end_user: { id: "tenant-1" },
      }, {
        connection_id: "conn-2",
        provider_config_key: "jira",
        end_user: { id: "tenant-1" },
      }],
    }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.listConnections({ providerConfigKey: "github" });

    expect(result).toEqual([{
      connectionId: "conn-1",
      providerConfigKey: "github",
      endUserId: "tenant-1",
      raw: {
        connection_id: "conn-1",
        provider_config_key: "github",
        end_user: { id: "tenant-1" },
      },
    }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.pathname).toBe("/connection");
    // GET /connection 400s on a provider_config_key query param
    // (unrecognized_keys) - the filter must happen client-side.
    expect(url.searchParams.get("provider_config_key")).toBeNull();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("sends provider-config-key + connection-id headers and returns parsed JSON", async () => {
    const fetchImpl = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.proxy({
      providerConfigKey: "github",
      connectionId: "conn-1",
      endpoint: "/repos/o/r/issues",
      params: { state: "all", per_page: 100 },
    });

    expect(result).toEqual({ status: 200, data: [{ id: 1 }] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.pathname).toBe("/proxy/repos/o/r/issues");
    expect(url.searchParams.get("state")).toBe("all");
    const headers = init.headers as Record<string, string>;
    expect(headers["Provider-Config-Key"]).toBe("github");
    expect(headers["Connection-Id"]).toBe("conn-1");
  });

  it("returns tolerated statuses (e.g. 404) instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.proxy({
      providerConfigKey: "bitbucket",
      connectionId: "conn-1",
      endpoint: "/repositories/ws/repo/issues",
      tolerateStatuses: [404],
    });

    expect(result.status).toBe(404);
    expect(result.data).toBeNull();
  });

  it("honors Retry-After on 429 and retries", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.proxy({ providerConfigKey: "github", connectionId: "c", endpoint: "/x" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 200, data: { ok: true } });
  });

  it("honors Retry-After on 429 on the JSON request path too (not just the proxy)", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    // Exponential backoff alone would sleep 60s here and blow the test
    // timeout; honoring Retry-After (0s) makes the retry immediate.
    const client = makeClient(fetchImpl as unknown as typeof fetch, { retryDelayMs: 60_000 });

    const result = await client.listConnections();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it("throws NangoRequestError on non-tolerated, non-retryable errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 422 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.proxy({ providerConfigKey: "github", connectionId: "c", endpoint: "/x" }))
      .rejects.toBeInstanceOf(NangoRequestError);
  });
});

describe("NangoClient.listConnections", () => {
  it("normalizes connection ids, provider keys, and end-user ids", async () => {
    const fetchImpl = vi.fn(async (_url: URL, _init: RequestInit) => new Response(JSON.stringify({
      data: [{
        connection_id: "conn-1",
        provider_config_key: "jira",
        end_user: { id: "tenant-1" },
      }],
    }), { status: 200 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.listConnections();

    expect(result).toEqual([{
      connectionId: "conn-1",
      providerConfigKey: "jira",
      endUserId: "tenant-1",
      raw: {
        connection_id: "conn-1",
        provider_config_key: "jira",
        end_user: { id: "tenant-1" },
      },
    }]);
    const url = (fetchImpl.mock.calls[0] as unknown as [URL])[0];
    expect(url.pathname).toBe("/connection");
  });
});
