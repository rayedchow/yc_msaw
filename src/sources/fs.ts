import { z } from "zod";
import { FindSchema, GrepSchema, LsSchema, ReadSchema } from "../customer/tools.js";
import { globMatcher, grepTree, MAX_GREP_SCAN_BYTES, MAX_LIST_LIMIT, MAX_READ_BYTES, readLinesSlice, VTree } from "../customer/tree.js";
import { agentToStored, displaySourcePath, providerOf, SourceError } from "./paths.js";
import type { ProviderStatus, SourceService } from "./service.js";
import { isTextualContentType, isVersionId, type FileEntry, type SourceStore, type SourceVersion, type TreeChild } from "./store.js";

/**
 * Host-side filesystem tools over $SOURCES (the tenant's server-side sources/ tree).
 *
 * The existing read/ls/find/grep tools route here when their path is below
 * $SOURCES, so agents keep one set of verbs; results reuse the customer tree
 * semantics (line/byte slicing, globbing, worker-isolated regex). Reads never
 * open a sandbox and never call a provider: they serve the stored versions.
 * Every file receipt carries freshness (capturedAt/sourceUpdatedAt/age/lag),
 * version identity and the provider's reported coverage state.
 */

/** Line-mode reads load at most this prefix; byte reads reach any offset of any size. */
export const MAX_SOURCE_LINE_LOAD_BYTES = 4 * 1024 * 1024;
/** Upper bound on files a single grep loads, independent of total bytes. */
const MAX_GREP_FILES = 5_000;
/** Upper bound on tree entries visited by find/grep. */
const MAX_WALK_ENTRIES = 200_000;
const STATUS_TTL_MS = 15_000;

export const SourcesStatusSchema = z
  .object({
    provider: z.string().min(1).max(63).optional().describe("Only this provider directory (e.g. google-docs, slack)."),
  })
  .strict();

export const SourcesHistorySchema = z
  .object({
    path: z.string().min(1).max(4_000).describe("$SOURCES/<provider>/... file path (live or deleted)."),
    limit: z.number().int().min(1).max(200).optional().describe("Versions to list, newest first; defaults to 20."),
    before: z.string().max(40).optional().describe("Continue the listing after this versionId (from nextBefore)."),
    versionId: z.string().max(40).optional().describe("Read this exact version's bytes instead of listing."),
    byteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    byteLimit: z.number().int().min(1).max(MAX_READ_BYTES).optional(),
  })
  .strict();

export const SOURCE_ROUTED_TOOLS = ["read", "ls", "find", "grep"] as const;
export type SourceRoutedTool = (typeof SOURCE_ROUTED_TOOLS)[number];

export const SOURCES_ORIENTATION =
  "$SOURCES is the always-updated server-side mirror of connected providers (sources/<provider>/...): projections (.md), raw provider records (_raw/ JSON), and binary files, each with capture time and version history. Use ls/find/grep/read with $SOURCES paths, sources_status for freshness and coverage, sources_history for prior versions and deletions. $SOURCES is read-only and is not mounted in shell.";

interface Freshness {
  versionId: string;
  kind: string;
  contentType: string | null;
  size: number;
  sha256: string;
  capturedAt: string;
  sourceUpdatedAt: string | null;
  ageSeconds: number;
  captureLagSeconds: number | null;
  coverage: { state: ProviderStatus["coverageState"]; health: ProviderStatus["health"]; lastSuccessfulCheckAt: string | null; reasons: string[] };
}

export class SourceFs {
  readonly #statusCache = new Map<string, { at: number; epoch: number; providers: Map<string, ProviderStatus> }>();

  constructor(
    readonly service: SourceService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async #coverage(ns: string, provider: string | null): Promise<Freshness["coverage"]> {
    if (!provider) return { state: "unreported", health: "unreported", lastSuccessfulCheckAt: null, reasons: [] };
    let cached = this.#statusCache.get(ns);
    const epoch = this.service.reportEpoch(ns);
    if (!cached || cached.epoch !== epoch || this.now().getTime() - cached.at > STATUS_TTL_MS) {
      const st = await this.service.status(ns);
      cached = { at: this.now().getTime(), epoch, providers: new Map(st.providers.map((p) => [p.provider, p])) };
      this.#statusCache.set(ns, cached);
    }
    const p = cached.providers.get(provider);
    if (!p) return { state: "unreported", health: "unreported", lastSuccessfulCheckAt: null, reasons: [] };
    return {
      state: p.coverageState,
      health: p.health,
      lastSuccessfulCheckAt: p.lastSuccessfulCheckAt,
      reasons: p.coverage.filter((c) => c.state !== "complete" && c.reason).map((c) => `${c.scope}: ${c.reason}`),
    };
  }

