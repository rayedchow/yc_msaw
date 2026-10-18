/**
 * Server-owned Google Workspace domain-wide delegation (DWD) allowlist.
 *
 * DWD uses ONE service account for every tenant. Whoever can name a mailbox can
 * read it once a Workspace super admin has authorized the service account, so the
 * mailbox must never come from a caller alone. The operator approves, per runtime
 * tenant (== yc_msaw tenantNs), which Workspace domains and/or exact mailboxes that
 * tenant may impersonate:
 *
 *   GOOGLE_DWD_TENANT_APPROVALS='{"acme-a1b2": {"domains": ["acme.com"], "mailboxes": ["ops@acme-labs.io"],
 *                                  "directoryAdmin": "admin@acme.com"}}'
 *   (shorthand: {"acme-a1b2": ["acme.com", "ops@acme-labs.io"]})
 *
 * A domain or mailbox approved for more than one tenant is a configuration
 * conflict and is refused for every tenant that lists it (fail closed), so one
 * tenant can never be configured to impersonate another tenant's users.
 */

const ENV_NAME = "GOOGLE_DWD_TENANT_APPROVALS";
const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Same consumer-domain list as vault/google-auth.ts: DWD only works for managed Workspace domains.
const CONSUMER_DOMAINS = new Set([
  "aol.com", "fastmail.com", "gmail.com", "gmx.com", "gmx.de", "gmx.net", "googlemail.com", "hey.com",
  "hotmail.com", "hotmail.co.uk", "icloud.com", "inbox.com", "live.com", "live.co.uk", "mac.com", "mail.com",
  "mail.ru", "me.com", "msn.com", "outlook.com", "pm.me", "proton.me", "protonmail.com", "tuta.com",
  "tutanota.com", "web.de", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yandex.com", "yandex.ru", "zoho.com",
  "zohomail.com",
]);

export interface GoogleDwdTenantPolicy {
  tenantId: string;
  domains: string[];
  mailboxes: string[];
  /** Mailboxes disputed across tenants: refused even when a domain rule would match. */
  excludedMailboxes: string[];
  directoryAdmin: string | null;
}

export interface GoogleDwdPolicySet {
  tenants: Map<string, GoogleDwdTenantPolicy>;
  errors: string[];
}

export class GoogleDwdNotApprovedError extends Error {
  readonly code = "dwd_not_approved";
  constructor(message: string) {
    super(message);
    this.name = "GoogleDwdNotApprovedError";
  }
}

let cached: { raw: string; policy: GoogleDwdPolicySet } | null = null;

export function loadGoogleDwdPolicy(raw: string | undefined = process.env[ENV_NAME]): GoogleDwdPolicySet {
  const value = raw?.trim() ?? "";
  if (cached && cached.raw === value) return cached.policy;
  const policy = parseGoogleDwdPolicy(value);
  cached = { raw: value, policy };
  return policy;
}

