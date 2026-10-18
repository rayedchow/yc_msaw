import { createHash } from "node:crypto";
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
 * - connected personal accounts (granola, zoom, cursor-agents, whatsapp/instagram personal): each
 *   member's accounts are collected in their own runtime owner scope and published under
 *   `<provider>/<segment>/`, where the segment is derived from the verified principal (personalSegment;
 *   runtime core/personal-scope.ts computes the same). Any number of members connect their own accounts;
 *   unsegmented paths (captured before owner scopes) belong to nobody;
 * - Google mailboxes (gmail, calendar, google-contacts, google-docs, Drive binaries): the subject
 *   that started the Google OAuth/Composio grant for that address, which Google confirmed by the
 *   account check at the callback. The runtime reports these with its status heartbeat (only a
 *   `*` runtime binding may). A domain-wide-delegation mailbox has no such subject and stays
 *   unowned until its owner completes the OAuth grant for the same address.
 *
 * A Doc, Sheet, Slides deck, Drive file or Drive PDF a proven mailbox may only read or comment on (Drive
 * `canReadRevisions` false) is a view-only unit: its shared directory (captured under another credential, with
 * writer-only history, suggestions, byte versions and permissions) is withheld, and the runtime captures that mailbox's
 * own current view (and the comments Google returns to it) under its own credential into
 * `google-docs/_accounts/<mailbox>/`, which, like `gmail/<mailbox>/`, belongs to the owner of that mailbox.
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
/** Connected personal accounts: `<provider>/<owner segment>/...`, one subtree per connecting member. */
export const CONNECT_OWNED_PROVIDERS: readonly string[] = ["granola", "zoom", "cursor-agents", "whatsapp-personal", "instagram-personal"];
/** Google providers laid out per mailbox (`<mailbox>/` or `accounts/<mailbox>/`). */
const GOOGLE_ACCOUNT_PROVIDERS: Readonly<Record<string, "first" | "accounts">> = { gmail: "first", calendar: "accounts", "google-contacts": "accounts" };
/** Google providers with no mailbox in the path: readable per unit through runtime attribution. */
const GOOGLE_WIDE_PROVIDERS: readonly string[] = ["google-docs"];
/** `google-docs/_accounts/<mailbox>/`: one mailbox's own captures of files it may only view (runtime account-capture.ts). */
const GOOGLE_ACCOUNT_VIEWS = "_accounts";
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

/**
 * Providers whose members' data lives in per-member owner segments (`<provider>/<segment>/`): the connect-owned
 * personal integrations and every provider nobody declared shared (e.g. a personal Nango records source such as
 * Outlook, which the runtime collects in the connecting member's owner scope). Everything else under such a provider
 * (unsegmented, captured before owner scopes) belongs to nobody.
 */
export function isOwnerSegmentProvider(provider: string, shared: ReadonlySet<string>): boolean {
  if (CONNECT_OWNED_PROVIDERS.includes(provider) || DEVICE_OWNED_PROVIDERS.includes(provider)) return true;
  return !PERSONAL_PROVIDERS.includes(provider) && !shared.has(provider) && !["binary", "slack", "google-auth"].includes(provider);
}

/** Prefix of a runtime coverage scope that belongs to one member's owner scope: `owner:<segment>/<scope>`. */
export const OWNER_COVERAGE_PREFIX = "owner:";
/** An owner segment as a path segment (personalSegment). */
const OWNER_SEGMENT_RE = /^@u-[0-9a-f]{24}$/;

/**
 * The `$SOURCES/<provider>/<segment>/` directory of `who`'s connected personal accounts in tenant `tenantNs`.
 * Must equal the runtime's personalSegment (packages/sources-runtime/src/source-lane/core/personal-scope.ts). It is
 * derived from the verified principal only; "@" never occurs in the providers' own layouts, so no data captured
 * before owner scopes can sit under a segment.
 */