  async #freshness(ns: string, stored: string, v: SourceVersion): Promise<Freshness> {
    const nowMs = this.now().getTime();
    const cap = Date.parse(v.capturedAt);
    const upd = v.sourceUpdatedAt ? Date.parse(v.sourceUpdatedAt) : null;
    return {
      versionId: v.versionId,
      kind: v.kind,
      contentType: v.contentType,
      size: v.size,
      sha256: v.sha256,
      capturedAt: v.capturedAt,
      sourceUpdatedAt: v.sourceUpdatedAt,
      ageSeconds: Math.max(0, Math.round((nowMs - cap) / 1000)),
      captureLagSeconds: upd === null ? null : Math.max(0, Math.round((cap - upd) / 1000)),
      coverage: await this.#coverage(ns, providerOf(stored)),
    };
  }

  async run(ns: string, tool: SourceRoutedTool, rawInput: unknown): Promise<Record<string, unknown>> {
    const started = Date.now();
    const body = await this.#dispatch(ns, tool, rawInput);
    return { tool, ok: true, durationMs: Date.now() - started, ...body };
  }

  async #dispatch(ns: string, tool: SourceRoutedTool, rawInput: unknown): Promise<Record<string, unknown>> {
    switch (tool) {
      case "ls": {
        const { after, ...rest } = (rawInput ?? {}) as Record<string, unknown>;
        if (after !== undefined && (typeof after !== "string" || after.length === 0 || after.length > 255)) throw new SourceError("invalid_input", "after must be an entry name");
        return this.ls(ns, { ...LsSchema.parse(rest), ...(typeof after === "string" ? { after } : {}) });
      }
      case "read":
        return this.read(ns, ReadSchema.parse(rawInput));
      case "find":
        return this.find(ns, FindSchema.parse(rawInput ?? {}));
      case "grep":
        return this.grep(ns, GrepSchema.parse(rawInput));
    }
  }

  async ls(ns: string, input: z.output<typeof LsSchema> & { after?: string }): Promise<Record<string, unknown>> {
    const stored = agentToStored(input.path);
    const store = this.service.storeFor(ns);
    const head = (await store.head()).value;
    const r = await store.resolve(stored, head.root);
    const path = displaySourcePath(stored);
    if (!r) throw new SourceError("not_found", `No such file or directory: ${path}`);
    if (r.type === "file") {
      return { path, type: r.entry.t === "x" ? "deleted" : "file", entries: [lsEntry(stored.split("/").pop() ?? stored, r.entry)], total: 1, truncated: false, seq: head.seq };
    }
    const cap = Math.min(input.limit, MAX_LIST_LIMIT);
    // Paged directories can be huge: list one window (resume with `after`), never load every page.
    const page = await store.list(stored, { limit: cap, ...(input.after !== undefined ? { after: input.after } : {}) }, head.root);
    const agg = r.entry ?? (await rootAggregate(store, r.sha));
    return {
      path,
      type: "dir",
      entries: page.entries.map((e) => lsEntry(e.name, e.entry)),
      liveFiles: agg.files,
      deletedFiles: agg.deleted,
      truncated: page.nextAfter !== null,
      ...(page.nextAfter !== null ? { nextAfter: page.nextAfter } : {}),
      seq: head.seq,
      ...(stored === "" ? { orientation: SOURCES_ORIENTATION } : {}),
    };
  }

  async read(ns: string, input: z.output<typeof ReadSchema>): Promise<Record<string, unknown>> {
    const stored = agentToStored(input.path);
    const path = displaySourcePath(stored);
    const store = this.service.storeFor(ns);
    const r = await store.resolve(stored);
    if (!r) throw new SourceError("not_found", `No such file or directory: ${path}`);
    if (r.type === "dir") throw new SourceError("not_a_file", `${path} is a directory; use ls or find`);
    if (r.entry.t === "x") {
      const v = await store.version(r.entry.v);
      throw new SourceError("not_found", `${path} was deleted at ${v.deleted?.at ?? v.capturedAt} (${v.deleted?.reason ?? "deleted"}); use sources_history to read prior versions`);
    }
    const version = await store.version(r.entry.v);
    const source = await this.#freshness(ns, stored, version);
    return { ...(await sliceVersion(store, path, version, input)), source, provenance: version.provenance };
  }

  async find(ns: string, input: z.output<typeof FindSchema>): Promise<Record<string, unknown>> {
    const stored = agentToStored(input.path);
    const path = displaySourcePath(stored);
    const store = this.service.storeFor(ns);
    const r = await store.resolve(stored);
    if (!r) throw new SourceError("not_found", `No such file or directory: ${path}`);
    const match = globMatcher(input.pattern);
    const cap = Math.min(input.limit, MAX_LIST_LIMIT);
    const matches: string[] = [];
    let truncated = false;
    if (r.type === "file") {
      if (r.entry.t === "f" && match(stored.split("/").pop() ?? "")) matches.push(path);
      return { path, pattern: input.pattern, matches, truncated };
    }
    let visited = 0;
    for await (const item of store.walk(stored)) {
      if (++visited > MAX_WALK_ENTRIES) {
        truncated = true;
        break;
      }
      const rel = stored ? item.path.slice(stored.length + 1) : item.path;
      if (!match(rel)) continue;
      if (matches.length >= cap) {
        truncated = true;
        break;
      }
      matches.push(item.entry.t === "d" ? `${displaySourcePath(item.path)}/` : displaySourcePath(item.path));
    }
    return { path, pattern: input.pattern, matches, truncated };
  }

  async grep(ns: string, input: z.output<typeof GrepSchema>): Promise<Record<string, unknown>> {
    const stored = agentToStored(input.path);
    const path = displaySourcePath(stored);
    const store = this.service.storeFor(ns);
    const r = await store.resolve(stored);
    if (!r) throw new SourceError("not_found", `No such file or directory: ${path}`);
    const globMatch = input.glob && r.type === "dir" ? globMatcher(input.glob) : null;
    const files = new Map<string, Buffer>();
    let filesSkipped = 0;
    let scanned = 0;
    let truncated = false;
    let visited = 0;
    const candidates: Array<{ path: string; entry: FileEntry }> = [];
    if (r.type === "file") {
      if (r.entry.t === "f") candidates.push({ path: stored, entry: r.entry });
    } else {
      for await (const item of store.walk(stored)) {
        if (++visited > MAX_WALK_ENTRIES) {
          truncated = true;
          break;
        }
        if (item.entry.t !== "f") continue;
        if (globMatch && !globMatch(stored ? item.path.slice(stored.length + 1) : item.path)) continue;
        candidates.push({ path: item.path, entry: item.entry });
      }
    }
    for (const c of candidates) {
      if (!isTextualContentType(c.entry.contentType) || c.entry.size > MAX_SOURCE_LINE_LOAD_BYTES) {
        filesSkipped++;
        continue;
      }
      if (scanned + c.entry.size > MAX_GREP_SCAN_BYTES || files.size >= MAX_GREP_FILES) {
        truncated = true;
        break;
      }
      const version = await store.version(c.entry.v);
      files.set(c.path, await store.readRange(version, 0, version.size));
      scanned += c.entry.size;
    }
    // Reuse the customer tree grep (literal/regex worker with timeout) over the loaded files.
    const tree = new VTree("knowledge");
    for (const [p, buf] of files) tree.add(p, { type: "file", size: buf.byteLength, content: buf });
    const scope = r.type === "dir" && tree.get(stored)?.type === "dir" ? stored : "";
    const g = files.size
      ? await grepTree(tree, { root: "knowledge", rel: scope }, { pattern: input.pattern, literal: input.literal, ignoreCase: input.ignoreCase, limit: input.limit })
      : { matches: [], filesSkipped: 0, truncated: false };
    const matches = g.matches.map((m) => ({ ...m, path: displaySourcePath(m.path.replace(/^\$KNOWLEDGE\/?/, "")) }));
    return { path, pattern: input.pattern, matches, filesSearched: files.size, filesSkipped: filesSkipped + g.filesSkipped, truncated: truncated || g.truncated };
  }

  async status(ns: string, input: z.output<typeof SourcesStatusSchema>): Promise<Record<string, unknown>> {
    const st = await this.service.status(ns);
    const providers = input.provider ? st.providers.filter((p) => p.provider === input.provider) : st.providers;
    return {
      tool: "sources_status",
      ok: true,
      root: "$SOURCES",
      seq: st.head.seq,
      updatedAt: st.head.updatedAt,
      providers,
      bindings: st.bindings.filter((b) => !b.revokedAt).map((b) => ({ bindingId: b.bindingId, kind: b.kind, providers: b.providers, label: b.label, createdAt: b.createdAt })),
      note: "coverageState is the worst reported coverage (what was captured); health is whether a collector reported recently (is it still running); captureAgeSeconds is data age. 'unreported' means unknown, never complete.",
    };
  }

  async history(ns: string, input: z.output<typeof SourcesHistorySchema>): Promise<Record<string, unknown>> {
    const stored = agentToStored(input.path);
    const path = displaySourcePath(stored);
    const store = this.service.storeFor(ns);
    if (input.versionId !== undefined) {
      if (!isVersionId(input.versionId)) throw new SourceError("invalid_input", `Invalid versionId ${JSON.stringify(input.versionId)}`);
      const v = await store.version(input.versionId);
      if (v.path !== stored) throw new SourceError("not_found", `Version ${input.versionId} does not belong to ${path}`);
      if (v.kind === "tombstone") return { tool: "sources_history", ok: true, path, version: versionSummary(v), content: null, note: "tombstone: the file was deleted at this version" };
      const slice = await sliceVersion(store, path, v, { byteOffset: input.byteOffset ?? 0, ...(input.byteLimit !== undefined ? { byteLimit: input.byteLimit } : {}) });
      return { tool: "sources_history", ok: true, version: versionSummary(v), source: await this.#freshness(ns, stored, v), ...slice };
    }
    const h = await store.history(stored, { ...(input.limit !== undefined ? { limit: input.limit } : {}), ...(input.before !== undefined ? { before: input.before } : {}) });
    return { tool: "sources_history", ok: true, path, versions: h.versions.map(versionSummary), nextBefore: h.nextBefore };
  }
}

