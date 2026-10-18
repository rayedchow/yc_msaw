import { encodeSegment } from "../../export/mapping.js";

/**
 * Slack lane paths (in addition to the donor projections, which keep their exact mirror
 * paths: sources/slack/<channelId>/<UTC day>.md and sources/slack/<channel>-channel-<hash>/
 * {threads,sessions}/..., and the default raw ledger under sources/slack/_raw/).
 *
 *   sources/slack/_workspaces/<teamId>/conversations/<channelId>.json   access + history coverage label
 *   sources/slack/_workspaces/<teamId>/files/<fileId>/file.json          post-redaction file metadata + capture state
 *   sources/slack/_workspaces/<teamId>/files/<fileId>/<file name>        exact bytes (binary)
 *
 * Team-scoped, so the same channel or file id seen through two workspaces never collides.
 * `_workspaces` cannot collide with donor directories (donor slugs are [a-z0-9-]).
 */

export const PROVIDER = "slack";
export const LANE_ROOT = `sources/${PROVIDER}/_workspaces`;

export function conversationLabelPath(teamId: string, channelId: string): string {
  return `${LANE_ROOT}/${encodeSegment(teamId)}/conversations/${encodeSegment(channelId)}.json`;
}

export function fileDir(teamId: string, fileId: string): string {
  return `${LANE_ROOT}/${encodeSegment(teamId)}/files/${encodeSegment(fileId)}`;
}

export function fileMetadataPath(teamId: string, fileId: string): string {
  return `${fileDir(teamId, fileId)}/file.json`;
}

export function fileBytesPath(teamId: string, fileId: string, name: string | null): string {
  const base = (name ?? "").trim() || fileId;
  const safe = base === "file.json" ? `content--${base}` : base;
  return `${fileDir(teamId, fileId)}/${encodeSegment(safe)}`;
}

/** rowKey of the 9400 tables = `<teamId>/<id>`; Slack team, channel and file ids never contain "/". */
export function splitSourceKey(rowKey: string): [string, string] | null {
  const i = rowKey.indexOf("/");
  if (i <= 0 || i === rowKey.length - 1) return null;
  return [rowKey.slice(0, i), rowKey.slice(i + 1)];
}
