import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Provenance manifest for the copied Aqueduct sourcing subsystem and every later import.
 *
 *   tsx scripts/provenance.ts                       regenerate PROVENANCE.json (needs AQUEDUCT_DONOR_DIR or ../../../aqueduct)
 *   tsx scripts/provenance.ts --check               verify the tree against PROVENANCE.json (no donor checkout needed)
 *   tsx scripts/provenance.ts --merge <frag.json>…  merge integration-agent provenance fragments (validated, see mergeFragment)
 *   tsx scripts/provenance.ts --verify-donors <dir> re-hash every recorded donor blob from git clones under <dir>/<repo name>
 *
 * Every file under a donor-mirrored root must be recorded. `verbatim` files must hash to the
 * recorded donor hash; `shim`/`patched` files carry a reason; `new` files may only live under
 * source-lane paths or package configuration unless recorded with a reason. Files that come from a
 * donor other than the pinned Aqueduct commit carry their own `donorRepo`/`donorCommit` (full sha).
 */

export const DONOR = {
  repo: "askshepherd/aqueduct",
  commit: "b26d3f46236a36d64f841539abff2b1ffdace5cf",
} as const;

export type ProvenanceStatus = "verbatim" | "shim" | "patched" | "new";

/** A donor the file was adapted from without being a byte copy (informational, still pinned). */
export interface DerivedFrom {
  repo: string;
  commit: string;
  path?: string;
  use?: string;
  note?: string;
}

export interface ProvenanceEntry {
  path: string;
  sha256: string;
  status: ProvenanceStatus;
  /** Absent = the pinned global DONOR. Present = an external donor (another repo or another Aqueduct commit). */
  donorRepo?: string;
  donorCommit?: string;
  donorPath?: string;
  donorSha256?: string;
  reason?: string;
  test?: string;
  tests?: string[];
  /** Integration agent (or "core"/"coordinator") that owns the file. */
  owner?: string;
  derivedFrom?: DerivedFrom[];
}

export interface ProvenanceManifest {
  schema: "procmem.sources-runtime.provenance/v2";
  donor: typeof DONOR;
  /** Donor roots deliberately not copied (graph/LLM/chat planes and donor entrypoints). */
  notCopied?: Array<{ path: string; reason: string }>;
  /** Donor migrations are all copied verbatim; which ones run is decided (and justified) here. */
  migrationPlan?: string;
  files: ProvenanceEntry[];
}

export const NOT_COPIED: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "src/graph/ (except bridge/session-windows.ts, bridge/chunker.ts; wiring/ingest-hook.ts + default-kb.ts are shims)", reason: "graph/LLM plane; source lane never builds a graph" },
  { path: "src/wiki/, src/chat/, src/answerer/, src/agent/", reason: "LLM wiki/chat planes" },
  { path: "src/api/", reason: "donor tenant API (aq_ API keys, onboarding, graph builds); replaced by src/source-lane/internal/app.ts behind the yc_msaw service token" },
  { path: "src/mcp/", reason: "donor MCP server; yc_msaw serves the sources/ filesystem" },
  { path: "src/entrypoints/", reason: "donor worker registers graph tasks; replaced by src/source-lane/entrypoints/" },
  { path: "tests/{graph,wiki,chat,answerer,agent,api,mcp}/, tests/scripts/v1-v2-parity.test.ts", reason: "tests of planes not copied" },
];

/** Roots whose files come from the donor (anything here must be recorded). */
const TRACKED_ROOTS = ["src", "tests", "drizzle", "scripts", "docs"];
const IGNORED = new Set(["node_modules", ".DS_Store"]);
/** Files that are new by design (core-owned or integration-agent-owned source-lane code). */
const NEW_PREFIXES = ["src/source-lane/", "tests/source-lane/", "scripts/provenance.ts", "scripts/migrate-source-lane.ts", "docs/source-lane"];
/** Source-lane migrations: 9000-9999 and five-digit ids (>= 10000) assigned to later integration agents. */
const NEW_MIGRATION = /^drizzle\/(9\d{3}|[1-9]\d{4})_[a-z0-9_]+\.sql$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;

