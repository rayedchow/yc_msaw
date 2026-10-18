import type { ObjectStore } from "../store/objects.js";
import type { BindingRecord } from "./bindings.js";
import { SourceError } from "./paths.js";

/**
 * Owner-only reads of personal sources.
 *
 * Members of one WorkOS/OIDC organization share a tenant namespace (docs/auth.md), so tenant
 * isolation alone would let every member read every colleague's mailbox, Messages history or
 * recordings. Personal source directories are therefore readable only by their owner: the
 * verified principal (issuer + subject, never a request field or a provider payload) who
 * enrolled the account or device.
 *
 * Owner evidence, all server-side:
 * - device providers (imessage, coding-sessions, office-audio): `createdBy` of every device
 *   binding for that provider, including revoked ones (revoking a Mac does not hand its history
 *   to someone else);
 * - connected personal accounts (granola, zoom, cursor-agents, whatsapp/instagram personal):
 *   the principal that connected them through POST /v1/sources/connect/<provider>, recorded in
 *   the `sources/owners` ref;
 * - Google mailboxes (gmail, calendar, google-contacts, google-docs, Drive binaries): the subject
 *   that started the Google OAuth/Composio grant for that address, which Google confirmed by the
 *   account check at the callback. The runtime reports these with its status heartbeat (only a
 *   `*` runtime binding may). A domain-wide-delegation mailbox has no such subject and stays
 *   unowned until its owner completes the OAuth grant for the same address.
 *
 * Anything unowned, owned by more than one principal, or not attributable to one account from its
 * path (e.g. the donor calendar month files that mix mailboxes) is denied to everyone. Shared
 * workspace providers (SHARED_PROVIDERS plus the operator's SOURCES_SHARED_PROVIDERS) stay readable
 * by the whole tenant, except Slack direct messages; every other provider is denied (default deny).
 */

export const OWNERS_REF = "sources/owners";

export interface Identity {
  subject: string;
  issuer: string;
}

export interface OwnerEntry extends Identity {
  provider: string;
  via: "connect";
  at: string;
}

export interface OwnerRegistry {
  schema: "procmem.source-owners/v1";
  entries: OwnerEntry[];
}

/** One Google address the runtime collects, with the verified grant subject (null = unowned, e.g. DWD only). */
export interface GoogleAccountOwner {
  account: string;
  subject: string | null;
  issuer: string | null;
}

/** Device providers: owned by the principals that enrolled devices for them. */
export const DEVICE_OWNED_PROVIDERS: readonly string[] = ["imessage", "coding-sessions", "office-audio"];
/** Connected personal accounts without an account segment in their paths: one owner per tenant. */
export const CONNECT_OWNED_PROVIDERS: readonly string[] = ["granola", "zoom", "cursor-agents", "whatsapp-personal", "instagram-personal"];
/** Google providers laid out per mailbox (`<mailbox>/` or `accounts/<mailbox>/`). */
const GOOGLE_ACCOUNT_PROVIDERS: Readonly<Record<string, "first" | "accounts">> = { gmail: "first", calendar: "accounts", "google-contacts": "accounts" };
/** Google providers with no mailbox in the path: readable only by the principal that owns every Google account. */
const GOOGLE_WIDE_PROVIDERS: readonly string[] = ["google-docs"];
/** Runtime credential lane that reports per-mailbox grant coverage (no files). */
const GOOGLE_AUTH_STATUS_PROVIDER = "google-auth";
/** Workspace providers every member of the tenant reads (org data, not one person's account). */
export const SHARED_PROVIDERS: readonly string[] = ["slack", "notion", "confluence", "jira", "github", "bitbucket", "linear", "discord", "stripe"];
/**
 * sources/binary/<provider>/...: Google-wide (drive-pdf) or denied. `slack` legacy rows carry no conversation, so a
 * DM attachment cannot be told apart from a channel file: denied; `upload` has no recorded owner: denied.
 */
const BINARY_GOOGLE = new Set(["drive-pdf"]);
/** Slack direct-message conversation ids (D…), as a path segment or `<id>.json`. */
const SLACK_DM_RE = /^D[A-Z0-9]{6,}(\.json)?$/;

