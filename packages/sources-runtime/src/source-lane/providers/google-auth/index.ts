import type { SourceProviderModule } from "../../core/types.js";
import { registerGoogleAuthInternalRoutes, registerGoogleAuthPublicRoutes } from "./routes.js";
import { GOOGLE_AUTH_PROVIDER_ID, googleAuthCoverage } from "./status.js";

/**
 * Google provider grants (credential lane, no data of its own).
 *
 * Owns the per-(tenant, account) Google auth mode - domain-wide delegation
 * inside an operator-approved allowlist, direct per-user OAuth, or the optional
 * Composio proxy - plus the setup API and browser callbacks. The gmail,
 * google-docs, calendar and contacts modules consume it through
 * vault/google-auth.ts getGoogleAccessToken / getGoogleApiCredential.
 */
export const googleAuthProvider: SourceProviderModule = {
  id: GOOGLE_AUTH_PROVIDER_ID,
  eventSources: [],
  mirrorRoots: [],
  coverage: (ctx) => googleAuthCoverage(ctx.tenantId, ctx.executor),
  publicRoutes: (app) => registerGoogleAuthPublicRoutes(app),
  internalRoutes: (app, deps) => registerGoogleAuthInternalRoutes(app, deps),
};