/** Donor files intentionally replaced in the source lane. Keep in sync with CONTRACT.md §0. */
export const DECLARED_OVERRIDES: Record<string, { status: "shim" | "patched"; reason: string; test?: string; tests?: string[] }> = {
  "src/graph/wiring/ingest-hook.ts": {
    status: "shim",
    reason: "Graph ingestion disabled in the source lane: same export names, no kb reads, no graph.* tasks; mirror changes are exported via source_export_journal triggers.",
    test: "tests/source-lane/core/graph-guard.test.ts",
  },
  "src/integrations/google/index.ts": {
    status: "patched",
    reason: "google-auth patch request 5: googleIntegration.disconnect = disconnectAllGoogleAccounts, so tenant disconnect revokes OAuth/Composio grants at the provider instead of leaving refresh tokens live. gmail patch request 2: gmail.backfill records no days-bounded coverage window and passes no days/maxMessages bounds. quota-final-check: the gmail.backfill rate-limit reschedule keeps a Retry-After longer than its 1 h backoff cap as the floor. Legacy Docs durable floor: one-shot gdocs.content-snapshot/discovery/backfill tasks that meet Google's Retry-After floor are re-enqueued at the floor (bounded 40 reschedules, run still recorded failed) instead of burning their attempts.",
    test: "tests/source-lane/core/shared-patches.test.ts",
    tests: ["tests/source-lane/core/legacy-gdocs-durable-cooldown-pg.test.ts"],
  },
  "src/queue/dispatch.ts": {
    status: "patched",
    reason: "calendar-contacts patch request 4: google.contacts_sync every 900 s (the lane is incremental via People API sync tokens) instead of the donor's 6 h full resync. confluence patch request 1: startNangoPolling schedules confluence.sweep (own group) for Confluence. jira patch request 1: startNangoPolling schedules jira.sweep (own group) for Jira. github patch request 1: startNangoPolling schedules github.content_sweep (own group) for GitHub. bitbucket request 1: bitbucket.content_sweep schedule in its own group. notion request 1: notion.source_sweep schedule on the donor notion group; notion request 2: donor notion.poll every 300 s.",
    test: "tests/source-lane/core/shared-patches.test.ts",
    tests: ["tests/source-lane/core/shared-patches-notion.test.ts", "tests/source-lane/core/shared-patches-bitbucket.test.ts", "tests/source-lane/providers/jira/shared-patches.test.ts", "tests/source-lane/core/shared-patches-confluence.test.ts"],
  },
  "src/integrations/nango/tasks.ts": {
    status: "patched",
    reason: "confluence patch request 2: disableNangoPollSchedule also disables the Confluence deep sweep schedule (its own group key). jira patch request 2: also disables the Jira deep sweep. github patch request 2: also disables the GitHub content sweep. bitbucket request 2: disable bitbucket.content_sweep on disconnect/revoked auth.",
    test: "tests/source-lane/core/shared-patches-confluence.test.ts",
    tests: ["tests/source-lane/core/shared-patches-bitbucket.test.ts", "tests/source-lane/providers/jira/shared-patches.test.ts"],
  },
  "src/integrations/atlassian/processors.ts": {
    status: "patched",
    reason: "confluence patch request 3: Confluence page/comment raw ids use the Confluence version number (nango:confluence:<model>:<id>:v<N>, tombstones :deleted:<at>) instead of the per-delivery Nango cursor. jira patch request 3: a slim Jira Issue record no longer overwrites the richer issue_detail mirror of the same or newer update.",
    test: "tests/source-lane/core/shared-patches-confluence.test.ts",
    tests: ["tests/source-lane/providers/jira/shared-patches.test.ts"],
  },
  "src/integrations/registry.ts": {
    status: "patched",
    reason: "Coordinator (stripe, discord, unipile): registers the Stripe connector (ported from gigabrain 5448774), the Discord official-bot collector, the read-only Cursor background agents collector, Zoom transcripts (aqueduct c7e1415 branch), the read-only Linear collector (gigabrain f74c62ca8 branch) and the WhatsApp/Instagram personal Unipile connectors (read-only, operator opt-in) so their connect/disconnect, webhook and sync handlers are live.",
    test: "tests/source-lane/providers/stripe/stripe.test.ts",
  },
  "src/integrations/nango/capture.ts": {
    status: "patched",
    reason: "nango-expansion request 1: generic Nango captures keep the Nango connection + integration (providerConfigKey) in source_event_id (and, when the provider identity gives none, in source_namespace/source_object_id), so two accounts of one provider in a tenant no longer collapse into one row; legacy ids unchanged without a connection.",
    test: "tests/source-lane/providers/nango-records/shared-patches.test.ts",
  },
  "src/integrations/nango/types.ts": {
    status: "patched",
    reason: "nango-expansion request 1: registerGenericNangoModels and the unregistered-model fallback pass ctx.connectionId / ctx.providerConfigKey to processGenericNangoRecord.",
    test: "tests/source-lane/providers/nango-records/shared-patches.test.ts",
  },
  "src/integrations/nango/webhook.ts": {
    status: "patched",
    reason: "nango-expansion request 2: only X-Nango-Hmac-Sha256 (HMAC-SHA256 of the raw body with the webhook signing key, NANGO_WEBHOOK_SECRET) authorizes; the legacy plain-SHA256 X-Nango-Signature and the API-key fallback are refused; verified deliveries claimed by the generic records lane are delegated to it. jira patch request 4: forwarded Jira provider webhooks queue a by-id refresh in the Jira deep lane (tenant from the connections table; body never stored). coordinator (final-audit M3): sync webhooks resolve only active connections.",
    test: "tests/integrations/nango/webhook.test.ts",
    tests: ["tests/source-lane/core/shared-patches-nango-disconnect.test.ts", "tests/source-lane/providers/jira/shared-patches.test.ts"],
  },
  "src/integrations/nango/proxy-details.ts": {
    status: "patched",
    reason: "jira patch request 5: the Jira deletion-reconcile ids listing uses bounded JQL (created >= 1970-01-01) that the enhanced search/jql accepts, and the captured-issue map takes the newest key instead of max(key) so a moved issue's correct mirror path is deleted (query bound unverified against live Atlassian; reconcile stays fail-soft). coordinator: donor Jira detail sweep honors jira_source_selection (project-filtered JQL, selection-keyed cursor, nothing selected = nothing captured). jira-efficiency: while an enabled jira.sweep schedule exists for the tenant, the donor Jira detail sweep no longer pages search/jql or comments itself. The jira.sweep deep lane already fetches the same fields=*all&expand=changelog payloads and every comment page, and it writes this lane's byte-identical issue_detail / issue_comment rows and sources/jira/<PROJECT>/<KEY>.md mirror through the exported recordJiraIssueDetailFromDeepLane / recordJiraIssueCommentsFromDeepLane / rematerializeJiraIssueDetailMirror helpers (comment-overflow paging is left to the deep lane). The hourly deletion reconcile is kept; it loads sites only when due and skips while the deep lane's persisted Retry-After cooldown blocks the Atlassian bucket. Tenants without the schedule keep the original sweep unchanged.",
    test: "tests/source-lane/providers/jira/shared-patches.test.ts",
    tests: ["tests/source-lane/providers/jira/donor-selection.test.ts", "tests/source-lane/providers/jira/efficiency-dedupe.test.ts"],
  },
  "src/integrations/notion/index.ts": {
    status: "patched",
    reason: "notion report: NOTION_TASK_KINDS also lists notion.backfill and the source lane's notion.source_sweep, so disconnect and permanent credential failures disable every Notion schedule. notion report: NOTION_TASK_KINDS also lists notion.backfill and the source lane's notion.source_sweep, so disconnect and permanent credential failures disable every Notion schedule.",
    test: "tests/source-lane/providers/notion/notion-report-fixes.test.ts",
    tests: ["tests/source-lane/providers/notion/notion-report-fixes.test.ts"],
  },
  "src/routes/slack-callback.ts": {
    status: "patched",
    reason: "final-audit L3: the HMAC-signed OAuth state is accepted once (sha256 recorded in source_lane_oauth_state_uses, drizzle/10300), not until it expires. final-audit L3: the HMAC-signed OAuth state is accepted once (sha256 recorded in source_lane_oauth_state_uses, drizzle/10300), not until it expires.",
    test: "tests/source-lane/core/oauth-state-single-use.test.ts",
    tests: ["tests/source-lane/core/oauth-state-single-use.test.ts"],
  },
  "src/routes/notion-callback.ts": {
    status: "patched",
    reason: "final-audit L3: the HMAC-signed OAuth state is accepted once (sha256 recorded in source_lane_oauth_state_uses, drizzle/10300), not until it expires. final-audit L3: the HMAC-signed OAuth state is accepted once (sha256 recorded in source_lane_oauth_state_uses, drizzle/10300), not until it expires.",
    test: "tests/source-lane/core/oauth-state-single-use.test.ts",
    tests: ["tests/source-lane/core/oauth-state-single-use.test.ts"],
  },
  "src/mirror/materializer.ts": {
    status: "patched",
    reason: "slack request 1: fold the append-only Slack ledger into channel-day files. granola fidelity P1: render the user's typed notes (notes_markdown/notes_plain) in summary.md next to the AI summary. granola fidelity P1: render the user's typed notes (notes_markdown/notes_plain) in summary.md next to the AI summary",
    test: "tests/source-lane/providers/slack/fold.test.ts",
    tests: ["tests/source-lane/providers/granola/mirror-backfill.test.ts"],
  },
  "src/integrations/nango/connect.ts": {
    status: "patched",
    reason: "coordinator (final-audit M3): disconnect deletes every Nango connection of the provider for the tenant.",
    test: "tests/source-lane/core/shared-patches-nango-disconnect.test.ts",
  },
  "src/integrations/notion/webhook.ts": {
    status: "patched",
    reason: "notion report: the handshake verification token (the webhook signing secret) is logged as a sha256 fingerprint unless NOTION_WEBHOOK_LOG_VERIFICATION_TOKEN=1",
    test: "tests/source-lane/providers/notion/notion-report-fixes.test.ts",
  },
  "src/vault/google-rate-limit.ts": {
    status: "patched",
    reason: "Valid Retry-After above the donor's 15-minute clamp is honoured (bounded at 24 h); lanes persist it durably. Overflow bound raised to 7 days so any valid Google wait is honoured. quota-final-check: parsing moved to src/lib/retry-after.ts (RFC 9110 §10.2.3 strict delay-seconds / HTTP-date; a valid value is never shortened, only an unrepresentable one is bounded at 2^31 - 1 s per RFC 9111 §1.2.2; malformed values take the fallback; HTTP-date also measured against the response Date).",
    test: "tests/source-lane/core/google-retry-after.test.ts",
    tests: ["tests/source-lane/core/google-retry-after.test.ts"],
  },
  "src/polling/_archived-gdocs/gdocs-api.ts": {
    status: "patched",
    reason: "Changes feed requests copyRequiresWriterPermission, downloadRestrictions and canCopy/canDownload so a view-only account copy follows a restriction toggled without a new version (final-combined-review N-1). Legacy Docs durable floor: gFetch also checks and records Google Retry-After floors in google_rate_limit_cooldowns (migration 10550), so a restarted process or second worker never calls Google before a floor another process received. The per-user cooldown key is google-workspace:quota:<quotaUser> for a bearer from getGoogleApiCredential (per-token key only for an unknown bearer).",
    test: "tests/source-lane/providers/google-docs/account-native-views.test.ts",
    tests: ["tests/source-lane/core/legacy-gdocs-durable-cooldown-pg.test.ts"],
  },
  "src/polling/_archived-gdocs/gdocs.ts": {
    status: "patched",
    reason: "A view-only mailbox does not download the shared drive-pdf unit nobody could read (final-performance-check).",
    test: "tests/source-lane/providers/google-docs/account-native-views.test.ts",
  },
  "src/integrations/google/gdocs/content.ts": {
    status: "patched",
    reason: "Legacy Docs durable floor: fetchDocContent checks and records the google-docs-api floor durably (migration 10550), and a 403 rate limit no longer triggers the PREVIEW_WITHOUT_SUGGESTIONS fallback request inside the cooldown.",
    test: "tests/source-lane/core/legacy-gdocs-durable-cooldown-pg.test.ts",
  },
  "tests/mirror/gdocs-content-render.test.ts": {
    status: "patched",
    reason: "Legacy Docs durable floor: the renderer test mocks the new durable-cooldown module (and isGoogleRateLimit) alongside the donor's google-rate-limit mock; assertions unchanged.",
    test: "tests/mirror/gdocs-content-render.test.ts",
  },
  "src/vault/google-auth.ts": {
    status: "patched",
    reason: "Legacy Docs durable floor: getGoogleApiCredential registers each bearer it returns with its quotaUser (google-quota-identity.ts, sha256 prefix only), so a per-user cooldown keyed by the stable account+credential unit survives token refresh and restarts.",
    test: "tests/source-lane/core/legacy-gdocs-durable-cooldown-pg.test.ts",
  },
  "src/mirror/backfill.ts": {
    status: "patched",
    reason: "google-docs patch request 1: the Docs backfill renders only the latest captured revision's tabs (a tab deleted later is not resurrected from an older revision) and skips docs whose gdocs_file_checkpoints lifecycle is trashed/removed (backfill no longer undoes source-lane tombstones). slack request 1: fold the append-only Slack ledger into window files. granola request 1: render each Granola note's latest snapshot only and skip notes whose newest observation is a tombstone; granola fidelity P1: notes with only typed notes are rendered too. granola fidelity P1: a Granola note with only typed notes is rendered by mirror.backfill",
    test: "tests/source-lane/providers/google-docs/backfill-tombstones.test.ts",
    tests: ["tests/source-lane/providers/granola/mirror-backfill.test.ts", "tests/source-lane/providers/slack/fold.test.ts"],
  },
  "src/vault/redaction.ts": {
    status: "patched",
    reason: "google-docs patch request 2: Slides image.contentUrl (requester-scoped ~30 min URL, same credential shape as Docs contentUri) is redacted for google-docs payloads by the shared rule. github patch request 4: GitHub temp_clone_token (short-lived clone credential) is redacted for github payloads.",
    test: "tests/source-lane/providers/google-docs/backfill-tombstones.test.ts",
    tests: ["tests/source-lane/core/shared-patches-confluence.test.ts"],
  },
  "src/graph/wiring/default-kb.ts": {
    status: "shim",
    reason: "No knowledge-base containers in the source lane; returns kbId:null and touches no table.",
    test: "tests/source-lane/core/graph-guard.test.ts",
  },
};

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(here, "..");
const MANIFEST_PATH = join(PACKAGE_ROOT, "PROVENANCE.json");

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function listTrackedFiles(root = PACKAGE_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (IGNORED.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(root, full).split("\\").join("/"));
    }
  };
  for (const r of TRACKED_ROOTS) if (existsSync(join(root, r))) walk(join(root, r));
  return out.sort();
}

