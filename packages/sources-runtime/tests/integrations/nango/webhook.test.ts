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

  // SOURCE-LANE PATCH (nango-expansion request 2): the legacy plain-SHA-256 variant is refused.
  it("rejects the legacy sha256(secret + body) signature and HMACs keyed with another key", () => {
    const body = JSON.stringify({ type: "auth", success: true });
    const secret = "nango-webhook-secret";
    const signature = createHash("sha256").update(secret).update(body).digest("hex");

    expect(verifyNangoWebhookSignature(body, signature, secret)).toBe(false);
    expect(verifyNangoWebhookSignature(body, createHmac("sha256", "nango-environment-api-key").update(body).digest("hex"), secret)).toBe(false);
    expect(verifyNangoWebhookSignature(`${body} `, createHmac("sha256", secret).update(body).digest("hex"), secret)).toBe(false);
  });
});

describe("Nango webhook signature header selection", () => {
  // SOURCE-LANE PATCH (nango-expansion request 2): only X-Nango-Hmac-Sha256 is read.
  it("reads only x-nango-hmac-sha256; the legacy x-nango-signature is ignored", () => {
    const hmac = "a".repeat(64);

    expect(
      readNangoSignatureHeader((name) =>
        name === "x-nango-signature" ? hmac : undefined,
      ),
    ).toBeUndefined();

    expect(
      readNangoSignatureHeader((name) =>
        name === "x-nango-hmac-sha256" ? hmac : undefined,
      ),
    ).toBe(hmac);

    expect(readNangoSignatureHeader(() => undefined)).toBeUndefined();
  });
});
