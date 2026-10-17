/**
 * procmem authorization scopes.
 *
 * - memory:read        customer agents read published memory through the MCP
 * - traces:write       SDK/trace-ingest HTTP API
 * - memory:build       admin: trigger the daily memory build
 * - integrations:read  list/inspect generated integrations
 */
export const SCOPES = {
  memoryRead: "memory:read",
  tracesWrite: "traces:write",
  memoryBuild: "memory:build",
  integrationsRead: "integrations:read",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: readonly Scope[] = Object.values(SCOPES);

/** Scopes every authenticated OAuth user of a trusted issuer receives (for their own tenant). */
export const DEFAULT_IMPLICIT_SCOPES: readonly Scope[] = [SCOPES.memoryRead, SCOPES.integrationsRead];

/** Granted to PROCMEM_ADMIN_SUBJECTS. */
export const ADMIN_SCOPES: readonly Scope[] = [SCOPES.memoryBuild, SCOPES.tracesWrite];

export function isScope(value: string): value is Scope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

/** RFC 6749 scope-token grammar. */
export const SCOPE_TOKEN = new RegExp("^[\\x21\\x23-\\x5B\\x5D-\\x7E]+$");

/** Split a scope list separated by spaces, commas or `+`. */
export function parseScopeList(value: string | undefined): string[] {
  if (value === undefined) return [];
  const out = value
    .split(/[\s,+]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of out) {
    if (!SCOPE_TOKEN.test(s)) throw new Error(`Invalid OAuth scope token: ${JSON.stringify(s)}`);
  }
  return [...new Set(out)];
}

export function hasScope(principal: { scopes: readonly string[] }, scope: string): boolean {
  return principal.scopes.includes(scope);
}

export function hasAllScopes(principal: { scopes: readonly string[] }, scopes: readonly string[]): boolean {
  return scopes.every((s) => principal.scopes.includes(s));
}

/** Throws when the principal lacks `scope` (use inside MCP tool callbacks). */
export function requireScope(principal: { scopes: readonly string[]; subject?: string }, scope: string): void {
  if (!hasScope(principal, scope)) {
    throw new Error(`Forbidden: missing scope ${scope}`);
  }
}