export function isNewPathAllowed(path: string): boolean {
  return NEW_PREFIXES.some((p) => path.startsWith(p)) || NEW_MIGRATION.test(path);
}

/** Metadata that survives regeneration (everything except the recomputed hashes/status). */
function carriedMetadata(e: ProvenanceEntry | undefined): Partial<ProvenanceEntry> {
  if (!e) return {};
  const out: Partial<ProvenanceEntry> = {};
  for (const k of ["donorRepo", "donorCommit", "donorPath", "donorSha256", "reason", "test", "tests", "owner", "derivedFrom"] as const) {
    if (e[k] !== undefined) (out as Record<string, unknown>)[k] = e[k];
  }
  return out;
}

export function isExternal(e: Pick<ProvenanceEntry, "donorRepo" | "donorCommit">): boolean {
  return e.donorRepo !== undefined && (e.donorRepo !== DONOR.repo || e.donorCommit !== DONOR.commit);
}

export function generate(donorDir: string, root = PACKAGE_ROOT, previous?: ProvenanceManifest): ProvenanceManifest {
  const prior = new Map((previous?.files ?? []).map((f) => [f.path, f]));
  const files: ProvenanceEntry[] = [];
  const errors: string[] = [];
  for (const path of listTrackedFiles(root)) {
    const sha = sha256File(join(root, path));
    const before = prior.get(path);
    if (before && isExternal(before)) {
      // External donors are not in the Aqueduct checkout; keep their recorded donor hash and recompute ours.
      files.push({ ...carriedMetadata(before), path, sha256: sha, status: before.status } as ProvenanceEntry);
      continue;
    }
    const donorFile = join(donorDir, path);
    const override = DECLARED_OVERRIDES[path] ?? (before?.status === "patched" ? (before as ProvenanceEntry & { status: "patched"; reason: string }) : undefined);
    if (existsSync(donorFile)) {
      const donorSha = sha256File(donorFile);
      if (donorSha === sha && !DECLARED_OVERRIDES[path]) {
        files.push({ path, sha256: sha, status: "verbatim", donorPath: path, donorSha256: donorSha });
      } else if (override) {
        files.push({ ...carriedMetadata(before), path, sha256: sha, status: override.status, donorPath: path, donorSha256: donorSha, reason: override.reason, ...(override.test ? { test: override.test } : {}) });
      } else {
        errors.push(`${path}: differs from donor but has no declared shim/patch (add it to DECLARED_OVERRIDES or record a patch)`);
      }
    } else if (override) {
      files.push({ ...carriedMetadata(before), path, sha256: sha, status: override.status, donorPath: path, reason: override.reason, ...(override.test ? { test: override.test } : {}) });
    } else if (isNewPathAllowed(path) || (before?.status === "new" && before.reason)) {
      files.push({ ...carriedMetadata(before), path, sha256: sha, status: "new" });
    } else {
      errors.push(`${path}: not in donor and not under a source-lane path`);
    }
  }
  if (errors.length) throw new Error(`provenance generation failed:\n${errors.join("\n")}`);
  return { schema: "procmem.sources-runtime.provenance/v2", donor: DONOR, notCopied: [...NOT_COPIED], migrationPlan: "src/source-lane/core/migrations.ts", files };
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  counts: Record<ProvenanceStatus, number>;
}

