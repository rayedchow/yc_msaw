import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  readNangoSignatureHeader,
  verifyNangoWebhookSignature,
} from "../../../src/integrations/nango/webhook.js";

describe("Nango webhook signature verification", () => {
  it("accepts the HMAC-SHA256 hex signature scheme", () => {
    const body = JSON.stringify({ type: "sync", success: true });
    const secret = "nango-webhook-secret";
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    expect(verifyNangoWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyNangoWebhookSignature(body, `sha256=${signature}`, secret)).toBe(true);
  });

  it("accepts the sha256(secret + body) hash signature variant", () => {
    const body = JSON.stringify({ type: "auth", success: true });
    const secret = "nango-webhook-secret";
    const signature = createHash("sha256").update(secret).update(body).digest("hex");

    expect(verifyNangoWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyNangoWebhookSignature(`${body} `, signature, secret)).toBe(false);
  });
});

describe("Nango webhook signature header selection", () => {
  it("accepts the HMAC from either x-nango-signature or x-nango-hmac-sha256", () => {
    const hmac = "a".repeat(64);

    expect(
      readNangoSignatureHeader((name) =>
        name === "x-nango-signature" ? hmac : undefined,
      ),
    ).toBe(hmac);

    expect(
      readNangoSignatureHeader((name) =>
        name === "x-nango-hmac-sha256" ? hmac : undefined,
      ),
    ).toBe(hmac);

    expect(readNangoSignatureHeader(() => undefined)).toBeUndefined();
  });
});