export function personalSegment(tenantNs: string, who: Identity): string {
  const digest = createHash("sha256").update(`procmem.personal-owner/v1\n${tenantNs}\n${who.issuer}\n${who.subject}`).digest("hex");
  return `@u-${digest.slice(0, 24)}`;
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
  readonly #segment: string | null;
  readonly #personalDirs: ReadonlySet<string>;
  readonly #ownedAccounts: Set<string>;
  readonly #ownsAllGoogle: boolean;

  readonly #shared: ReadonlySet<string>;
  /** Google-wide units (runtime attribution) this principal reads in full, and every directory above one. */
  readonly #units: ReadonlySet<string>;
  readonly #unitParents: ReadonlySet<string>;
  /** The caller's mailboxes see some file view-only: their own current views live under `google-docs/_accounts/`. */
  readonly #hasViewOnlyUnits: boolean;

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
      /** This principal's personalSegment in the viewed tenant (its connected personal accounts). */
      personalSegment?: string;
      /** Connect-owned providers where `<provider>/<personalSegment>/` exists (only those are listed at the root). */
      personalDirs?: readonly string[];
    },
  ) {
    this.#segment = input.personalSegment ?? null;
    this.#personalDirs = new Set(input.personalDirs ?? []);
    const units = new Set<string>();
    const parents = new Set<string>();
    // Drive PDFs are units of the binary lane; a mailbox's own view of one lives under `google-docs/_accounts/` too.
    this.#hasViewOnlyUnits = (input.googleUnits ?? []).some((u) => !u.revisions && /^(google-docs|binary\/drive-pdf)\/[^/]/.test(u.path));
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

  /** `<provider>/<segment>` holding this principal's own account(s) of a connect-owned provider, else null. */
  personalDir(provider: string): string | null {
    return this.#segment && isOwnerSegmentProvider(provider, this.#shared) ? `${provider}/${this.#segment}` : null;
  }

  get personalSegment(): string | null {
    return this.#segment;
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
    if (DEVICE_OWNED_PROVIDERS.includes(provider)) {
      // Devices enrolled with owner scopes write under their enroller's segment; the provider directory itself holds
      // what devices enrolled before owner scopes captured, served to that single legacy enroller (if exactly one).
      if (seg.length >= 2 && OWNER_SEGMENT_RE.test(seg[1]!)) return seg[1] === this.#segment ? "allow" : "deny";
      if (seg.length === 1) return this.#owned.has(provider) || this.#personalDirs.has(provider) ? "mixed" : "deny";
      return this.#owned.has(provider) ? "allow" : "deny";
    }
    if (CONNECT_OWNED_PROVIDERS.includes(provider)) return this.#ownerSegment(seg);
    if (GOOGLE_WIDE_PROVIDERS.includes(provider)) {
      if (seg[1] === GOOGLE_ACCOUNT_VIEWS) {
        if (seg.length === 2) return this.#hasViewOnlyUnits && this.#ownedAccounts.size > 0 ? "mixed" : "deny";
        return this.#ownedAccounts.has(decodeSegment(seg[2]!)) ? "allow" : "deny";
      }
      if (seg.length === 1 && this.#hasViewOnlyUnits && this.#ownedAccounts.size > 0) return "mixed";
      return this.#unitAccess(seg);
    }
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
    // Default deny: a provider nobody declared shared (e.g. an operator-configured Nango source) is served only as the
    // caller's own owner segment (a personal Nango connection the runtime collected in the caller's owner scope).
    return this.#shared.has(provider) ? "allow" : this.#ownerSegment(seg);
  }

  /** `<provider>/<segment>/...`: only the caller's own segment; unsegmented (legacy) data and other members' are not. */
  #ownerSegment(seg: readonly string[]): Access {
    if (!this.#segment) return "deny";
    // The provider directory itself is listed only to members who have a subtree in it (no "someone uses X" hint).
    if (seg.length === 1) return this.#personalDirs.has(seg[0]!) ? "mixed" : "deny";
    return seg[1] === this.#segment ? "allow" : "deny";
  }

  /** Providers this viewer reads per owner segment (see isOwnerSegmentProvider). */
  ownsSegmentsOf(provider: string): boolean {
    return isOwnerSegmentProvider(provider, this.#shared);
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
    // A connect-owned provider: only reports of the caller's own owner scope (organization-level ones describe legacy
    // data), also before its first file (a blocked or pending account must be visible to its owner).
    if (isOwnerSegmentProvider(provider, this.#shared)) {
      if (c.scope.startsWith(OWNER_COVERAGE_PREFIX)) return this.#segment !== null && c.scope.startsWith(`${OWNER_COVERAGE_PREFIX}${this.#segment}/`);
      // Organization-level reports of a device provider describe the legacy devices: their single legacy enroller's.
      return DEVICE_OWNED_PROVIDERS.includes(provider) && this.#owned.has(provider);
    }
    const access = this.access(provider);
    if (access === "allow") return true;
    if (access === "deny") return false;
    // Docs coverage is tenant-wide except `account:<mailbox>` (that mailbox's own current views).
    if (GOOGLE_ACCOUNT_PROVIDERS[provider] || provider === GOOGLE_AUTH_STATUS_PROVIDER || (provider === "google-docs" && c.scope.startsWith("account:"))) {
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

/**
 * Owners per device provider from device bindings (all, including revoked). Connect-owned providers are not
 * owned per provider any more (each member's accounts sit under their own segment); the `sources/owners`
 * registry entries of the earlier one-owner-per-provider scheme confer nothing.
 */
export function providerOwners(bindings: readonly Pick<BindingRecord, "kind" | "providers" | "createdBy" | "enrolmentFailed" | "layout">[]): Map<string, Identity[]> {
  const out = new Map<string, Identity[]>();
  const add = (p: string, who: Identity) => out.set(p, [...(out.get(p) ?? []), { subject: who.subject, issuer: who.issuer }]);
  for (const b of bindings) {
    // Only devices enrolled before owner scopes own the provider directory itself (owner-segment devices own a segment).
    if (b.kind !== "device" || b.enrolmentFailed || b.layout === "owner-segment") continue;
    for (const p of b.providers) if (DEVICE_OWNED_PROVIDERS.includes(p)) add(p, b.createdBy);
  }
  return out;
}