function checkDonorFields(entry: ProvenanceEntry, errors: string[]): void {
  if (entry.donorRepo === undefined && entry.donorCommit === undefined) return;
  if (!entry.donorRepo || !REPO.test(entry.donorRepo)) errors.push(`${entry.path}: invalid donorRepo ${String(entry.donorRepo)}`);
  if (!entry.donorCommit || !FULL_SHA.test(entry.donorCommit)) errors.push(`${entry.path}: donorCommit must be a full 40-hex sha (got ${String(entry.donorCommit)})`);
  if (!entry.donorPath) errors.push(`${entry.path}: external donor entry without donorPath`);
  if (entry.status !== "new" && !entry.donorSha256) errors.push(`${entry.path}: external donor entry without donorSha256`);
}

/**
 * Verify the package tree against the manifest. `new` files under source-lane paths are
 * allowed to change (they are this repo's code); every donor-derived file must match.
 */
export function check(manifest: ProvenanceManifest, root = PACKAGE_ROOT): CheckResult {
  const errors: string[] = [];
  const counts: Record<ProvenanceStatus, number> = { verbatim: 0, shim: 0, patched: 0, new: 0 };
  const recorded = new Map(manifest.files.map((f) => [f.path, f]));
  if (manifest.donor.commit !== DONOR.commit) errors.push(`manifest donor commit ${manifest.donor.commit} != ${DONOR.commit}`);
  for (const path of listTrackedFiles(root)) {
    const entry = recorded.get(path);
    if (!entry) {
      if (isNewPathAllowed(path)) {
        counts.new += 1;
        continue;
      }
      errors.push(`${path}: unrecorded file under a donor root`);
      continue;
    }
    counts[entry.status] += 1;
    checkDonorFields(entry, errors);
    for (const d of entry.derivedFrom ?? []) {
      if (!REPO.test(d.repo) || !FULL_SHA.test(d.commit)) errors.push(`${path}: derivedFrom ${d.repo}@${d.commit} must name a repo and a full 40-hex commit`);
    }
    const sha = sha256File(join(root, path));
    if (entry.status === "verbatim") {
      if (sha !== entry.sha256 || entry.donorSha256 !== entry.sha256) errors.push(`${path}: verbatim donor file was modified (record a patch)`);
    } else if (entry.status === "shim" || entry.status === "patched") {
      if (!entry.reason) errors.push(`${path}: ${entry.status} without reason`);
      if (!entry.test && !entry.tests?.length) errors.push(`${path}: ${entry.status} without a regression test`);
      if (sha !== entry.sha256) errors.push(`${path}: ${entry.status} file changed since provenance was recorded (regenerate)`);
    } else if (!isNewPathAllowed(path) && !entry.reason) {
      errors.push(`${path}: new file under a donor root needs a reason`);
    }
  }
  for (const entry of manifest.files) {
    if (!existsSync(join(root, entry.path))) {
      if (entry.status !== "new") errors.push(`${entry.path}: recorded donor file is missing`);
    }
  }
  return { ok: errors.length === 0, errors, counts };
}