/** Line slice for text, byte slice (base64 for binary) otherwise; reads only the chunks the window needs. */
async function sliceVersion(
  store: SourceStore,
  path: string,
  version: SourceVersion,
  input: { offset?: number; limit?: number; byteOffset?: number; byteLimit?: number },
): Promise<Record<string, unknown>> {
  const textual = isTextualContentType(version.contentType);
  const byteMode = input.byteOffset !== undefined || input.byteLimit !== undefined || !textual;
  if (byteMode) {
    if (input.offset !== undefined || input.limit !== undefined) {
      throw new SourceError("invalid_input", `${path} is binary (${version.contentType}); use byteOffset/byteLimit`);
    }
    const start = input.byteOffset ?? 0;
    const limit = Math.min(input.byteLimit ?? MAX_READ_BYTES, MAX_READ_BYTES);
    const data = await store.readRange(version, start, limit);
    const end = start + data.length;
    const truncated = end < version.size;
    return {
      path,
      content: textual ? data.toString("utf8") : data.toString("base64"),
      encoding: textual ? "utf8" : "base64",
      totalBytes: version.size,
      mode: "bytes",
      byteOffset: start,
      truncated,
      ...(truncated ? { nextByteOffset: end } : {}),
    };
  }
  const data = await store.readRange(version, 0, Math.min(version.size, MAX_SOURCE_LINE_LOAD_BYTES));
  return { ...readLinesSlice(path, data, version.size, input), encoding: "utf8" };
}

