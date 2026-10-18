import { Hono } from "hono";
import {
  connectNotionWithOAuthToken,
  exchangeNotionOAuthCode,
  validateNotionOAuthState,
} from "../integrations/notion/connect.js";
import { db } from "../db/client.js";
import { consumeOAuthStateOnce } from "../source-lane/core/oauth-state.js";
import { oauthCallbackPage } from "./callback-page.js";

/** Hosted OAuth callback for Notion (ported from gigabrain; same flow, no privacy runtime). */
export const notionCallbackRoute = new Hono();

notionCallbackRoute.get("/", async (c) => {
  const error = c.req.query("error");
  if (error) {
    console.error("Notion OAuth error param:", error);
    return c.html(oauthCallbackPage({
      title: "Notion OAuth Error",
      body: "Authorization was denied or failed. Please try again.",
      error: true,
    }), 400);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.html(oauthCallbackPage({
      title: "Missing parameters",
      body: "Invalid OAuth callback. Please try connecting again.",
      error: true,
    }), 400);
  }

  // SOURCE-LANE PATCH (final-audit L3): a signed state is accepted once, not until it expires.
  const stateResult = validateNotionOAuthState(state);
  if (!stateResult || !(await consumeOAuthStateOnce(db, "notion", state))) {
    return c.html(oauthCallbackPage({
      title: "Invalid or expired request",
      body: "The connection request expired. Please try connecting again.",
      error: true,
    }), 400);
  }

  try {
    const tokenData = await exchangeNotionOAuthCode(code);
    const result = await connectNotionWithOAuthToken(stateResult.userId, tokenData);

    if (!result.success) {
      console.error("Notion connect failed:", result.error);
      return c.html(oauthCallbackPage({
        title: "Connection Failed",
        body: "Could not connect your Notion workspace. Please try again.",
        error: true,
      }), 500);
    }

    return c.html(oauthCallbackPage({
      title: "Notion Connected",
      body: result.workspaceName
        ? `Notion is now connected for ${result.workspaceName}.`
        : "Notion is now connected.",
      autoClose: true,
    }));
  } catch (err) {
    console.error("Notion OAuth callback error:", err instanceof Error ? err.message : err);
    return c.html(oauthCallbackPage({
      title: "Connection Error",
      body: "Something went wrong. Please try connecting again.",
      error: true,
    }), 500);
  }
});