export function readManifest(path = MANIFEST_PATH): ProvenanceManifest {
  return JSON.parse(readFileSync(path, "utf8")) as ProvenanceManifest;
}

/** Fragment entry as written by integration agents (two historical spellings of the donor are accepted). */
export interface FragmentEntry extends Partial<ProvenanceEntry> {
  path: string;
  status: ProvenanceStatus;
  /** "owner/repo@sha" (older fragments) */
  donor?: string;
  oldSha256?: string | null;
  tests?: string[];
}

export interface FragmentLike {
  agent: string;
  /**
   * Set by the coordinator when it takes over a finished agent's file (e.g. applying a cross-agent patch request).
   * The entry then records both owners instead of failing the ownership check.
   */
  takeover?: boolean;
  files: FragmentEntry[];
}

/** Resolve abbreviated / `^`-suffixed commits (a fragment may say `c9c55105a^`). */
export type CommitResolver = (repo: string, commit: string) => string;

/**
 * Merge an agent fragment into the manifest. Rules (each violation is an error, nothing is blessed silently):
 * - the file's current sha must equal the fragment's recorded sha256 (the agent recorded what is on disk);
 * - a `patched` donor file must name the hash it was patched from, and that hash must equal the manifest's
 *   prior donor hash for the same path (the patch is against the pinned donor, not an unrecorded edit);
 * - `verbatim` external files must hash to their donor hash;
 * - donor commits are normalised to full shas via `resolve`.
 */
