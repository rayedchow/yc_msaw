export {
  assertAuthStartupSafe,
  assertSafeStartup,
  AuthConfigError,
  discoveryUrls,
  fetchDiscovery,
  isLoopbackHost,
  loadAuthConfig,
  normalizeResourceUrl,
  parseAuthConfig,
  resolveOidcDiscovery,
  type AuthConfig,
  type AuthMode,
  type Env,
  type OidcAuthConfig,
  type ParseAuthOptions,
  type WorkOSAuthConfig,
} from "./config.js";
export { buildMcpOAuth, principalFromAuth, toolSecuritySchemes, type CtxAuthLike, type Principal } from "./mcp.js";
export {
  authenticateHttp,
  bearerChallenge,
  protectedResourceMetadataUrl,
  type AuthenticateHttpOptions,
  type ChallengeOptions,
} from "./http.js";
export {
  ADMIN_SCOPES,
  ALL_SCOPES,
  DEFAULT_IMPLICIT_SCOPES,
  hasAllScopes,
  hasScope,
  isScope,
  parseScopeList,
  requireScope,
  SCOPES,
  type Scope,
} from "./scopes.js";
export {
  generateStaticKey,
  hashStaticKey,
  looksLikeStaticKey,
  matchStaticKey,
  parseStaticKeys,
  STATIC_KEY_PREFIX,
  type StaticKeyRecord,
} from "./static-keys.js";
export { assertTenantNs, isTenantNs, TENANT_NS_PATTERN, tenantNsFor } from "./tenant.js";
export { createProcmemVerifier, effectiveScopes, STATIC_ISSUER, userFromAuthInfo, type AuthProviderKind, type ProcmemUser } from "./verifier.js";
