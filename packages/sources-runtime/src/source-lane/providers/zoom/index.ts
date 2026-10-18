/**
 * Zoom transcripts provider (lane in src/integrations/zoom, ported from askshepherd/aqueduct c7e1415).
 * The current snapshot of each meeting is exported with the branch's own rendering:
 *
 *   sources/zoom/<title-slug>-meeting-<hash12>/summary.md      metadata + participants
 *   sources/zoom/<title-slug>-meeting-<hash12>/transcript.md   parsed VTT turns
 *   sources/zoom/<title-slug>-meeting-<hash12>/meeting.json    the full redacted observation (incl. raw VTT)
 *
 * A renamed meeting moves directory (old paths deleted). Every snapshot version also stays raw.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { CoverageReport, ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourceProviderModule } from "../../core/types.js";
import { slugify } from "../../../lib/utils.js";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const inlineText = (v: string) => v.replace(/\s+/g, " ").trim();
const headingText = (v: string) => inlineText(v).replace(/\n+/g, " ").trim() || "Untitled";
const sourceMetadata = (rows: Array<[string, string | null | undefined]>) => rows.filter(([, v]) => typeof v === "string" && v.trim()).map(([l, v]) => `- ${l}: ${v}`).join("\n");
const dateText = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Donor zoomMeetingSourceDirectory (titledEntityDirectory + stableEntityPath). */
export function zoomMeetingDirectory(meetingId: string, title?: string | null): string {
  const suffix = `meeting-${createHash("sha256").update(meetingId).digest("hex").slice(0, 12)}`;
  const slug = slugify((title ?? "").trim() || "Untitled Zoom Meeting").slice(0, 80).replace(/-$/u, "");
  return `sources/zoom/${slug || "untitled"}-${suffix}`;
}

/** Donor renderZoomSummary. */
export function renderZoomSummary(payload: Record<string, unknown>): string {
  const title = str(payload.topic) ?? "Untitled Zoom Meeting";
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  const lines = participants.map((v) => {
    const row = obj(v);
    if (!row) return null;
    const label = str(row.name) ?? str(row.user_email) ?? "Unknown participant";
    const detail = [str(row.user_email), str(row.join_time), str(row.leave_time)].filter(Boolean).join(" · ");
    return `- ${inlineText(label)}${detail ? ` — ${inlineText(detail)}` : ""}`;
  }).filter(Boolean);
  return [
    `# ${headingText(title)}`, "", sourceMetadata([
      ["Source", "Zoom"], ["Meeting UUID", str(payload.zoomMeetingUuid)], ["Meeting number", str(payload.id)],
      ["Host", str(payload.host_email)], ["Started", dateText(payload.start_time)], ["Duration (minutes)", str(payload.duration)],
      ["Transcript", "[transcript.md](transcript.md)"], ["Recording", str(payload.share_url)],
    ]), "", "## Participants", "", lines.length ? lines.join("\n") : "_Participant details unavailable._",
  ].join("\n") + "\n";
}

/** Donor renderZoomTranscript. */
export function renderZoomTranscript(payload: Record<string, unknown>): string {
  const title = str(payload.topic) ?? "Untitled Zoom Meeting";
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  const turns = transcript.map((v) => {
    const row = obj(v);
    const text = str(row?.text);
    if (!row || !text) return null;
    const timing = [str(row.start_time), str(row.end_time)].filter(Boolean).join(" - ");
    return `${timing ? `**${inlineText(timing)}** ` : ""}${inlineText(str(row.speaker) ?? "speaker_unknown")}: ${text}`;
  }).filter(Boolean);
  return [`# Transcript: ${headingText(title)}`, "", sourceMetadata([["Source", "Zoom"], ["Meeting UUID", str(payload.zoomMeetingUuid)], ["Started", dateText(payload.start_time)]]), "", "## Transcript", "", turns.length ? turns.join("\n\n") : "_Transcript unavailable._"].join("\n") + "\n";
}