export function mergeFragment(manifest: ProvenanceManifest, fragment: FragmentLike, resolve: CommitResolver, root = PACKAGE_ROOT): string[] {
  const errors: string[] = [];
  const byPath = new Map(manifest.files.map((f, i) => [f.path, i]));
  for (const raw of fragment.files) {
    const path = raw.path;
    const full = join(root, path);
    if (!existsSync(full)) {
      errors.push(`${fragment.agent}: ${path} does not exist`);
      continue;
    }
    const sha = sha256File(full);
    if (raw.sha256 && raw.sha256 !== sha) {
      errors.push(`${fragment.agent}: ${path} changed after the fragment was written (recorded ${raw.sha256.slice(0, 12)}, now ${sha.slice(0, 12)})`);
      continue;
    }
    let donorRepo = raw.donorRepo;
    let donorCommit = raw.donorCommit;
    if (raw.donor && !donorRepo) {
      const at = raw.donor.lastIndexOf("@");
      donorRepo = raw.donor.slice(0, at);
      donorCommit = raw.donor.slice(at + 1);
    }
    const prior = byPath.has(path) ? manifest.files[byPath.get(path) as number] : undefined;
    const entry: ProvenanceEntry = { path, sha256: sha, status: raw.status, owner: fragment.agent };
    if (donorRepo && donorCommit) {
      const commit = resolve(donorRepo, donorCommit);
      if (donorRepo !== DONOR.repo || commit !== DONOR.commit) {
        entry.donorRepo = donorRepo;
        entry.donorCommit = commit;
      }
    }
    if (raw.donorPath) entry.donorPath = raw.donorPath;
    if (raw.donorSha256) entry.donorSha256 = raw.donorSha256;
    if (raw.reason) entry.reason = raw.reason;
    const tests = [...(raw.tests ?? []), ...(raw.test && raw.test !== "self" ? [raw.test] : raw.test === "self" ? [path] : [])];
    if (tests.length) entry.tests = tests;
    if (raw.derivedFrom?.length) entry.derivedFrom = raw.derivedFrom.map((d) => ({ ...d, commit: resolve(d.repo, d.commit) }));
    if (raw.status === "patched" && !entry.donorRepo) {
      if (!prior || prior.donorSha256 === undefined) errors.push(`${fragment.agent}: ${path} patched but the pinned donor has no such file`);
      else if (raw.donorSha256 !== prior.donorSha256 || (raw.oldSha256 && raw.oldSha256 !== prior.donorSha256)) {
        errors.push(`${fragment.agent}: ${path} patched from ${String(raw.oldSha256 ?? raw.donorSha256).slice(0, 12)} but the pinned donor hash is ${prior.donorSha256.slice(0, 12)}`);
      }
    }
    if (raw.status === "verbatim" && entry.donorSha256 !== sha) errors.push(`${fragment.agent}: ${path} declared verbatim but differs from its donor hash`);
    if ((raw.status === "patched" || raw.status === "shim") && !entry.reason) errors.push(`${fragment.agent}: ${path} ${raw.status} without reason`);
    if (prior && prior.status !== "verbatim" && prior.owner && !prior.owner.split(", ").includes(fragment.agent)) {
      if (fragment.takeover) entry.owner = `${prior.owner}, ${fragment.agent}`;
      else errors.push(`${fragment.agent}: ${path} is already owned by ${prior.owner}`);
    } else if (prior?.owner) entry.owner = prior.owner;
    if (byPath.has(path)) manifest.files[byPath.get(path) as number] = entry;
    else {
      byPath.set(path, manifest.files.length);
      manifest.files.push(entry);
    }
  }
  manifest.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return errors;
}

