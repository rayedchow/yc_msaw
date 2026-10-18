import type { Principal } from "../auth/mcp.js";
import { SourceError } from "./paths.js";

/**
 * yc_msaw -> source runtime internal API (packages/sources-runtime src/source-lane/internal/app.ts).
 *
 * The service token is held by this server only (SOURCES_RUNTIME_SERVICE_TOKEN);
 * callers never see it. The tenant in every forwarded URL and the
 * `x-procmem-principal` header come from the principal verified by
 * authenticateHttp, so a caller cannot choose a tenant or user.
 */

export const PRINCIPAL_HEADER = "x-procmem-principal";
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TIMEOUT_MS = 30_000;

export interface SourceRuntimeConfig {
  /** Base URL of the runtime internal API, e.g. http://127.0.0.1:3201 (or .../internal/v1 when mounted on the public port). */
  url: string;
  serviceToken: string;
  /** Public base URL the runtime publishes to (this server). */
  publishUrl: string;
  /**
   * Public base URL of the runtime's device uploader host (SOURCES_DEVICE_API_URL), handed to
   * devices as their `apiUrl`. Unset: device setup answers 503 (no device ingest configured).
   */
  deviceApiUrl: string | null;
}

export function loadSourceRuntimeConfig(env: NodeJS.ProcessEnv, publicUrl: string): SourceRuntimeConfig | null {
  const url = env.SOURCES_RUNTIME_URL?.trim();
  const serviceToken = env.SOURCES_RUNTIME_SERVICE_TOKEN?.trim();
  if (!url || !serviceToken) return null;
  const u = new URL(url);
  if (u.username || u.password || u.search || u.hash) throw new Error("SOURCES_RUNTIME_URL must not embed credentials, query or fragment");
  if (serviceToken.length < 32) throw new Error("SOURCES_RUNTIME_SERVICE_TOKEN must be at least 32 characters");
  const publishUrl = (env.SOURCES_PUBLISH_URL?.trim() || new URL(publicUrl).origin).replace(/\/+$/, "");
  const deviceRaw = env.SOURCES_DEVICE_API_URL?.trim();
  let deviceApiUrl: string | null = null;
  if (deviceRaw) {
    const d = new URL(deviceRaw);
    if (d.username || d.password || d.search || d.hash) throw new Error("SOURCES_DEVICE_API_URL must not embed credentials, query or fragment");
    deviceApiUrl = d.href.replace(/\/+$/, "");
  }
  return { url: u.href.replace(/\/+$/, ""), serviceToken, publishUrl, deviceApiUrl };
}

export type GoogleAuthAction = "status" | "oauth.start" | "dwd.add" | "account.delete";

/** Generic Nango records lane setup (runtime providers/nango-records). */
export type NangoRecordsAction = "status" | "session.create" | "session.get" | "connection.delete" | "sync";
const NANGO_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RuntimeResponse {
  status: number;
  body: unknown;
}

export class SourceRuntimeClient {
  constructor(
    readonly config: SourceRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  #principalHeader(p: Principal): string {
    return JSON.stringify({
      tenantNs: p.tenantNs,
      subject: p.subject,
      issuer: p.issuer,
      ...(p.email !== undefined ? { email: p.email } : {}),
      ...(p.organizationId !== undefined ? { organizationId: p.organizationId } : {}),
      scopes: [...p.scopes],
    });
  }

