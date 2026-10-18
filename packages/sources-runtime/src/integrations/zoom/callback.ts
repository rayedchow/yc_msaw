import { Hono } from "hono";
import { connectZoomWithTokens } from "./connect.js";
import { consumeZoomOAuthState, exchangeZoomOAuthCode } from "./oauth.js";

// Ported from askshepherd/aqueduct c7e1415 src/routes/zoom-callback.ts (plain-text responses here; the donor's
// callback-page helper is part of its API plane, which the source runtime does not copy). The state is
// consumed exactly once (oauth.ts).
export const zoomCallbackRoute = new Hono();
zoomCallbackRoute.get("/", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  if (error || !code || !state) return c.text("Zoom connection failed: authorization was denied or incomplete. Please try again.", 400);
  const validated = await consumeZoomOAuthState(state);
  if (!validated) return c.text("Invalid, expired or already-used request. Please start the Zoom connection again.", 400);
  try {
    await connectZoomWithTokens(validated.tenantId, await exchangeZoomOAuthCode(code));
    return c.text("Zoom connected. Recordings' transcripts are now syncing; you can close this window.");
  } catch (err) {
    console.error("Zoom OAuth callback error:", err instanceof Error ? err.message : err);
    return c.text("Zoom could not be connected. Please try again.", 500);
  }
});
