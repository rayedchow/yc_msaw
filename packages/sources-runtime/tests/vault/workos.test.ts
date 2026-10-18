import { describe, expect, it, vi } from "vitest";

const getAuthorizationUrlMock = vi.hoisted(() => vi.fn(() => "https://workos.example/authorize"));
const workosMock = vi.hoisted(() => vi.fn(function WorkOS() {
  return {
    userManagement: {
      getAuthorizationUrl: getAuthorizationUrlMock,
    },
  };
}));

vi.mock("@workos-inc/node", () => ({
  WorkOS: workosMock,
}));

import { buildWorkosAuthorizationUrl } from "../../src/vault/workos.js";

describe("buildWorkosAuthorizationUrl", () => {
  it("forces account selection while preserving the login hint", () => {
    const result = buildWorkosAuthorizationUrl({
      redirectUri: "https://dev.askshepherd.ai/auth/callback",
      state: "wostate_test",
      email: "ada@example.com",
    });

    expect(result).toBe("https://workos.example/authorize");
    expect(workosMock).toHaveBeenCalledWith({
      apiKey: "sk_test_workos",
      clientId: "client_test_workos",
    });
    expect(getAuthorizationUrlMock).toHaveBeenCalledWith({
      provider: "authkit",
      redirectUri: "https://dev.askshepherd.ai/auth/callback",
      state: "wostate_test",
      prompt: "select_account",
      loginHint: "ada@example.com",
    });
  });
});
