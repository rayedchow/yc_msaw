import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const setConnectionStatusMock = vi.hoisted(() => vi.fn());
const emitOutboxEventMock = vi.hoisted(() => vi.fn());
const disableTaskSchedulesMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db/client.js", () => ({
  db: { execute: executeMock },
}));

vi.mock("../../src/db/connections.js", () => ({
  setConnectionStatus: setConnectionStatusMock,
}));

vi.mock("../../src/outbox/writer.js", () => ({
  emitOutboxEvent: emitOutboxEventMock,
}));

vi.mock("../../src/queue/sweeper.js", () => ({
  disableTaskSchedules: disableTaskSchedulesMock,
}));

import {
  classifyCredentialFailure,
  handlePermanentCredentialFailure,
  sanitizeCredentialErrorMessage,
} from "../../src/vault/credential-failure.js";

describe("credential failure classification", () => {
  beforeEach(() => {
    executeMock.mockReset();
    setConnectionStatusMock.mockReset();
    emitOutboxEventMock.mockReset();
    disableTaskSchedulesMock.mockReset();
    setConnectionStatusMock.mockResolvedValue(undefined);
    emitOutboxEventMock.mockResolvedValue("evt-1");
    disableTaskSchedulesMock.mockResolvedValue(undefined);
  });

  it("classifies missing and revoked credentials as permanent", () => {
    expect(classifyCredentialFailure(new Error("No Notion token found for user t1"))).toBe("permanent");
    expect(classifyCredentialFailure(new Error("Google delegation failed: unauthorized_client"))).toBe("permanent");
    expect(classifyCredentialFailure(new Error("Google delegation failed: invalid_grant"))).toBe("permanent");
    expect(classifyCredentialFailure({ name: "NotionApiError", status: 401, message: "unauthorized" })).toBe("permanent");
    expect(classifyCredentialFailure({ name: "GranolaOAuthError", status: 400, errorCode: "invalid_grant", message: "Granola OAuth failed" })).toBe("permanent");
  });

  it("classifies rate limits, 5xx, and network failures as transient", () => {
    expect(classifyCredentialFailure({ status: 429, message: "rate limited" })).toBe("transient");
    expect(classifyCredentialFailure({ status: 503, message: "provider unavailable" })).toBe("transient");
    expect(classifyCredentialFailure(new Error("Notion token refresh failed (500): upstream down"))).toBe("transient");
    expect(classifyCredentialFailure(Object.assign(new Error("fetch failed"), { name: "TypeError" }))).toBe("transient");
  });

  it("leaves unrelated failures unknown", () => {
    expect(classifyCredentialFailure(new Error("calendar sync state missing"))).toBe("unknown");
    expect(classifyCredentialFailure({ status: 400, message: "bad request" })).toBe("unknown");
  });

  it("redacts credential-shaped values from surfaced messages", () => {
    const message = sanitizeCredentialErrorMessage(
      new Error("Bearer abc.def access_token=tok refresh_token=ref \"client_secret\":\"secret\""),
    );
    expect(message).toContain("Bearer [REDACTED]");
    expect(message).toContain("access_token=[REDACTED]");
    expect(message).toContain("refresh_token=[REDACTED]");
    expect(message).toContain("\"client_secret\":\"[REDACTED]\"");
    expect(message).not.toContain("abc.def");
    expect(message).not.toContain("\":\"secret\"");
  });

  it("emits one permanent credential failure event only when leaving a non-error state", async () => {
    executeMock.mockResolvedValueOnce([{ should_emit: true }]);

    await handlePermanentCredentialFailure({
      tenantId: "t1",
      provider: "google",
      taskKinds: ["gmail.poll", "gmail.poll", "calendar.poll"],
      error: new Error("Google delegation failed: invalid_grant"),
    });

    expect(setConnectionStatusMock).toHaveBeenCalledWith("t1", "google", "error", undefined, expect.anything());
    expect(disableTaskSchedulesMock).toHaveBeenCalledTimes(2);
    expect(disableTaskSchedulesMock).toHaveBeenCalledWith("t1", "gmail.poll", expect.anything());
    expect(disableTaskSchedulesMock).toHaveBeenCalledWith("t1", "calendar.poll", expect.anything());
    expect(emitOutboxEventMock).toHaveBeenCalledTimes(1);
    expect(emitOutboxEventMock.mock.calls[0][0]).toMatchObject({
      tenantId: "t1",
      eventType: "connection.credential_failed",
      payload: { provider: "google", error: "Google delegation failed: invalid_grant" },
      orderingKey: "t1:google",
    });

    executeMock.mockResolvedValueOnce([{ should_emit: false }]);
    emitOutboxEventMock.mockReset();

    await handlePermanentCredentialFailure({
      tenantId: "t1",
      provider: "google",
      taskKinds: ["gmail.poll"],
      error: new Error("Google delegation failed: invalid_grant"),
    });

    expect(emitOutboxEventMock).not.toHaveBeenCalled();
  });
});
