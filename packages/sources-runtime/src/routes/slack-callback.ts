import { Hono } from "hono";
import {
  connectSlackWithToken,
  exchangeSlackOAuthCode,
  validateSlackOAuthState,
} from "../integrations/slack/connect.js";
import { db } from "../db/client.js";
import { consumeOAuthStateOnce } from "../source-lane/core/oauth-state.js";
import { oauthCallbackPage } from "./callback-page.js";

/** Hosted OAuth callback for Slack user-token OAuth. */
export const slackCallbackRoute = new Hono();

slackCallbackRoute.get("/", async (c) => {
  const error = c.req.query("error");
  if (error) {
    console.error("Slack OAuth error param:", error);
    return c.html(oauthCallbackPage({
      title: "Slack OAuth Error",
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
  const stateResult = validateSlackOAuthState(state);
  if (!stateResult || !(await consumeOAuthStateOnce(db, "slack", state))) {
    return c.html(oauthCallbackPage({
      title: "Invalid or expired request",
      body: "The connection request expired. Please try connecting again.",
      error: true,
    }), 400);
  }

  try {
    const exchanged = await exchangeSlackOAuthCode(code);
    const result = await connectSlackWithToken(stateResult.userId, exchanged.token);

    if (!result.success) {
      console.error("Slack connect failed:", result.error);
      return c.html(oauthCallbackPage({
        title: "Connection Failed",
        // Surface the specific reason (e.g. workspace mismatch) - these are
        // our own messages, never raw provider payloads.
        body: result.error ?? "Could not connect your Slack workspace. Please try again.",
        error: true,
      }), 400);
    }

    return c.html(oauthCallbackPage({
      title: "Slack Connected",
      body: result.teamName
        ? `Slack is now connected for ${result.teamName}.`
        : "Slack is now connected.",
      autoClose: true,
    }));
  } catch (err) {
    console.error("Slack OAuth callback error:", err instanceof Error ? err.message : err);
    return c.html(oauthCallbackPage({
      title: "Connection Error",
      body: "Something went wrong. Please try connecting again.",
      error: true,
    }), 500);
  }
});
