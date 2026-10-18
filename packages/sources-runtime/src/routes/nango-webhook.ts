import { Hono } from "hono";
import { handleNangoWebhook } from "../integrations/nango/webhook.js";

export const nangoWebhookRoute = new Hono();

nangoWebhookRoute.post("/", async (c) => {
  const result = await handleNangoWebhook({
    body: await c.req.text(),
    // SOURCE-LANE PATCH (nango-expansion request 2): never the legacy plain-SHA-256 X-Nango-Signature.
    signature: c.req.header("x-nango-hmac-sha256"),
  });

  if (result.status === 204) return c.body(null, 204);
  return c.json(result.body, result.status);
});
