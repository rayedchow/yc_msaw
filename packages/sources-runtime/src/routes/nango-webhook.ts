import { Hono } from "hono";
import { handleNangoWebhook } from "../integrations/nango/webhook.js";

export const nangoWebhookRoute = new Hono();

nangoWebhookRoute.post("/", async (c) => {
  const result = await handleNangoWebhook({
    body: await c.req.text(),
    signature: c.req.header("x-nango-hmac-sha256") ?? c.req.header("x-nango-signature"),
  });

  if (result.status === 204) return c.body(null, 204);
  return c.json(result.body, result.status);
});