export function parseGoogleDwdPolicy(raw: string): GoogleDwdPolicySet {
  const tenants = new Map<string, GoogleDwdTenantPolicy>();
  const errors: string[] = [];
  if (!raw) return { tenants, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tenants, errors: [`${ENV_NAME} must be valid JSON`] };
  }
  if (!isRecord(parsed)) return { tenants, errors: [`${ENV_NAME} must be a JSON object keyed by tenant id`] };

  const domainOwners = new Map<string, Set<string>>();
  const mailboxOwners = new Map<string, Set<string>>();
  for (const [tenantId, entry] of Object.entries(parsed)) {
    if (!TENANT_PATTERN.test(tenantId)) {
      errors.push(`${ENV_NAME}: invalid tenant id ${JSON.stringify(tenantId)}`);
      continue;
    }
    const list = Array.isArray(entry)
      ? entry
      : isRecord(entry)
        ? [...arrayOf(entry.domains), ...arrayOf(entry.mailboxes)]
        : null;
    if (!list) {
      errors.push(`${ENV_NAME}: tenant ${tenantId} must map to an array or {domains, mailboxes}`);
      continue;
    }
    const policy: GoogleDwdTenantPolicy = { tenantId, domains: [], mailboxes: [], excludedMailboxes: [], directoryAdmin: null };
    for (const item of list) {
      if (typeof item !== "string") {
        errors.push(`${ENV_NAME}: tenant ${tenantId} has a non-string entry`);
        continue;
      }
      const normalized = item.trim().toLowerCase();
      if (normalized.includes("@")) {
        const domain = domainOf(normalized);
        if (!domain || !DOMAIN_PATTERN.test(domain) || normalized.indexOf("@") !== normalized.lastIndexOf("@")) {
          errors.push(`${ENV_NAME}: tenant ${tenantId} has an invalid mailbox ${JSON.stringify(item)}`);
          continue;
        }
        if (CONSUMER_DOMAINS.has(domain)) {
          errors.push(`${ENV_NAME}: tenant ${tenantId} mailbox ${normalized} is a consumer account; DWD needs Workspace`);
          continue;
        }
        policy.mailboxes.push(normalized);
        addOwner(mailboxOwners, normalized, tenantId);
      } else {
        if (!DOMAIN_PATTERN.test(normalized)) {
          errors.push(`${ENV_NAME}: tenant ${tenantId} has an invalid domain ${JSON.stringify(item)}`);
          continue;
        }
        if (CONSUMER_DOMAINS.has(normalized)) {
          errors.push(`${ENV_NAME}: tenant ${tenantId} domain ${normalized} is a consumer domain; DWD needs Workspace`);
          continue;
        }
        policy.domains.push(normalized);
        addOwner(domainOwners, normalized, tenantId);
      }
    }
    if (isRecord(entry) && typeof entry.directoryAdmin === "string" && entry.directoryAdmin.trim()) {
      policy.directoryAdmin = entry.directoryAdmin.trim().toLowerCase();
    }
    tenants.set(tenantId, policy);
  }

  // Cross-tenant conflicts: refuse the entry everywhere it appears.
  const conflictedDomains = new Set([...domainOwners].filter(([, owners]) => owners.size > 1).map(([d]) => d));
  const conflictedMailboxes = new Set<string>();
  for (const [mailbox, owners] of mailboxOwners) {
    const domainOwnerSet = domainOwners.get(domainOf(mailbox) ?? "") ?? new Set<string>();
    const everyone = new Set([...owners, ...domainOwnerSet]);
    if (everyone.size > 1) conflictedMailboxes.add(mailbox);
  }
  for (const domain of conflictedDomains) {
    errors.push(`${ENV_NAME}: domain ${domain} is approved for multiple tenants (${[...domainOwners.get(domain)!].sort().join(", ")}); refused for all`);
  }
  for (const mailbox of conflictedMailboxes) {
    errors.push(`${ENV_NAME}: mailbox ${mailbox} is approved for multiple tenants; refused for all`);
  }
  for (const policy of tenants.values()) {
    policy.domains = unique(policy.domains.filter((d) => !conflictedDomains.has(d)));
    policy.mailboxes = unique(policy.mailboxes.filter((m) => !conflictedMailboxes.has(m)));
    policy.excludedMailboxes = unique([...conflictedMailboxes]);
    if (policy.directoryAdmin && !mailboxApproved(policy, policy.directoryAdmin)) {
      errors.push(`${ENV_NAME}: tenant ${policy.tenantId} directoryAdmin ${policy.directoryAdmin} is outside its approved domains/mailboxes; ignored`);
      policy.directoryAdmin = null;
    }
  }
  return { tenants, errors };
}

export function googleDwdPolicyFor(tenantId: string, policySet: GoogleDwdPolicySet = loadGoogleDwdPolicy()): GoogleDwdTenantPolicy | null {
  const policy = policySet.tenants.get(tenantId);
  if (!policy || (policy.domains.length === 0 && policy.mailboxes.length === 0)) return null;
  return policy;
}

export function isGoogleDwdMailboxApproved(
  tenantId: string,
  email: string,
  policySet: GoogleDwdPolicySet = loadGoogleDwdPolicy(),
): boolean {
  const policy = googleDwdPolicyFor(tenantId, policySet);
  return Boolean(policy && mailboxApproved(policy, email.trim().toLowerCase()));
}

export function assertGoogleDwdMailboxApproved(
  tenantId: string,
  email: string,
  policySet: GoogleDwdPolicySet = loadGoogleDwdPolicy(),
): string {
  const mailbox = email.trim().toLowerCase();
  if (!googleDwdPolicyFor(tenantId, policySet)) {
    throw new GoogleDwdNotApprovedError(
      "Google Workspace domain-wide delegation is not approved for this tenant. An operator must add the tenant's Workspace domain to GOOGLE_DWD_TENANT_APPROVALS.",
    );
  }
  if (!isGoogleDwdMailboxApproved(tenantId, mailbox, policySet)) {
    throw new GoogleDwdNotApprovedError(
      "This mailbox is outside the Workspace domains/mailboxes approved for domain-wide delegation on this tenant.",
    );
  }
  return mailbox;
}

function mailboxApproved(policy: GoogleDwdTenantPolicy, mailbox: string): boolean {
  if (policy.excludedMailboxes.includes(mailbox)) return false;
  if (policy.mailboxes.includes(mailbox)) return true;
  const domain = domainOf(mailbox);
  return Boolean(domain && policy.domains.includes(domain));
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  return email.slice(at + 1) || null;
}

function addOwner(map: Map<string, Set<string>>, key: string, tenantId: string): void {
  const owners = map.get(key) ?? new Set<string>();
  owners.add(tenantId);
  map.set(key, owners);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