/**
 * Resolve via the local clone first; branch-only commits (not in a main-only clone) fall back to the audit's
 * recorded ref/branch listings (`historyDir/<repo>-*.txt`), and must match exactly one full sha there.
 */
function gitResolver(reposDir: string, historyDir?: string): CommitResolver {
  const cache = new Map<string, string>();
  return (repo, commit) => {
    if (FULL_SHA.test(commit)) return commit;
    const key = `${repo}@${commit}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const name = repo.split("/")[1] ?? repo;
    let full: string | undefined;
    try {
      full = execFileSync("git", ["-C", join(reposDir, name), "rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      full = undefined;
    }
    if (!full && historyDir && /^[0-9a-f]{7,39}$/.test(commit) && existsSync(historyDir)) {
      const found = new Set<string>();
      for (const f of readdirSync(historyDir).filter((n) => n.startsWith(`${name}-`) && n.endsWith(".txt"))) {
        for (const m of readFileSync(join(historyDir, f), "utf8").matchAll(new RegExp(`\\b${commit}[0-9a-f]{${40 - commit.length}}\\b`, "g"))) found.add(m[0]);
      }
      if (found.size === 1) full = [...found][0];
    }
    if (!full || !FULL_SHA.test(full)) throw new Error(`cannot resolve ${repo}@${commit} to a full commit`);
    cache.set(key, full);
    return full;
  };
}

/**
 * Re-hash every recorded donor blob straight from git (`<reposDir>/<repo name>`), so donor hashes are evidence and
 * not just claims. Missing commits are fetched by sha (read-only from the remote) when `fetch` is set.
 */
export function verifyDonors(manifest: ProvenanceManifest, reposDir: string, opts: { fetch?: boolean; gitArgs?: string[] } = {}): string[] {
  const errors: string[] = [];
  const git = (dir: string, args: string[]) => execFileSync("git", [...(opts.gitArgs ?? []), "-C", dir, ...args], { maxBuffer: 256 * 1024 * 1024 });
  const fetched = new Set<string>();
  for (const e of manifest.files) {
    if (!e.donorSha256 || !e.donorPath) continue;
    const repo = e.donorRepo ?? DONOR.repo;
    const commit = e.donorCommit ?? DONOR.commit;
    const dir = join(reposDir, repo.split("/")[1] ?? repo);
    if (!existsSync(dir)) {
      errors.push(`${e.path}: no clone for ${repo} under ${reposDir}`);
      continue;
    }
    try {
      try {
        git(dir, ["cat-file", "-e", `${commit}^{commit}`]);
      } catch {
        if (!opts.fetch || fetched.has(`${repo}@${commit}`)) throw new Error(`commit ${commit} not present`);
        fetched.add(`${repo}@${commit}`);
        git(dir, ["fetch", "--quiet", "origin", commit]);
      }
      const bytes = git(dir, ["cat-file", "blob", `${commit}:${e.donorPath}`]);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== e.donorSha256) errors.push(`${e.path}: donor ${repo}@${commit.slice(0, 9)}:${e.donorPath} hashes ${sha.slice(0, 12)}, recorded ${e.donorSha256.slice(0, 12)}`);
    } catch (err) {
      errors.push(`${e.path}: cannot read ${repo}@${commit.slice(0, 9)}:${e.donorPath} (${(err as Error).message.split("\n")[0]})`);
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const reposDir = process.env.PROVENANCE_REPOS_DIR ?? join(PACKAGE_ROOT, "..", "..", "..");
  if (argv.includes("--check")) {
    const result = check(readManifest());
    console.log(JSON.stringify(result.counts));
    if (!result.ok) {
      console.error(result.errors.join("\n"));
      process.exit(1);
    }
  } else if (argv[0] === "--merge") {
    const manifest = readManifest();
    const resolve = gitResolver(reposDir, process.env.PROVENANCE_HISTORY_DIR ?? join(reposDir, "..", "history"));
    const errors = argv.slice(1).flatMap((f) => mergeFragment(manifest, JSON.parse(readFileSync(f, "utf8")) as FragmentLike, resolve));
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    manifest.schema = "procmem.sources-runtime.provenance/v2";
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`merged ${argv.length - 1} fragment(s) into ${MANIFEST_PATH}`);
  } else if (argv[0] === "--verify-donors") {
    const dir = argv[1] ?? reposDir;
    const errors = verifyDonors(readManifest(), dir, { fetch: argv.includes("--fetch") });
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    console.log(`all recorded donor hashes re-verified from git under ${dir}`);
  } else {
    const donorDir = process.env.AQUEDUCT_DONOR_DIR ?? join(PACKAGE_ROOT, "..", "..", "..", "aqueduct");
    const head = execFileSync("git", ["-C", donorDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", donorDir, "status", "--porcelain"], { encoding: "utf8" }).trim();
    if (head !== DONOR.commit || dirty) throw new Error(`donor checkout ${donorDir} must be clean at ${DONOR.commit} (HEAD ${head}${dirty ? ", dirty" : ""})`);
    const previous = existsSync(MANIFEST_PATH) ? readManifest() : undefined;
    const manifest = generate(donorDir, PACKAGE_ROOT, previous);
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    const counts = manifest.files.reduce<Record<string, number>>((acc, f) => ((acc[f.status] = (acc[f.status] ?? 0) + 1), acc), {});
    console.log(`wrote ${MANIFEST_PATH}: ${JSON.stringify(counts)}`);
  }
}
