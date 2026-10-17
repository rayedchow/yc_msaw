import { createHash } from "node:crypto";

/** Tenant namespace grammar shared with the storage layer. */
export const TENANT_NS_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isTenantNs(value: string): boolean {
  return TENANT_NS_PATTERN.test(value);
}

export function assertTenantNs(value: string, label = "tenant namespace"): string {
  if (!isTenantNs(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} must match ${TENANT_NS_PATTERN}`);
  }
  return value;
}

/**
 * Deterministic tenant namespace for an OAuth identity.
 *
 * The namespace is scoped by issuer, so the same `org_id`/`sub` from two
 * different authorization servers never collide. When the token carries an
 * organization (WorkOS `org_id`, or the configured OIDC tenant claim), every
 * member of that organization shares one namespace; otherwise the user is
 * their own tenant.
 *
 *   t-<first 20 hex of sha256("<issuer>|org:<org>")>   (organization)
 *   t-<first 20 hex of sha256("<issuer>|sub:<sub>")>   (personal)
 */
export function tenantNsFor(issuer: string, identity: { organizationId?: string | undefined; subject: string }): string {
  const iss = issuer.replace(/\/+$/, "");
  const key = identity.organizationId ? `org:${identity.organizationId}` : `sub:${identity.subject}`;
  const digest = createHash("sha256").update(`${iss}|${key}`).digest("hex").slice(0, 20);
  return `t-${digest}`;
}
