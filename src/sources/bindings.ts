import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isTenantNs } from "../auth/tenant.js";
import type { ObjectStore } from "../store/objects.js";
import { PROVIDER_RE, SourceError } from "./paths.js";

/**
 * Source bindings: the only credentials that can write a tenant's sources/ tree.
 *
 * A binding is created by an authenticated admin of the namespace (HTTP route,
 * verified principal), lives in that namespace's `sources/bindings` ref, and is
 * limited to a set of provider directories. Its token is
 * `psb_<tenantNs>.<bindingId>.<secret>`: the namespace inside the token only says
 * where to look; authority comes from the stored sha256 matching in constant time.
 * Only the hash is stored, and revocation is immediate (the ref is read per request).
 */

export const BINDINGS_REF = "sources/bindings";
export const BINDING_TOKEN_PREFIX = "psb_";
const BINDING_ID_RE = /^sb-[0-9a-f]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_BINDINGS = 200;

export type BindingKind = "runtime" | "device";

/**
 * How a binding's holder delivers data. `publish` (default): the holder calls the publish
 * routes itself. `runtime-ingest`: a device whose raw uploads this server verifies and forwards
 * to the source runtime's receiver (e.g. the Mac iMessage uploader); such a binding can never
 * call the publish routes, so the device cannot write sources/ files directly.
 */
export type BindingTransport = "publish" | "runtime-ingest";

/**
 * Device uploader key family. The Mac iMessage uploader holds `gimsg_<tenantNs>.<bindingId>.<secret>`,
 * the same secret as the device binding's `psb_` token; only this family is mapped back to `psb_`
 * (verifyDeviceKey), and only on the device ingest proxy. It never authenticates MCP or admin routes.
 */
export const DEVICE_KEY_PREFIXES: Readonly<Record<string, string>> = { imessage: "gimsg_", "coding-sessions": "gcs_", "office-audio": "goa_" };

/** Providers a device (end-user machine) binding may write. */
export const DEVICE_PROVIDERS: readonly string[] = ["imessage", "coding-sessions", "office-audio"];

export interface BindingRecord {
  bindingId: string;
  kind: BindingKind;
  providers: string[];
  label: string | null;
  tokenSha256: string;
  createdAt: string;
  createdBy: { subject: string; issuer: string };
  revokedAt: string | null;
  /** Absent on bindings created before transports existed (= "publish"). */
  transport?: BindingTransport;
  /**
   * `runtime-provision`: minted by POST /v1/sources/runtime/provision, whose token is handed to the source runtime
   * and never returned to anyone. Only such a binding may report account owners (access.ts).
   */
  origin?: "runtime-provision";
  /** The device enrolment failed at the runtime: no device ever held this binding, so it confers no ownership. */
  enrolmentFailed?: boolean;
  /**
   * `owner-segment`: the runtime enrols this device into its creator's owner scope, and its data is published under
   * `<provider>/<creator's segment>/` (access.ts personalSegment). Absent: a device enrolled before owner scopes, whose
   * data sits in the provider directory itself (one owner per provider).
   */
  layout?: "owner-segment";
}

export interface BindingRegistry {
  schema: "procmem.source-bindings/v1";
  bindings: Record<string, BindingRecord>;
}

export interface VerifiedBinding {
  tenantNs: string;
  binding: BindingRecord;
}

export type PublicBinding = Omit<BindingRecord, "tokenSha256">;