  async #call(p: Principal, method: string, route: string, body?: unknown): Promise<RuntimeResponse> {
    const res = await this.fetchImpl(`${this.config.url}/tenants/${encodeURIComponent(p.tenantNs)}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.serviceToken}`,
        [PRINCIPAL_HEADER]: this.#principalHeader(p),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: { code: "runtime_invalid_response", message: text.slice(0, 500) } };
    }
    return { status: res.status, body: parsed };
  }

  provisionBinding(p: Principal, binding: { bindingId: string; token: string; providers: string[] }): Promise<RuntimeResponse> {
    return this.#call(p, "PUT", "/binding", { ...binding, publishUrl: this.config.publishUrl });
  }

  status(p: Principal): Promise<RuntimeResponse> {
    return this.#call(p, "GET", "/status");
  }

  connect(p: Principal, provider: string, body: unknown): Promise<RuntimeResponse> {
    assertProvider(provider);
    return this.#call(p, "POST", `/connect/${provider}`, body ?? {});
  }

  disconnect(p: Principal, provider: string): Promise<RuntimeResponse> {
    assertProvider(provider);
    return this.#call(p, "DELETE", `/connections/${provider}`);
  }

  /** Google provider-grant setup (runtime providers/google-auth). A fixed allowlist of routes. */
  googleAuth(p: Principal, action: GoogleAuthAction, input: { body?: unknown; email?: string } = {}): Promise<RuntimeResponse> {
    switch (action) {
      case "status":
        return this.#call(p, "GET", "/google/auth");
      case "oauth.start":
        return this.#call(p, "POST", "/google/auth/oauth/start", input.body ?? {});
      case "dwd.add":
        return this.#call(p, "POST", "/google/auth/dwd/mailboxes", input.body ?? {});
      case "account.delete": {
        const email = (input.email ?? "").trim().toLowerCase();
        if (!/^[^\s@/]+@[^\s@/]+$/.test(email) || email.length > 320) throw new SourceError("invalid_input", "Invalid Google account email");
        return this.#call(p, "DELETE", `/google/auth/accounts/${encodeURIComponent(email)}`);
      }
    }
  }

  /** Generic Nango records lane (runtime providers/nango-records). A fixed allowlist of routes; ids are validated here. */
  nangoRecords(p: Principal, action: NangoRecordsAction, input: { body?: unknown; sessionId?: string; source?: string; connectionId?: string } = {}): Promise<RuntimeResponse> {
    switch (action) {
      case "status":
        return this.#call(p, "GET", "/nango-records");
      case "session.create":
        return this.#call(p, "POST", "/nango-records/connect-sessions", input.body ?? {});
      case "session.get": {
        if (!NANGO_SESSION_ID_RE.test(input.sessionId ?? "")) throw new SourceError("invalid_input", "Invalid connect session id");
        return this.#call(p, "GET", `/nango-records/connect-sessions/${input.sessionId!.toLowerCase()}`);
      }
      case "connection.delete": {
        assertProvider(input.source ?? "");
        const id = input.connectionId ?? "";
        if (!id || id.length > 512 || /[\u0000-\u001f]/.test(id)) throw new SourceError("invalid_input", "Invalid connection id");
        return this.#call(p, "DELETE", `/nango-records/connections/${input.source}/${encodeURIComponent(id)}`);
      }
      case "sync":
        return this.#call(p, "POST", "/nango-records/sync", input.body ?? {});
    }
  }

  /** Jira deep-lane project selection (runtime providers/jira/routes.ts). Fixed routes; the tenant is the verified principal's. */
  jiraSelection(p: Principal, action: "get" | "put", body?: unknown): Promise<RuntimeResponse> {
    return action === "get" ? this.#call(p, "GET", "/jira/selection") : this.#call(p, "PUT", "/jira/selection", body ?? {});
  }

  /** GitHub repository selection (runtime providers/github/routes.ts; github patch request 3). */
  githubRepositories(p: Principal, action: "get" | "put", body?: unknown): Promise<RuntimeResponse> {
    return action === "get" ? this.#call(p, "GET", "/github/repositories") : this.#call(p, "PUT", "/github/repositories/selection", body ?? {});
  }

  /** Device enrolment (e.g. the Mac iMessage uploader token), implemented by the provider's internal route. */
  device(p: Principal, provider: string, body: unknown): Promise<RuntimeResponse> {
    assertProvider(provider);
    return this.#call(p, "POST", `/devices/${provider}`, body ?? {});
  }

  /** Revoke a device's runtime ingest credential (forwarded when its device binding is revoked here). */
  deviceRevoke(p: Principal, provider: string, bindingId: string): Promise<RuntimeResponse> {
    assertProvider(provider);
    if (!/^sb-[0-9a-f]{16}$/.test(bindingId)) throw new SourceError("invalid_input", "Invalid binding id");
    return this.#call(p, "DELETE", `/devices/${provider}/${bindingId}`);
  }
}

function assertProvider(provider: string): void {
  if (!PROVIDER_RE.test(provider)) throw new SourceError("invalid_input", "Invalid provider id");
}
