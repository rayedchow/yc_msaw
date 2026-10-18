import { WorkOS } from "@workos-inc/node";
import { env } from "../env.js";

export interface WorkosUserProfile {
  id: string;
  email: string;
  name: string | null;
  profilePictureUrl?: string | null;
}

export interface WorkosOrganizationProfile {
  id: string;
  name: string;
}

export interface WorkosAuthenticationResult {
  user: WorkosUserProfile;
  organization: WorkosOrganizationProfile;
}

export function isWorkosConfigured(): boolean {
  return Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID);
}

export function buildWorkosAuthorizationUrl(input: {
  redirectUri: string;
  state: string;
  email?: string;
  /** Org-scoped SSO: send the user to this organization's IdP connection
   * instead of the generic AuthKit picker. */
  organizationId?: string;
}): string {
  return workosClient().userManagement.getAuthorizationUrl({
    ...(input.organizationId
      ? { organizationId: input.organizationId }
      : { provider: "authkit", prompt: "select_account" }),
    redirectUri: input.redirectUri,
    state: input.state,
    ...(input.email ? { loginHint: input.email } : {}),
  });
}

// Consumer/personal email domains never map to an SSO organization.
const PERSONAL_EMAIL_DOMAINS = new Set([
  "aol.com", "gmail.com", "googlemail.com", "hotmail.com", "icloud.com",
  "live.com", "mac.com", "me.com", "msn.com", "outlook.com", "proton.me",
  "protonmail.com", "yahoo.com",
]);

// "Continue with SSO": a work email resolves to the ONE WorkOS organization
// with an active SSO connection for its domain. Anything else gets a friendly,
// actionable error instead of silently falling back to the regular flow.
export async function findWorkosSsoOrganizationForEmail(email: string): Promise<{
  organizationId: string;
  domain: string;
}> {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) throw new Error("Enter your work email to continue with SSO.");
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) {
    throw new Error("SSO is for work email domains. Use Continue to sign in with a personal email account.");
  }

  const connections = await workosClient().sso.listConnections({ domain });
  const organizationIds = [
    ...new Set(
      connections.data
        .filter((connection) => connection.state === "active" && connection.organizationId)
        .map((connection) => connection.organizationId as string),
    ),
  ];
  if (organizationIds.length === 0) {
    throw new Error("We couldn't find an SSO organization for that work email domain. Use Continue, or ask your admin to set up SSO.");
  }
  if (organizationIds.length > 1) {
    throw new Error("Multiple SSO organizations match that email domain. Ask support to choose the right workspace.");
  }
  return { organizationId: organizationIds[0], domain };
}

export async function authenticateWorkosCode(code: string): Promise<WorkosAuthenticationResult> {
  const workos = workosClient();
  const auth = await workos.userManagement.authenticateWithCode({ code });
  if (!auth.organizationId) {
    throw new Error("WorkOS did not return an organization.");
  }
  const organization = await workos.organizations.getOrganization(auth.organizationId);
  return {
    user: {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      profilePictureUrl: auth.user.profilePictureUrl,
    },
    organization: {
      id: organization.id,
      name: organization.name,
    },
  };
}

function workosClient(): WorkOS {
  if (!env.WORKOS_API_KEY || !env.WORKOS_CLIENT_ID) {
    throw new Error("WorkOS not configured");
  }
  return new WorkOS({
    apiKey: env.WORKOS_API_KEY,
    clientId: env.WORKOS_CLIENT_ID,
  });
}
