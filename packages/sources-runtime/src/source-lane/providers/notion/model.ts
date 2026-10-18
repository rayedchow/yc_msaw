import { extractNotionTitle, notionParentInfo, type NotionDatabase, type NotionDataSource, type NotionPage } from "../../../integrations/notion/client.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import { isRecord, type JsonObject } from "./api.js";
import type { BlockInput, FileRefInput, NodeInput, NodeType } from "./store.js";

/**
 * Pure mapping from Notion API objects (as returned, BEFORE redaction) to the lane's
 * stored shapes. File references are extracted from the unredacted object (the signed
 * URL is needed once, in memory, to fetch the bytes); everything stored goes through
 * the donor's Notion redaction (redactProviderPayload("notion", ...)), which replaces
 * file/external `url` fields and any signed URL.
 */

export const BLOCK_FILE_TYPES = new Set(["image", "video", "pdf", "file", "audio"]);
/** Block types whose children belong to another node (never walked under the current page). */
export const FOREIGN_CHILD_TYPES = new Set(["child_page", "child_database"]);

export function redact<T>(value: T): T {
  return redactProviderPayload("notion", value) as T;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function isoTime(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Notion ids compare dash-insensitively; store the dashed lowercase form the API returns. */
export function normId(id: string): string {
  const hex = id.toLowerCase().replace(/-/gu, "");
  if (!/^[0-9a-f]{32}$/u.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function objectType(raw: JsonObject): NodeType | null {
  const o = raw.object;
  return o === "page" || o === "data_source" || o === "database" ? o : null;
}

function trashState(raw: JsonObject): { inTrash: boolean; isArchived: boolean } {
  // 2026-03-11 renamed `archived` to `in_trash`; older payloads may still carry `archived`.
  return { inTrash: raw.in_trash === true || raw.archived === true, isArchived: raw.is_archived === true };
}

export function nodeInput(raw: JsonObject): NodeInput {
  const type = objectType(raw);
  if (!type) throw new Error(`not a Notion page/data_source/database object: ${String(raw.object)}`);
  const id = normId(String(raw.id));
  const parent = isRecord(raw.parent) ? raw.parent : {};
  const info = notionParentInfo(parent as NotionPage["parent"]);
  let parentType = info.parentType;
  let parentId = info.parentId ? normId(info.parentId) : null;
  let databaseId: string | null = null;
  if (type === "page") {
    databaseId = str(parent.database_id) ? normId(String(parent.database_id)) : null;
  } else if (type === "data_source") {
    databaseId = str(parent.database_id) ? normId(String(parent.database_id)) : null;
    if (databaseId) {
      parentType = "database_id";
      parentId = databaseId;
    }
  } else {
    databaseId = id;
  }
  if (parentType === "workspace") parentId = null;
  const title = extractNotionTitle(raw as unknown as NotionPage | NotionDataSource | NotionDatabase);
  return {
    type,
    id,
    parentType,
    parentId,
    databaseId,
    title,
    url: str(raw.url),
    createdTime: isoTime(raw.created_time),
    lastEditedTime: isoTime(raw.last_edited_time),
    ...trashState(raw),
    isLocked: raw.is_locked === true,
    raw: redact(raw),
  };
}

export function blockInput(raw: JsonObject, requestedParentId: string, position: number, depth: number): BlockInput {
  const parent = isRecord(raw.parent) ? raw.parent : {};
  const info = notionParentInfo(parent as NotionPage["parent"]);
  return {
    id: normId(String(raw.id)),
    parentId: normId(requestedParentId),
    parentType: info.parentType,
    position,
    depth,
    type: str(raw.type) ?? "unknown",
    hasChildren: raw.has_children === true,
    lastEditedTime: isoTime(raw.last_edited_time),
    raw: redact(raw),
  };
}

/** Block whose own children Notion lists under it (not child pages/databases, not synced copies that mirror another block). */
export function walkableChildren(raw: JsonObject): boolean {
  if (raw.has_children !== true) return false;
  const type = str(raw.type) ?? "";
  if (FOREIGN_CHILD_TYPES.has(type)) return false;
  return syncedFrom(raw) === null;
}

/** Original block id of a synced block copy (null for originals and other blocks). */
export function syncedFrom(raw: JsonObject): string | null {
  if (raw.type !== "synced_block" || !isRecord(raw.synced_block)) return null;
  const from = raw.synced_block.synced_from;
  return isRecord(from) && str(from.block_id) ? normId(String(from.block_id)) : null;
}

export interface ExtractedFile extends FileRefInput {
  /** Signed URL of a Notion-hosted file; in memory only, never persisted. */
  url: string | null;
}

function fileObjectRef(obj: unknown): { sourceType: string; url: string | null; fileUploadId: string | null; name: string | null } | null {
  if (!isRecord(obj)) return null;
  const type = str(obj.type);
  if (type === "file" && isRecord(obj.file)) return { sourceType: "file", url: str(obj.file.url), fileUploadId: null, name: str(obj.name) };
  if (type === "external" && isRecord(obj.external)) return { sourceType: "external", url: str(obj.external.url), fileUploadId: null, name: str(obj.name) };
  if (type === "file_upload" && isRecord(obj.file_upload)) return { sourceType: "file_upload", url: null, fileUploadId: str(obj.file_upload.id), name: str(obj.name) };
  return null;
}

/** Host + path of a URL (query and fragment dropped); external URLs keep no credentials either. */
export function stableLocation(url: string | null): { host: string | null; path: string | null } {
  if (!url) return { host: null, path: null };
  try {
    const u = new URL(url);
    return { host: u.host.toLowerCase(), path: decodeURIComponentSafe(u.pathname) };
  } catch {
    return { host: null, path: null };
  }
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Name of a file from the URL path (Notion-hosted URLs end in the original file name). */
export function nameFromLocation(path: string | null): string | null {
  if (!path) return null;
  const last = path.split("/").filter(Boolean).pop();
  return last ? last : null;
}

function makeRef(
  owner: { ownerType: FileRefInput["ownerType"]; ownerId: string; pageId: string; lastEdited: string | null },
  slot: string,
  ref: NonNullable<ReturnType<typeof fileObjectRef>>,
  name: string | null,
): ExtractedFile {
  const loc = stableLocation(ref.url);
  return {
    fileKey: `${owner.ownerType}:${owner.ownerId}:${slot}`,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    pageId: owner.pageId,
    slot,
    sourceType: ref.sourceType,
    name: name ?? ref.name ?? nameFromLocation(loc.path),
    urlHost: loc.host,
    urlPath: loc.path,
    fileUploadId: ref.fileUploadId,
    ownerLastEditedTime: owner.lastEdited,
    url: ref.sourceType === "file" ? ref.url : null,
  };
}

/** Files of a page / data source / database object: cover, icon, and `files` properties (pages). */
export function nodeFiles(raw: JsonObject): ExtractedFile[] {
  const type = objectType(raw);
  if (!type) return [];
  const id = normId(String(raw.id));
  const owner = { ownerType: type, ownerId: id, pageId: id, lastEdited: isoTime(raw.last_edited_time) } as const;
  const out: ExtractedFile[] = [];
  for (const slot of ["cover", "icon"] as const) {
    const ref = fileObjectRef(raw[slot]);
    if (ref) out.push(makeRef(owner, slot, ref, null));
  }
  if (type === "page" && isRecord(raw.properties)) {
    for (const [name, prop] of Object.entries(raw.properties)) {
      if (!isRecord(prop) || prop.type !== "files" || !Array.isArray(prop.files)) continue;
      const propId = str(prop.id) ?? name;
      prop.files.forEach((f, i) => {
        const ref = fileObjectRef(f);
        if (ref) out.push(makeRef(owner, `prop:${propId}:${i}`, ref, ref.name));
      });
    }
  }
  return out;
}

/** Files of a block: media blocks' file object and callout icons. */
export function blockFiles(raw: JsonObject, pageId: string): ExtractedFile[] {
  const type = str(raw.type);
  if (!type || !isRecord(raw[type])) return [];
  const value = raw[type] as JsonObject;
  const owner = { ownerType: "block" as const, ownerId: normId(String(raw.id)), pageId, lastEdited: isoTime(raw.last_edited_time) };
  const out: ExtractedFile[] = [];
  if (BLOCK_FILE_TYPES.has(type)) {
    const ref = fileObjectRef(value);
    if (ref) out.push(makeRef(owner, "block", ref, str(value.name) ?? ref.name));
  }
  if (isRecord(value.icon)) {
    const ref = fileObjectRef(value.icon);
    if (ref) out.push(makeRef(owner, "icon", ref, null));
  }
  return out;
}

/** Comment attachments ({category, file:{url, expiry_time}}). */
export function commentFiles(raw: JsonObject, pageId: string): ExtractedFile[] {
  if (!Array.isArray(raw.attachments)) return [];
  const owner = { ownerType: "comment" as const, ownerId: normId(String(raw.id)), pageId, lastEdited: isoTime(raw.last_edited_time) };
  const out: ExtractedFile[] = [];
  raw.attachments.forEach((a, i) => {
    if (!isRecord(a)) return;
    const file = isRecord(a.file) ? a.file : null;
    const ref = file && str(file.url) ? { sourceType: "file", url: str(file.url), fileUploadId: null, name: str(a.name) } : fileObjectRef(a);
    if (ref) out.push(makeRef(owner, `attachment:${i}`, ref, ref.name));
  });
  return out;
}

/** Find the file object for a stored slot in a re-fetched owner object (fresh signed URL). */
export function fileForSlot(raw: JsonObject, slot: string, pageId: string): ExtractedFile | null {
  const candidates = raw.object === "block" ? blockFiles(raw, pageId) : raw.object === "comment" ? commentFiles(raw, pageId) : nodeFiles(raw);
  return candidates.find((f) => f.slot === slot) ?? null;
}

/** Property ids of a page whose embedded value may be truncated (same predicate as the donor walker's propertyNeedsHydration). */
export function propertiesNeedingHydration(raw: JsonObject): Array<{ name: string; id: string; type: string }> {
  if (!isRecord(raw.properties)) return [];
  const out: Array<{ name: string; id: string; type: string }> = [];
  for (const [name, prop] of Object.entries(raw.properties)) {
    if (!isRecord(prop)) continue;
    const type = str(prop.type);
    const id = str(prop.id);
    if (!type || !id) continue;
    const value = prop[type];
    const needs = type === "formula" || type === "relation" || type === "rollup"
      || prop.has_more === true
      || ((type === "people" || type === "rich_text" || type === "title") && Array.isArray(value) && value.length >= 25);
    if (needs) out.push({ name, id, type });
  }
  return out;
}
