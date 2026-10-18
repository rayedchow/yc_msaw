import { Hono } from "hono";
import {
  connectGranolaWithOAuthToken,
  exchangeGranolaOAuthCode,
} from "../integrations/granola/connect.js";
import { oauthCallbackPage } from "./callback-page.js";

/** Hosted OAuth callback for Granola (ported from gigabrain; same flow, no privacy runtime). */
export const granolaCallbackRoute = new Hono();

granolaCallbackRoute.get("/", async (c) => {
  const error = c.req.query("error");
  if (error) {
    console.error("Granola OAuth error param:", error);
    return c.html(oauthCallbackPage({
      title: "Granola OAuth Error",
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

  try {
    const exchanged = await exchangeGranolaOAuthCode(code, state);
    const result = await connectGranolaWithOAuthToken(exchanged.userId, exchanged.tokenData, {
      clientId: exchanged.client.clientId,
      tokenEndpointAuthMethod: exchanged.client.tokenEndpointAuthMethod,
    });

    if (!result.success) {
      console.error("Granola connect failed:", result.error);
      return c.html(oauthCallbackPage({
        title: "Connection Failed",
        body: "Could not connect your Granola account. Please try again.",
        error: true,
      }), 500);
    }

    return c.html(oauthCallbackPage({
      title: "Granola Connected",
      body: "Granola meeting sync is now connected.",
      autoClose: true,
    }));
  } catch (err) {
    console.error("Granola OAuth callback error:", err instanceof Error ? err.message : err);
    return c.html(oauthCallbackPage({
      title: "Connection Error",
      body: "Something went wrong. Please try connecting again.",
      error: true,
    }), 500);
  }
});
