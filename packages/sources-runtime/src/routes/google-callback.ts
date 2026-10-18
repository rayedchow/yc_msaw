import { Hono } from "hono";

/**
 * Per-user Google OAuth is intentionally disabled: Aqueduct connects Google
 * accounts through Workspace domain-wide delegation (see src/vault). The
 * route exists so stale redirect URIs fail loudly with an explanation
 * instead of a 404.
 */
export const googleCallbackRoute = new Hono();

googleCallbackRoute.get("/", (c) =>
  c.html(
    "<html><body><h2>Google OAuth Disabled</h2><p>Aqueduct uses Google Workspace domain-wide delegation for Google data access.</p></body></html>",
    410,
  )
);