export function publicBinding(record: BindingRecord): PublicBinding {
  const { tokenSha256: _hash, ...rest } = record;
  return rest;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function looksLikeBindingToken(token: string): boolean {
  return token.startsWith(BINDING_TOKEN_PREFIX);
}

/** Split a token into its lookup parts; null when malformed (callers answer 401 without detail). */
export function parseBindingToken(token: string): { tenantNs: string; bindingId: string } | null {
  if (!looksLikeBindingToken(token) || token.length > 200) return null;
  const parts = token.slice(BINDING_TOKEN_PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  const [tenantNs, bindingId, secret] = parts as [string, string, string];
  if (!isTenantNs(tenantNs) || !BINDING_ID_RE.test(bindingId) || !SECRET_RE.test(secret)) return null;
  return { tenantNs, bindingId };
}

/** The device key for a binding token of `provider` (same secret, the uploader's token family). */
export function deviceKeyForBindingToken(provider: string, token: string): string {
  const prefix = DEVICE_KEY_PREFIXES[provider];
  if (!prefix || !parseBindingToken(token)) throw new SourceError("invalid_input", `No device key family for ${provider}`);
  return `${prefix}${token.slice(BINDING_TOKEN_PREFIX.length)}`;
}

/** The binding token a device key of `provider` stands for; null for any other string (including other families). */
export function bindingTokenForDeviceKey(provider: string, key: string): string | null {
  const prefix = DEVICE_KEY_PREFIXES[provider];
  if (!prefix || typeof key !== "string" || !key.startsWith(prefix) || key.length > 200) return null;
  const token = `${BINDING_TOKEN_PREFIX}${key.slice(prefix.length)}`;
  return parseBindingToken(token) ? token : null;
}

export class SourceBindings {
  readonly #epochs = new Map<string, number>();

  constructor(private readonly store: ObjectStore) {}

  /** Changes whenever this process changes the registry of `ns` (lets readers drop cached owner evidence). */
  epoch(ns: string): number {
    return this.#epochs.get(ns) ?? 0;
  }

  async registry(ns: string): Promise<{ value: BindingRegistry; version: number | null }> {
    const ref = await this.store.getRef(ns, BINDINGS_REF);
    if (!ref) return { value: { schema: "procmem.source-bindings/v1", bindings: {} }, version: null };
    return { value: ref.value as BindingRegistry, version: ref.version };
  }

  async list(ns: string): Promise<PublicBinding[]> {
    const { value } = await this.registry(ns);
    return Object.values(value.bindings)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(publicBinding);
  }

  /** Mint a binding for `ns` (already the verified caller's namespace). Returns the token exactly once. */
  async create(
    ns: string,
    input: { kind: BindingKind; providers: string[]; label?: string | null; transport?: BindingTransport; origin?: "runtime-provision"; layout?: "owner-segment" },
    createdBy: { subject: string; issuer: string },
    opts: { unownedData?: (provider: string) => boolean } = {},
  ): Promise<{ binding: PublicBinding; token: string }> {
    const providers = [...new Set(input.providers)].sort();
    if (providers.length === 0 || providers.length > 32) throw new SourceError("invalid_input", "providers must list 1-32 provider ids");
    for (const p of providers) {
      if (p !== "*" && !PROVIDER_RE.test(p)) throw new SourceError("invalid_input", `Invalid provider id ${JSON.stringify(p)}`);
    }
    if (input.kind === "device" && providers.some((p) => !DEVICE_PROVIDERS.includes(p))) {
      throw new SourceError("forbidden_provider", `Device bindings may only write ${DEVICE_PROVIDERS.join(", ")}`);
    }
    if (input.transport === "runtime-ingest" && input.kind !== "device") throw new SourceError("invalid_input", "Only device bindings use runtime ingest");
    // Device bindings never publish: their data goes through the runtime receiver (revocation, consent gate).
    if (input.kind === "device" && input.transport !== "runtime-ingest") throw new SourceError("invalid_input", "Device bindings must use runtime ingest");
    const label = input.label === undefined || input.label === null ? null : String(input.label).slice(0, 200);
    const bindingId = `sb-${randomBytes(8).toString("hex")}`;
    const secret = randomBytes(32).toString("base64url");
    const token = `${BINDING_TOKEN_PREFIX}${ns}.${bindingId}.${secret}`;
    const record: BindingRecord = {
      bindingId,
      kind: input.kind,
      providers,
      label,
      tokenSha256: hashToken(token).toString("hex"),
      createdAt: new Date().toISOString(),
      createdBy,
      revokedAt: null,
      ...(input.transport === "runtime-ingest" ? { transport: "runtime-ingest" as const } : {}),
      ...(input.origin === "runtime-provision" ? { origin: "runtime-provision" as const } : {}),
      ...(input.kind === "device" && input.layout === "owner-segment" ? { layout: "owner-segment" as const } : {}),
    };
    await this.#update(ns, (reg) => {
      const active = Object.values(reg.bindings).filter((b) => !b.revokedAt).length;
      if (active >= MAX_BINDINGS) throw new SourceError("invalid_input", `At most ${MAX_BINDINGS} active bindings per tenant`);
      // A device provider's directory is personal and has exactly one owner (access.ts): every device binding
      // for it, revoked ones included, must come from the same principal. Checked inside the registry CAS.
      // An owner-segment device writes only under its creator's own segment: any number of members enrol their own.
      if (input.kind === "device" && input.layout !== "owner-segment") {
        for (const p of providers) {
          const prior = Object.values(reg.bindings).filter((b) => b.kind === "device" && !b.enrolmentFailed && b.providers.includes(p));
          if (prior.some((b) => b.createdBy.subject !== createdBy.subject || b.createdBy.issuer !== createdBy.issuer)) {
            throw new SourceError("owner_conflict", `${p} in this tenant is already enrolled by another member; personal sources have exactly one owner`, { provider: p });
          }
          if (prior.length === 0 && opts.unownedData?.(p)) {
            throw new SourceError("owner_conflict", `$SOURCES/${p} already holds data captured before owners were recorded; it stays unreadable and cannot be claimed by enrolling`, { provider: p, reason: "unowned_legacy_data" });
          }
        }
      }
      reg.bindings[bindingId] = record;
    });
    return { binding: publicBinding(record), token };
  }

  async revoke(ns: string, bindingId: string, opts: { enrolmentFailed?: boolean } = {}): Promise<PublicBinding | null> {
    if (!BINDING_ID_RE.test(bindingId)) return null;
    let out: PublicBinding | null = null;
    await this.#update(ns, (reg) => {
      const b = reg.bindings[bindingId];
      if (!b) return;
      if (!b.revokedAt) b.revokedAt = new Date().toISOString();
      if (opts.enrolmentFailed) b.enrolmentFailed = true;
      out = publicBinding(b);
    });
    return out;
  }

  /** Verify a presented token. Returns null for anything that is not an active binding. */
  async verify(token: string): Promise<VerifiedBinding | null> {
    const parsed = parseBindingToken(token);
    if (!parsed) return null;
    const { value } = await this.registry(parsed.tenantNs);
    const record = value.bindings[parsed.bindingId];
    const presented = hashToken(token);
    // Compare against a fixed-size digest even when the record is missing, so timing does not reveal ids.
    const expected = record ? Buffer.from(record.tokenSha256, "hex") : Buffer.alloc(32);
    const match = timingSafeEqual(presented, expected.length === 32 ? expected : Buffer.alloc(32));
    if (!record || !match || record.revokedAt) return null;
    return { tenantNs: parsed.tenantNs, binding: record };
  }

  /**
   * Verify a device uploader key for `provider`: only that provider's key family, mapped to its
   * binding token and checked with verify() (revocation read per request), and only for an active
   * `kind=device`, `transport=runtime-ingest` binding that lists the provider.
   */
  async verifyDeviceKey(provider: string, key: string | null | undefined): Promise<VerifiedBinding | null> {
    const token = key ? bindingTokenForDeviceKey(provider, key) : null;
    if (!token) return null;
    const verified = await this.verify(token);
    if (!verified) return null;
    const b = verified.binding;
    if (b.kind !== "device" || b.transport !== "runtime-ingest" || !b.providers.includes(provider)) return null;
    return verified;
  }

  async #update(ns: string, mutate: (reg: BindingRegistry) => void): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { value, version } = await this.registry(ns);
      const next = structuredClone(value);
      mutate(next);
      const r = await this.store.casRef(ns, BINDINGS_REF, version, next);
      if (r.ok) {
        this.#epochs.set(ns, (this.#epochs.get(ns) ?? 0) + 1);
        return;
      }
    }
    throw new SourceError("conflict", "Binding registry is busy; retry");
  }
}