export const zoomMeetingsExport: ExtraTableExport = {
  table: "zoom_meetings",
  tenantColumn: "tenant_id",
  keyColumn: "id",
  async map(ctx: ExportContext, key: string, j: JournalInfo, prev: readonly string[]): Promise<SourceFileChange[]> {
    const [r] = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`
      SELECT meeting_uuid, topic, content_hash, source_event_id, payload::text AS payload_text, source_updated_at, observed_at FROM zoom_meetings WHERE tenant_id = ${ctx.tenantId} AND id = ${key}
    `));
    if (!r) return prev.map((path) => ({ op: "delete" as const, path, deletedAt: j.enqueuedAt, reason: "meeting_row_deleted", capturedAt: j.enqueuedAt }));
    const payload = JSON.parse(String(r.payload_text)) as Record<string, unknown>;
    const dir = zoomMeetingDirectory(String(r.meeting_uuid), str(r.topic));
    const capturedAt = new Date(String(r.observed_at)).toISOString();
    const updated = r.source_updated_at ? new Date(String(r.source_updated_at)).toISOString() : null;
    const provenance = { runtime: "zoom source lane", port: "askshepherd/aqueduct@c7e1415f2a8b9bc66c69f5baf61f59f751c5fe4f src/integrations/zoom + mirror renderers", externalId: String(r.meeting_uuid), versionRef: String(r.content_hash), sourceEventId: String(r.source_event_id) };
    const put = (name: string, contentType: string, content: string, kind: "projection" | "raw"): SourceFileChange => ({ op: "put", path: `${dir}/${name}`, kind, contentType, content: Buffer.from(content, "utf8"), sourceUpdatedAt: updated, capturedAt, provenance });
    const changes: SourceFileChange[] = [
      put("summary.md", "text/markdown", renderZoomSummary(payload), "projection"),
      put("transcript.md", "text/markdown", renderZoomTranscript(payload), "projection"),
      put("meeting.json", "application/json", String(r.payload_text), "raw"),
    ];
    const now = new Set(changes.map((c) => c.path));
    for (const path of prev) if (!now.has(path)) changes.push({ op: "delete", path, deletedAt: capturedAt, reason: "zoom_meeting_renamed", capturedAt });
    return changes;
  },
};

export async function zoomCoverage(ctx: ExportContext, now = new Date()): Promise<CoverageReport[]> {
  const rows = rowsOf<Record<string, unknown>>(await ctx.executor.execute(sql`SELECT * FROM zoom_sync_state WHERE tenant_id = ${ctx.tenantId}`));
  const [conn] = rowsOf<{ status: string }>(await ctx.executor.execute(sql`SELECT status FROM connections WHERE tenant_id = ${ctx.tenantId} AND provider = 'zoom' LIMIT 1`));
  if (!conn) return [{ provider: "zoom", scope: "account", state: "pending", reason: "Zoom is not connected" }];
  if (conn.status !== "active") return [{ provider: "zoom", scope: "account", state: "blocked", reason: `connection ${conn.status}` }];
  const by = (lane: string) => rows.find((r) => r.lane === lane);
  const back = by("backfill");
  const poll = by("poll");
  const limits = "transcripts (VTT + parsed turns) and meeting/participant metadata only: no audio, no meeting chat, no Zoom AI summaries; recordings Zoom has already deleted (account retention / auto-delete) cannot be recovered";
  const pollFresh = poll?.last_success_at != null && now.getTime() - Date.parse(String(poll.last_success_at)) <= 3 * 300_000;
  const blocked = [back, poll].find((r) => r?.status === "blocked");
  const state: CoverageReport["state"] = blocked ? "blocked" : back?.status === "complete" && pollFresh ? "complete" : back || poll ? "partial" : "pending";
  return [{
    provider: "zoom", scope: "account:transcripts", state,
    reason: [state === "complete" ? `every ready cloud-recording transcript since ${back?.covered_from ? String(back.covered_from).slice(0, 10) : "the backfill start"}` : `backfill ${back?.status ?? "not started"}${pollFresh ? "" : "; 5-minute poll not current"}`, blocked ? String(blocked.last_error ?? "blocked") : null, limits].filter(Boolean).join("; "),
    ...(poll?.last_success_at ? { lastSuccessAt: new Date(String(poll.last_success_at)).toISOString() } : {}),
    ...([back, poll].some((r) => r?.last_error) ? { lastError: String((back?.last_error ?? poll?.last_error) || "") } : {}),
  }];
}

export const zoomProvider: SourceProviderModule = {
  id: "zoom",
  eventSources: ["zoom"],
  mirrorRoots: [],
  connectionProviders: ["zoom"],
  extraTables: [zoomMeetingsExport],
  coverage: (ctx) => zoomCoverage(ctx),
};
