import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

import { emitOutboxEvent } from "../../src/outbox/writer.js";
import { deliveryBackoffSeconds, dispatchPendingOutboxEvents, signWebhookPayload } from "../../src/outbox/dispatcher.js";
import { encrypt } from "../../src/vault/encryption.js";

describe("outbox writer", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  it("appends an event row and returns its id", async () => {
    executeMock.mockResolvedValueOnce([{ id: "evt-1" }]);

    const id = await emitOutboxEvent({
      tenantId: "t1",
      eventType: "mirror.file.changed",
      payload: { path: "sources/gmail/index.md" },
      orderingKey: "t1:gmail",
    });

    expect(id).toBe("evt-1");
    const parts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(parts).toContain("INSERT INTO outbox_events");
    const params = sqlParams(executeMock.mock.calls[0][0]);
    expect(params).toContain("t1");
    expect(params).toContain("mirror.file.changed");
    expect(params).toContain("t1:gmail");
  });
});

describe("webhook dispatcher", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
  });

  it("signs payloads with a Stripe-style timestamped HMAC", () => {
    const signature = signWebhookPayload("secret-1", '{"a":1}', 1_700_000_000);
    const expected = createHmac("sha256", "secret-1").update('1700000000.{"a":1}').digest("hex");
    expect(signature).toBe(`t=1700000000,v1=${expected}`);
  });

  it("backs off exponentially with jitter, bounded to an hour", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const seconds = deliveryBackoffSeconds(attempt);
      expect(seconds).toBeGreaterThanOrEqual(5);
      expect(seconds).toBeLessThanOrEqual(3600);
    }
    expect(deliveryBackoffSeconds(1)).toBeLessThanOrEqual(30);
  });

  it("claims due events with SKIP LOCKED and marks endpoint-less events delivered", async () => {
    executeMock.mockResolvedValueOnce([
      {
        id: "evt-1",
        tenant_id: "t1",
        event_type: "event.collected",
        payload: {},
        ordering_key: null,
        attempts: 0,
        created_at: new Date().toISOString(),
      },
    ]); // claim
    executeMock.mockResolvedValueOnce([]); // endpoints
    executeMock.mockResolvedValueOnce([]); // mark delivered

    const finalized = await dispatchPendingOutboxEvents();

    expect(finalized).toBe(1);
    const claimParts = sqlParts(executeMock.mock.calls[0][0]).join(" ");
    expect(claimParts).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimParts).toContain("next_attempt_at <= now()");
    // visibility-timeout lease: claiming pushes next_attempt_at forward so a
    // second dispatcher cannot re-claim the event mid-delivery
    expect(claimParts).toContain("next_attempt_at = now() + make_interval");
    // per-key ordering guard: earlier unfinalized events block later ones
    expect(claimParts).toContain("prior.ordering_key = candidate.ordering_key");
    expect(claimParts).toContain("prior.created_at < candidate.created_at");
    const finalParts = sqlParts(executeMock.mock.calls[2][0]).join(" ");
    expect(finalParts).toContain("state = 'delivered'");
  });

  it("delivers to matching endpoints with a signed POST and resets the breaker", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      executeMock.mockResolvedValueOnce([
        {
          id: "evt-1",
          tenant_id: "t1",
          event_type: "mirror.file.changed",
          payload: { path: "sources/index.md" },
          ordering_key: "t1",
          delivered_endpoint_ids: [],
          attempts: 0,
          created_at: "2026-07-02T00:00:00.000Z",
        },
      ]);
      executeMock.mockResolvedValueOnce([
        {
          id: "ep-1",
          tenant_id: "t1",
          url: "https://customer.example/hooks/aqueduct",
          secret: encrypt("whsec_1"),
          event_types: ["mirror."],
          consecutive_failures: 0,
          circuit_open_until: null,
        },
      ]);
      executeMock.mockResolvedValue([]);

      const finalized = await dispatchPendingOutboxEvents();

      expect(finalized).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://customer.example/hooks/aqueduct");
      const headers = init.headers as Record<string, string>;
      expect(headers["Aqueduct-Signature"]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(headers["Aqueduct-Event"]).toBe("mirror.file.changed");
      const body = JSON.parse(String(init.body));
      expect(body.type).toBe("mirror.file.changed");
      expect(body.data).toEqual({ path: "sources/index.md" });
      // breaker reset + delivered mark issued
      const statements = executeMock.mock.calls.map((call) => sqlParts(call[0]).join(" "));
      expect(statements.some((parts) => parts.includes("consecutive_failures = 0"))).toBe(true);
      expect(statements.some((parts) => parts.includes("delivered_endpoint_ids = delivered_endpoint_ids ||"))).toBe(true);
      expect(statements.some((parts) => parts.includes("state = 'delivered'"))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("skips endpoints whose event-type filter does not match", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      executeMock.mockResolvedValueOnce([
        {
          id: "evt-1",
          tenant_id: "t1",
          event_type: "connection.updated",
          payload: {},
          ordering_key: null,
          delivered_endpoint_ids: [],
          attempts: 0,
          created_at: "2026-07-02T00:00:00.000Z",
        },
      ]);
      executeMock.mockResolvedValueOnce([
        {
          id: "ep-1",
          tenant_id: "t1",
          url: "https://customer.example/hooks",
          secret: encrypt("whsec_1"),
          event_types: ["mirror."],
          consecutive_failures: 0,
          circuit_open_until: null,
        },
      ]);
      executeMock.mockResolvedValue([]);

      const finalized = await dispatchPendingOutboxEvents();

      expect(finalized).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("records failures, bumps the endpoint breaker, and schedules a retry", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    try {
      executeMock.mockResolvedValueOnce([
        {
          id: "evt-1",
          tenant_id: "t1",
          event_type: "mirror.file.changed",
          payload: {},
          ordering_key: null,
          delivered_endpoint_ids: [],
          attempts: 0,
          created_at: "2026-07-02T00:00:00.000Z",
        },
      ]);
      executeMock.mockResolvedValueOnce([
        {
          id: "ep-1",
          tenant_id: "t1",
          url: "https://customer.example/hooks",
          secret: encrypt("whsec_1"),
          event_types: [],
          consecutive_failures: 1,
          circuit_open_until: null,
        },
      ]);
      executeMock.mockResolvedValue([]);

      const finalized = await dispatchPendingOutboxEvents();

      expect(finalized).toBe(0); // retried, not finalized
      const statements = executeMock.mock.calls.map((call) => sqlParts(call[0]).join(" "));
      expect(statements.some((parts) => parts.includes("consecutive_failures = consecutive_failures + 1"))).toBe(true);
      const retry = statements.find((parts) => parts.includes("state = 'pending'"));
      expect(retry).toBeTruthy();
      expect(retry).toContain("attempts = attempts + 1");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("never re-sends to endpoints that already accepted the event (partial-failure retry)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      executeMock.mockResolvedValueOnce([
        {
          id: "evt-1",
          tenant_id: "t1",
          event_type: "mirror.file.changed",
          payload: {},
          ordering_key: null,
          delivered_endpoint_ids: ["ep-a"], // endpoint A accepted on a previous attempt
          attempts: 1,
          created_at: "2026-07-02T00:00:00.000Z",
        },
      ]);
      executeMock.mockResolvedValueOnce([
        {
          id: "ep-a",
          tenant_id: "t1",
          url: "https://customer.example/hooks/a",
          secret: encrypt("whsec_a"),
          event_types: [],
          consecutive_failures: 0,
          circuit_open_until: null,
        },
        {
          id: "ep-b",
          tenant_id: "t1",
          url: "https://customer.example/hooks/b",
          secret: encrypt("whsec_b"),
          event_types: [],
          consecutive_failures: 1,
          circuit_open_until: null,
        },
      ]);
      executeMock.mockResolvedValue([]);

      const finalized = await dispatchPendingOutboxEvents();

      // only endpoint B is called; endpoint A already has the event
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://customer.example/hooks/b");
      expect(finalized).toBe(1);
      const statements = executeMock.mock.calls.map((call) => sqlParts(call[0]).join(" "));
      expect(statements.some((parts) => parts.includes("state = 'delivered'"))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not call endpoints while their circuit is open", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    try {
      executeMock.mockResolvedValueOnce([
        {
          id: "evt-1",
          tenant_id: "t1",
          event_type: "mirror.file.changed",
          payload: {},
          ordering_key: null,
          delivered_endpoint_ids: [],
          attempts: 2,
          created_at: "2026-07-02T00:00:00.000Z",
        },
      ]);
      executeMock.mockResolvedValueOnce([
        {
          id: "ep-1",
          tenant_id: "t1",
          url: "https://customer.example/hooks",
          secret: encrypt("whsec_1"),
          event_types: [],
          consecutive_failures: 5,
          circuit_open_until: new Date(Date.now() + 60_000).toISOString(),
        },
      ]);
      executeMock.mockResolvedValue([]);

      const finalized = await dispatchPendingOutboxEvents();

      expect(finalized).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});

function sqlParts(value: any): string[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (Array.isArray(chunk?.value)) return chunk.value;
    if (Array.isArray(chunk?.queryChunks)) return sqlParts(chunk);
    return [];
  });
}

function sqlParams(value: any): unknown[] {
  if (!value || !Array.isArray(value.queryChunks)) return [];
  return value.queryChunks.flatMap((chunk: any) => {
    if (chunk === null || typeof chunk !== "object") return [chunk]; // inline bind param
    if (Array.isArray(chunk.queryChunks)) return sqlParams(chunk); // nested sql
    if (Array.isArray(chunk.value)) return []; // StringChunk
    if ("value" in chunk) return [chunk.value]; // Param wrapper
    return [];
  });
}