export const PERSONAL_PROVIDERS: readonly string[] = [
  ...DEVICE_OWNED_PROVIDERS,
  ...CONNECT_OWNED_PROVIDERS,
  ...Object.keys(GOOGLE_ACCOUNT_PROVIDERS),
  ...GOOGLE_WIDE_PROVIDERS,
];

export function isPersonalProvider(provider: string): boolean {
  return PERSONAL_PROVIDERS.includes(provider);
}

/** allow: the path and everything below it; deny: nothing; mixed: a directory whose children must be checked one by one. */
export type Access = "allow" | "deny" | "mixed";

const same = (a: Identity | null | undefined, b: Identity) => !!a && a.subject === b.subject && a.issuer === b.issuer;

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return seg.toLowerCase();
  }
}

/** The read view of one verified principal over one tenant's $SOURCES. */
export class SourceViewer {
  readonly #owned: Set<string>;
  readonly #ownedAccounts: Set<string>;
  readonly #ownsAllGoogle: boolean;

  readonly #shared: ReadonlySet<string>;
  /** Google-wide units (runtime attribution) this principal reads in full, and every directory above one. */
  readonly #units: ReadonlySet<string>;
  readonly #unitParents: ReadonlySet<string>;

  constructor(
    readonly who: Identity,
    input: {
      providerOwners: ReadonlyMap<string, readonly Identity[]>;
      googleAccounts: readonly GoogleAccountOwner[];
      sharedProviders?: readonly string[];
      /**
       * Mailbox-less Google units (google-docs/<doc>, google-docs/_drive/<class>/<file>, google-docs/_raw/document:<id>,
       * binary/drive-pdf/<id>) that one of this principal's proven mailboxes sees in Drive. Only units that mailbox may
       * also read revisions of are served: their history, changelog and comments are part of the unit.
       */
      googleUnits?: readonly { path: string; revisions: boolean }[];
    },
  ) {
    const units = new Set<string>();
    const parents = new Set<string>();
    for (const u of input.googleUnits ?? []) {
      if (!u.revisions || !/^(google-docs|binary\/drive-pdf)\/[^/]/.test(u.path)) continue;
      units.add(u.path);
      const seg = u.path.split("/");
      for (let i = 1; i < seg.length; i++) parents.add(seg.slice(0, i).join("/"));
    }
    this.#units = units;
    this.#unitParents = parents;
    this.#shared = new Set([...SHARED_PROVIDERS, ...(input.sharedProviders ?? [])].filter((p) => !PERSONAL_PROVIDERS.includes(p) && p !== "binary"));
    this.#owned = new Set();
    for (const [provider, owners] of input.providerOwners) {
      // Exactly one owner, and it is the caller. Two owners is ambiguous: nobody reads.
      const distinct = new Map(owners.map((o) => [`${o.issuer}\n${o.subject}`, o]));
      if (distinct.size === 1 && same([...distinct.values()][0], who)) this.#owned.add(provider);
    }
    const byAccount = new Map<string, GoogleAccountOwner[]>();
    for (const a of input.googleAccounts) {
      const k = a.account.trim().toLowerCase();
      byAccount.set(k, [...(byAccount.get(k) ?? []), a]);
    }
    this.#ownedAccounts = new Set(
      [...byAccount].filter(([, rows]) => rows.every((r) => r.subject !== null && r.issuer !== null && same({ subject: r.subject, issuer: r.issuer }, who))).map(([k]) => k),
    );
    this.#ownsAllGoogle = byAccount.size > 0 && this.#ownedAccounts.size === byAccount.size;
    this.#unownedAccounts = new Set([...byAccount].filter(([, rows]) => rows.every((r) => r.subject === null)).map(([k]) => k));
  }

  readonly #unownedAccounts: Set<string>;

  /** Google addresses nobody owns yet (e.g. domain-wide-delegated mailboxes an admin added), lower case. */
  get unownedGoogleAccounts(): readonly string[] {
    return [...this.#unownedAccounts].sort();
  }

  /** Google addresses this principal owns (lower case). */
  get googleAccounts(): readonly string[] {
    return [...this.#ownedAccounts].sort();
  }

  /** Access to a stored path ("" = the root). */
  access(stored: string): Access {
    if (stored === "") return "mixed";
    const seg = stored.split("/");
    const provider = seg[0]!;
    if (DEVICE_OWNED_PROVIDERS.includes(provider) || CONNECT_OWNED_PROVIDERS.includes(provider)) return this.#owned.has(provider) ? "allow" : "deny";
    if (GOOGLE_WIDE_PROVIDERS.includes(provider)) return this.#unitAccess(seg);
    const layout = GOOGLE_ACCOUNT_PROVIDERS[provider];
    if (layout) return this.#googleAccountPath(seg, layout);
    // Status-only provider of the Google credential lane: its coverage names mailboxes.
    if (provider === GOOGLE_AUTH_STATUS_PROVIDER) return this.#ownsAllGoogle ? "allow" : this.#ownedAccounts.size > 0 ? "mixed" : "deny";
    if (provider === "binary") {
      if (seg.length === 1) return this.#unitParents.has("binary") ? "mixed" : "deny";
      if (BINARY_GOOGLE.has(seg[1]!)) return this.#unitAccess(seg);
      return "deny";
    }
    if (provider === "slack") {
      if (seg.some((s) => SLACK_DM_RE.test(s))) return "deny";
      // Directories that (transitively) hold conversations: filter their children, withhold their totals.
      if (seg.length === 1) return "mixed";
      if ((seg[1] === "_workspaces" && seg.length <= 4) || (seg[1] === "_raw" && seg.length <= 3)) return "mixed";
      return "allow";
    }
    // Default deny: a provider nobody declared shared (e.g. an operator-configured Nango source) has no owner.
    return this.#shared.has(provider) ? "allow" : "deny";
  }

  /** A Google-wide path: inside one of the caller's units, a directory above some, or nobody's business. */
  #unitAccess(seg: readonly string[]): Access {
    for (let i = 1; i <= seg.length; i++) if (this.#units.has(seg.slice(0, i).join("/"))) return "allow";
    return this.#unitParents.has(seg.join("/")) ? "mixed" : "deny";
  }

  #googleAccountPath(seg: string[], layout: "first" | "accounts"): Access {
    // A mailbox container may also hold mailboxes nobody reports any more (removed accounts): always filter children.
    const container = this.#ownedAccounts.size > 0 ? "mixed" : "deny";
    if (seg.length === 1) return container;
    // `_raw/<namespace>/...`: the namespace is the mailbox when it looks like one.
    if (seg[1] === "_raw") {
      if (seg.length === 2) return container;
      return this.#account(seg[2]!);
    }
    if (layout === "accounts") {
      if (seg[1] === "accounts") return seg.length === 2 ? container : this.#account(seg[2]!);
      return this.#ownsAllGoogle ? "allow" : "deny";
    }
    return this.#account(seg[1]!);
  }

  #account(seg: string): Access {
    // Raw ledger namespaces carry a kind prefix (`gmail/_raw/mailbox:<address>/`, runtime activity-event-source.ts).
    const account = decodeSegment(seg).replace(/^mailbox:/, "");
    if (!account.includes("@")) return this.#ownsAllGoogle ? "allow" : "deny";
    return this.#ownedAccounts.has(account) ? "allow" : "deny";
  }

  canRead(stored: string): boolean {
    return this.access(stored) !== "deny";
  }

  /**
   * Whether a coverage report of a partially visible provider may be shown: it must name one of
   * the caller's own accounts (Google), or must not name a direct message (Slack). Tenant-wide
   * reports of such a provider (backlog counts, other mailboxes) are withheld.
   */
  coverageVisible(provider: string, c: { scope: string; reason?: string }): boolean {
    const access = this.access(provider);
    if (access === "allow") return true;
    if (access === "deny") return false;
    if (GOOGLE_ACCOUNT_PROVIDERS[provider] || provider === GOOGLE_AUTH_STATUS_PROVIDER) {
      // Whole-token match (an owner of an@x must not see dan@x), and the reason may name no other address.
      const tokens = (t: string) => t.toLowerCase().split(/[\s:/,;()[\]"'<>=]+/).filter(Boolean);
      const scopeTokens = tokens(c.scope);
      if (![...this.#ownedAccounts].some((a) => scopeTokens.includes(a))) return false;
      return [...tokens(c.scope), ...tokens(c.reason ?? "")].filter((t) => t.includes("@")).every((t) => this.#ownedAccounts.has(t));
    }
    if (provider === "slack") return ![c.scope, c.reason ?? ""].some((t) => /\bD[A-Z0-9]{6,}\b/.test(t));
    if (provider === "binary") return this.#ownsAllGoogle && /\bdrive-pdf\b/.test(c.scope);
    return false;
  }
}

/** `sources/owners`: principals that connected a personal account through yc_msaw. */
export class SourceOwners {
  readonly #epochs = new Map<string, number>();

  constructor(private readonly store: ObjectStore) {}

  /** Changes whenever this process changes the registry of `ns` (lets readers drop cached owner evidence). */
  epoch(ns: string): number {
    return this.#epochs.get(ns) ?? 0;
  }

  async registry(ns: string): Promise<{ value: OwnerRegistry; version: number | null }> {
    const ref = await this.store.getRef(ns, OWNERS_REF);
    if (!ref) return { value: { schema: "procmem.source-owners/v1", entries: [] }, version: null };
    return { value: ref.value as OwnerRegistry, version: ref.version };
  }

  /**
   * Record `who` as the owner of `provider` before it is connected. Refused when another principal
   * already owns it (two owners would make the directory unreadable for both), and when the
   * directory already holds data that nobody owns (legacy capture: it stays sealed). Returns
   * whether this call created the entry, so a failed connect can roll it back.
   */
  async claim(ns: string, provider: string, who: Identity, opts: { hasUnownedData: boolean; otherOwners?: readonly Identity[] }): Promise<{ created: boolean }> {
    let created = false;
    await this.#update(ns, (reg) => {
      const owners = [...reg.entries.filter((e) => e.provider === provider), ...(opts.otherOwners ?? [])];
      const others = owners.filter((o) => !same(o, who));
      if (others.length > 0) {
        throw new SourceError("owner_conflict", `${provider} in this tenant is already owned by another member; personal sources have exactly one owner`, { provider });
      }
      if (owners.length === 0 && opts.hasUnownedData) {
        throw new SourceError(
          "owner_conflict",
          `$SOURCES/${provider} already holds data captured before owners were recorded; it stays unreadable and cannot be claimed by connecting again`,
          { provider, reason: "unowned_legacy_data" },
        );
      }
      if (!reg.entries.some((e) => e.provider === provider && same(e, who))) {
        reg.entries.push({ provider, subject: who.subject, issuer: who.issuer, via: "connect", at: new Date().toISOString() });
        created = true;
      }
    });
    return { created };
  }

  async release(ns: string, provider: string, who: Identity): Promise<void> {
    await this.#update(ns, (reg) => {
      reg.entries = reg.entries.filter((e) => !(e.provider === provider && same(e, who)));
    });
  }

  async #update(ns: string, mutate: (reg: OwnerRegistry) => void): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { value, version } = await this.registry(ns);
      const next = structuredClone(value);
      mutate(next);
      const r = await this.store.casRef(ns, OWNERS_REF, version, next);
      if (r.ok) {
        this.#epochs.set(ns, (this.#epochs.get(ns) ?? 0) + 1);
        return;
      }
    }
    throw new SourceError("conflict", "Owner registry is busy; retry");
  }
}

/** Owners per provider from device bindings (all, including revoked) and the owner registry. */
export function providerOwners(bindings: readonly Pick<BindingRecord, "kind" | "providers" | "createdBy" | "enrolmentFailed">[], registry: OwnerRegistry): Map<string, Identity[]> {
  const out = new Map<string, Identity[]>();
  const add = (p: string, who: Identity) => out.set(p, [...(out.get(p) ?? []), { subject: who.subject, issuer: who.issuer }]);
  for (const b of bindings) {
    if (b.kind !== "device" || b.enrolmentFailed) continue;
    for (const p of b.providers) if (DEVICE_OWNED_PROVIDERS.includes(p)) add(p, b.createdBy);
  }
  for (const e of registry.entries) if (CONNECT_OWNED_PROVIDERS.includes(e.provider)) add(e.provider, e);
  return out;
}