function versionSummary(v: SourceVersion) {
  return {
    versionId: v.versionId,
    kind: v.kind,
    contentType: v.contentType,
    size: v.size,
    sha256: v.sha256,
    capturedAt: v.capturedAt,
    sourceUpdatedAt: v.sourceUpdatedAt,
    previous: v.previous,
    ...(v.deleted ? { deleted: v.deleted } : {}),
    provenance: v.provenance,
  };
}

/** files/deleted totals of the root directory (the root has no parent entry carrying them). */
async function rootAggregate(store: SourceStore, sha: string): Promise<{ files: number; deleted: number }> {
  let files = 0;
  let deleted = 0;
  for await (const [, e] of store.children(sha)) {
    if (e.t === "d") {
      files += e.files;
      deleted += e.deleted;
    } else if (e.t === "f") files += 1;
    else deleted += 1;
  }
  return { files, deleted };
}

function lsEntry(name: string, e: TreeChild): Record<string, unknown> {
  if (e.t === "d") return { name: `${name}/`, type: "dir", size: 0, files: e.files, capturedAt: e.capturedAt, sourceUpdatedAt: e.sourceUpdatedAt };
  return {
    name,
    type: e.t === "x" ? "deleted" : "file",
    size: e.size,
    kind: e.kind,
    contentType: e.contentType,
    capturedAt: e.capturedAt,
    sourceUpdatedAt: e.sourceUpdatedAt,
  };
}
