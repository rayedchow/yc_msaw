import { z } from "zod";
import type { ObjectStore } from "../store/objects.js";
import { childAudience, mintChildToken, type ChildAuthKeys } from "./child-auth.js";
import { canonicalJson, sha256 } from "../util.js";
import { isListed } from "./lifecycle.js";
import { IntegrationStore } from "./store.js";
import { defineTool, failed, succeeded, type IntegrationToolDefinition } from "./types.js";
import type { ValidationReceiptBody } from "./validate.js";

/**
 * Customer-facing catalog of LIVE child integration MCPs. The parent's /mcp endpoint stays
 * filesystem-only; the parent exposes this catalog through separate authenticated HTTP routes
 * (GET /v1/integrations, POST /v1/integrations/:slug/token; scope integrations:read; tenant and
 * subject from the verified caller). Entries carry only public connection metadata: nothing
 * here exposes repos, source, traces, research, receipts or builder credentials.
 *
 * Live = lifecycle active (not retired) AND an active Manufact deployment recorded as "running"
 * whose post-deploy MCP probe passed AND an mcpUrl (lifecycle.ts isListed). Every call reads durable state, so publish / update / retire /
 * restore show up on the next poll from any process (SDKs diff successive listings).
 */
export interface DeployedIntegration {
  slug: string;
  title: string;
  description: string;
  mcpUrl: string;
  tools: string[];
  commit: string;
  deploymentId: string;
  deployedAt: string;
  audience: string;
}

export class IntegrationCatalog {
  readonly #store: IntegrationStore;
  constructor(readonly ns: string, store: ObjectStore, private readonly childAuth: ChildAuthKeys | null) {
    this.#store = new IntegrationStore(store, ns);
  }

  async listDeployed(): Promise<DeployedIntegration[]> {
    const out: DeployedIntegration[] = [];
    for (const slug of await this.#store.list()) {
      const r = await this.#store.get(slug);
      const active = r?.manufact?.active;
      if (!r || !active || !isListed(r) || !r.manufact?.mcpUrl) continue;
      const v = (await this.#store.getReceipt(slug, active.validationReceiptId)) as unknown as ValidationReceiptBody | null;
      out.push({ slug, title: r.title, description: r.description, mcpUrl: r.manufact.mcpUrl, tools: v?.manifest?.tools ?? [], commit: active.commit, deploymentId: active.deploymentId, deployedAt: active.at, audience: childAudience(this.ns, slug) });
    }
    return out;
  }

  /**
   * Short-lived bearer for one LIVE child, bound to this tenant + integration audience. Returns
   * null for retired / not-live slugs. Already-issued tokens are stateless and stay valid at the
   * child until expiry (default 900 s, cap 3600 s) unless the deployment is stopped.
   */
  async accessToken(slug: string, principal: { subject: string }, ttlSeconds = 900) {
    if (!this.childAuth) throw new Error("Child auth is not configured on this host (INTEGRATION_CHILD_SIGNING_JWK)");
    const entry = (await this.listDeployed()).find((d) => d.slug === slug);
    if (!entry) return null;
    const t = mintChildToken(this.childAuth, { ns: this.ns, slug, subject: principal.subject, ttlSeconds });
    return { slug, mcpUrl: entry.mcpUrl, token: t.token, tokenType: "Bearer", expiresAt: t.expiresAt, audience: t.audience };
  }
}

/** Stable fingerprint of a catalog listing (order-independent); changes on any publish/edit/retire/restore. */
export function integrationCatalogFingerprint(entries: readonly DeployedIntegration[]): string {
  return sha256(canonicalJson([...entries].sort((a, b) => a.slug.localeCompare(b.slug))));
}

export function createIntegrationCatalog(p: { ns: string; store: ObjectStore; childAuth: ChildAuthKeys | null }): IntegrationCatalog {
  return new IntegrationCatalog(p.ns, p.store, p.childAuth);
}

/** Tools for the parent (customer) MCP. `principal` comes from the verified caller, never from input. */
export function createCustomerIntegrationTools(catalog: IntegrationCatalog, principal: { tenant: string; subject: string }): IntegrationToolDefinition[] {
  if (principal.tenant !== catalog.ns) throw new Error("Principal tenant does not match the catalog namespace");
  return [
    defineTool({
      name: "integrations_list",
      description: "List integration MCP servers deployed for your organization (URL, tools, active revision). Connect to one with a token from integration_access_token.",
      scope: "host-deploy",
      authority: "host integration catalog (only deployments that passed the live MCP probe)",
      mutates: false,
      input: z.object({}),
      run: async () => succeeded({ integrations: await catalog.listDeployed() }),
    }),
    defineTool({
      name: "integration_access_token",
      description: "Get a short-lived bearer token for one deployed integration MCP. Send it as `Authorization: Bearer <token>` to the returned mcpUrl.",
      scope: "host-deploy",
      authority: "host-minted EdDSA token (audience bound to this tenant + integration)",
      mutates: false,
      input: z.object({ slug: z.string(), ttlSeconds: z.number().int().min(60).max(3600).optional() }),
      run: async ({ slug, ttlSeconds }) => {
        const t = await catalog.accessToken(slug, { subject: principal.subject }, ttlSeconds ?? 900);
        return t ? succeeded(t) : failed("unknown_integration", `No active deployed integration ${slug}`);
      },
    }),
  ];
}
