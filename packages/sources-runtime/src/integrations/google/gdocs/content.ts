import { createHash } from "node:crypto";
import { getGoogleAccessToken, GOOGLE_DOCS_DELEGATION_SCOPES } from "../../../vault/google-auth.js";
import { googleRateLimitErrorFromResponse, isGoogleRateLimit, throwIfGoogleRateLimited } from "../../../vault/google-rate-limit.js";
import { recordGoogleCooldownDurable, throwIfGoogleCooldownDurable } from "../../../source-lane/providers/google-docs/durable-cooldown.js";

const DOCS_API = "https://docs.googleapis.com/v1/documents";

interface DocsTab {
  tabProperties: { tabId: string; title: string; parentTabId?: string };
  body?: { content: DocsElement[] };
  documentTab?: { body?: { content: DocsElement[] } };
}

interface DocsElement {
  paragraph?: {
    elements: ParagraphElement[];
    paragraphStyle?: { namedStyleType?: string; headingId?: string };
    /** Present on list items; `nestingLevel` is the 0-based indent depth. */
    bullet?: { listId?: string; nestingLevel?: number };
    /** Floating objects anchored to this paragraph → `positionedObjects` map. */
    positionedObjectIds?: string[];
  };
  table?: { tableRows: TableRow[] };
  sectionBreak?: Record<string, unknown>;
}

interface ParagraphElement {
  textRun?: {
    content: string;
    textStyle?: {
      link?: { url?: string };
      bold?: boolean;
      italic?: boolean;
      strikethrough?: boolean;
    };
    suggestedInsertionIds?: string[];
    suggestedDeletionIds?: string[];
  };
  inlineObjectElement?: { inlineObjectId: string; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
  horizontalRule?: Record<string, unknown>;
  /** Person smart chip. `email` is always present per the API reference. */
  person?: { personProperties?: { name?: string; email?: string }; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
  /** Drive-file / YouTube / Calendar smart chip. `title` and `uri` always present. */
  richLink?: { richLinkProperties?: { title?: string; uri?: string; mimeType?: string }; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
  /** Date smart chip. `displayText` is the user-visible date ("Jul 4, 2026"); `timestamp` is ISO. */
  dateElement?: { dateElementProperties?: { displayText?: string; timestamp?: string }; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
  /** Inline footnote marker; content lives in the doc/tab-level `footnotes` map. */
  footnoteReference?: { footnoteId?: string; footnoteNumber?: string; suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
  /** Equation: the API exposes NO content (no LaTeX/MathML/text) - placeholder only. */
  equation?: { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] };
}

/** documents.get → inlineObjects / positionedObjects map values. */
interface EmbeddedObjectDef {
  inlineObjectProperties?: { embeddedObject?: EmbeddedObject };
  positionedObjectProperties?: { embeddedObject?: EmbeddedObject };
}

interface EmbeddedObject {
  title?: string;
  description?: string;
  imageProperties?: Record<string, unknown>;
  embeddedDrawingProperties?: Record<string, unknown>;
  linkedContentReference?: { sheetsChartReference?: { spreadsheetId?: string; chartId?: number } };
}

/**
 * Everything the walker needs beyond the elements themselves. Maps live at the
 * doc level and per tab (`documentTab.*`); the caller merges them.
 */
interface ExtractContext {
  lists?: DocsLists;
  inlineObjects?: Record<string, EmbeddedObjectDef>;
  positionedObjects?: Record<string, EmbeddedObjectDef>;
  footnotes?: Record<string, { content?: DocsElement[] }>;
  /** footnoteId → footnoteNumber, collected during the body walk; rendered after. */
  footnoteRefs: Map<string, string>;
}

/** `[image: alt]` / `[chart: alt - linked Sheets chart]` / `[drawing: alt]`. */
function embeddedObjectPlaceholder(def: EmbeddedObjectDef | undefined): string {
  const obj = def?.inlineObjectProperties?.embeddedObject ?? def?.positionedObjectProperties?.embeddedObject;
  const kind = obj?.linkedContentReference?.sheetsChartReference
    ? "chart"
    : obj?.embeddedDrawingProperties
      ? "drawing"
      : "image";
  const alt = [obj?.title, obj?.description].filter((s) => s && s.trim()).join(" - ").trim();
  const chartNote = kind === "chart" ? (alt ? " - linked Sheets chart" : ": linked Sheets chart") : "";
  return alt ? `[${kind}: ${alt}${chartNote}]` : `[${kind}${chartNote}]`;
}

/**
 * Doc-level lists map (`documents.get` → `lists`). A list nesting level is
 * ordered when it has a `glyphType` (DECIMAL/ALPHA/ROMAN…), unordered when it
 * only has a `glyphSymbol` (a bullet char). Used to render ordered vs.
 * unordered markdown lists faithfully.
 */
type DocsLists = Record<string, { listProperties?: { nestingLevels?: Array<{ glyphType?: string; glyphSymbol?: string }> } }>;

function isOrderedList(lists: DocsLists | undefined, listId: string | undefined, nestingLevel: number): boolean {
  if (!lists || !listId) return false;
  const level = lists[listId]?.listProperties?.nestingLevels?.[nestingLevel];
  const glyph = level?.glyphType;
  return Boolean(glyph && glyph !== "GLYPH_TYPE_UNSPECIFIED" && glyph !== "NONE");
}

interface TableRow {
  tableCells: TableCell[];
}

interface TableCell {
  content: DocsElement[];
}

export interface DocSuggestion {
  suggestionId: string;
  /** Text this suggestion proposes to insert (empty string if none). */
  insertedText: string;
  /** Existing text this suggestion proposes to delete (empty string if none). */
  deletedText: string;
  /**
   * Base-content snippet immediately preceding the suggested span. Durable
   * placement anchor - raw document indexes shift with every edit, text
   * context doesn't.
   */
  contextBefore: string;
  /** Base-content snippet immediately following the suggested span. */
  contextAfter: string;
}

export interface DocTab {
  tabId: string;
  tabName: string;
  parentTabId: string | null;
  content: string;
  suggestions: DocSuggestion[];
  contentHash: string;
}

export interface DocContent {
  docId: string;
  title: string;
  tabs: DocTab[];
  /**
   * False when SUGGESTIONS_INLINE returned 403 (reader-only access - no
   * permission to view suggested changes) and we fell back to the preview
   * view. Distinguishes "no pending suggestions" from "not allowed to see
   * suggestions" downstream.
   */
  suggestionsAccessible: boolean;
  /**
   * The complete, unmodified `documents.get` JSON response - the lossless
   * source of truth. Per-tab `content` is a best-effort markdown PROJECTION of
   * this and can drop structure (styling nuances, non-text elements); anything
   * the markdown can't represent is recoverable here.
   */
  raw: unknown;
}

const SUGGESTION_CONTEXT_CHARS = 80;

/**
 * Per-tab accumulator for pending suggestions. A single suggestion ID can
 * span many text runs (and cross tables), so parts are concatenated in
 * document order. Placement is captured as text context, not indexes:
 * a rolling tail of base content supplies contextBefore at first sight of a
 * suggestion, and subsequent base text fills contextAfter until full.
 */
class SuggestionCollector {
  private readonly bySuggestion = new Map<
    string,
    { inserted: string[]; deleted: string[]; contextBefore: string; contextAfter: string }
  >();
  private tail = "";
  private readonly awaitingAfter = new Set<string>();

  private entry(id: string) {
    let entry = this.bySuggestion.get(id);
    if (!entry) {
      entry = { inserted: [], deleted: [], contextBefore: this.tail, contextAfter: "" };
      this.bySuggestion.set(id, entry);
      this.awaitingAfter.add(id);
    }
    return entry;
  }

  addInsertion(id: string, text: string): void {
    if (text) this.entry(id).inserted.push(text);
  }

  addDeletion(id: string, text: string): void {
    if (text) this.entry(id).deleted.push(text);
  }

  /**
   * Feed base (as-if-rejected) content in document order. Fills the
   * after-context of any suggestion still awaiting one - except the
   * suggestions in `excludeIds`, whose own pending-deletion text shouldn't
   * count as its surrounding context.
   */
  noteBaseText(text: string, excludeIds: readonly string[] = []): void {
    if (!text) return;
    for (const id of [...this.awaitingAfter]) {
      if (excludeIds.includes(id)) continue;
      const entry = this.bySuggestion.get(id);
      if (!entry) {
        this.awaitingAfter.delete(id);
        continue;
      }
      entry.contextAfter += text;
      if (entry.contextAfter.length >= SUGGESTION_CONTEXT_CHARS) {
        entry.contextAfter = entry.contextAfter.slice(0, SUGGESTION_CONTEXT_CHARS);
        this.awaitingAfter.delete(id);
      }
    }
    this.tail = (this.tail + text).slice(-SUGGESTION_CONTEXT_CHARS);
  }

  toList(): DocSuggestion[] {
    return [...this.bySuggestion.entries()].map(([suggestionId, parts]) => ({
      suggestionId,
      insertedText: parts.inserted.join("").trim(),
      deletedText: parts.deleted.join("").trim(),
      contextBefore: normalizeContext(parts.contextBefore),
      contextAfter: normalizeContext(parts.contextAfter),
    }));
  }
}

function normalizeContext(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function fetchDocContent(userId: string, docId: string, overrideAccessToken?: string): Promise<DocContent> {
  const accessToken = overrideAccessToken ?? await getGoogleAccessToken(userId, undefined, GOOGLE_DOCS_DELEGATION_SCOPES);
  // SUGGESTIONS_INLINE returns the body with suggestion spans marked on each
  // text run (suggestedInsertionIds / suggestedDeletionIds). We derive both
  // views from the one response: base content excludes suggested insertions
  // and keeps not-yet-deleted text (equivalent to PREVIEW_WITHOUT_SUGGESTIONS),
  // while the marked spans are collected as pending suggestions per tab.
  const inlineUrl = `${DOCS_API}/${docId}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE`;

  throwIfGoogleRateLimited("google-docs-api");
  // SOURCE-LANE PATCH (legacy Docs durable floor): a floor recorded by another process or before a restart holds too.
  await throwIfGoogleCooldownDurable(["google-docs-api"]);
  let res = await fetch(inlineUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let suggestionsAccessible = true;
  // SOURCE-LANE PATCH (legacy Docs durable floor): a 403 rate limit is not a missing suggestions permission; it falls
  // through to the rate-limit error below instead of sending the preview request inside the cooldown.
  if (res.status === 403 && !isGoogleRateLimit(403, await res.clone().json().catch(() => null))) {
    // SUGGESTIONS_INLINE 403s when the caller lacks "permission to view
    // suggested changes" - reader-only shared docs. Fall back to the preview
    // view (readable at any role); such docs sync without suggestions.
    suggestionsAccessible = false;
    res = await fetch(`${DOCS_API}/${docId}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!res.ok) {
    const text = await res.text();
    let data: unknown = { raw: text };
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep raw text for the normal error below
    }
    const rateLimit = googleRateLimitErrorFromResponse("google-docs-api", res, data);
    if (rateLimit) {
      await recordGoogleCooldownDurable(rateLimit);
      throw rateLimit;
    }
    throw new Error(`Docs API error (${res.status}): ${text}`);
  }

  const doc = await res.json();
  return parseDocContent(doc, suggestionsAccessible);
}

type ObjectMaps = {
  lists?: DocsLists;
  inlineObjects?: Record<string, EmbeddedObjectDef>;
  positionedObjects?: Record<string, EmbeddedObjectDef>;
  footnotes?: Record<string, { content?: DocsElement[] }>;
};

/**
 * Pure renderer: raw `documents.get` JSON → DocContent (markdown projection +
 * per-tab suggestions). Separated from the fetch so the exact production
 * rendering can run over a doc fetched any way - the live OAuth test harness
 * and unit fixtures both call this.
 */
export function parseDocContent(raw: unknown, suggestionsAccessible = true): DocContent {
  const doc = raw as {
    documentId: string;
    title: string;
    tabs?: DocsTab[];
    body?: { content: DocsElement[] };
  } & ObjectMaps;

  // Tabs carry their own maps (lists/inlineObjects/positionedObjects/footnotes)
  // under `documentTab`; the doc-level ones cover the untabbed body. Each tab
  // resolves against doc-level maps overlaid with ITS OWN maps only -
  // accumulating across tabs lets one tab's IDs shadow another's, rendering
  // wrong-tab footnote text or alt text when IDs repeat.
  const docMaps: ObjectMaps = {
    lists: doc.lists ?? {},
    inlineObjects: doc.inlineObjects ?? {},
    positionedObjects: doc.positionedObjects ?? {},
    footnotes: doc.footnotes ?? {},
  };
  const mapsFor = (t: DocsTab): ObjectMaps => {
    const dt = (t.documentTab ?? t) as ObjectMaps;
    return {
      lists: { ...docMaps.lists, ...(dt.lists ?? {}) },
      inlineObjects: { ...docMaps.inlineObjects, ...(dt.inlineObjects ?? {}) },
      positionedObjects: { ...docMaps.positionedObjects, ...(dt.positionedObjects ?? {}) },
      footnotes: { ...docMaps.footnotes, ...(dt.footnotes ?? {}) },
    };
  };

  const extractTab = (body: DocsElement[] | undefined, maps: ObjectMaps): { content: string; suggestions: DocSuggestion[] } => {
    const collector = new SuggestionCollector();
    const ctx: ExtractContext = { ...maps, footnoteRefs: new Map() };
    let content = body ? extractContent(body, collector, ctx) : "";
    content += renderFootnotes(collector, ctx);
    return { content, suggestions: collector.toList() };
  };

  const tabs: DocTab[] = [];

  if (doc.tabs && doc.tabs.length > 0) {
    for (const tab of walkTabs(doc.tabs)) {
      const body = tab.documentTab?.body ?? tab.body;
      const { content, suggestions } = extractTab(body?.content, mapsFor(tab));
      tabs.push({
        tabId: tab.tabProperties.tabId,
        tabName: tab.tabProperties.title,
        parentTabId: tab.tabProperties.parentTabId ?? null,
        content,
        suggestions,
        contentHash: hashContent(content, suggestions),
      });
    }
  } else if (doc.body?.content) {
    const { content, suggestions } = extractTab(doc.body.content, docMaps);
    tabs.push({
      tabId: "default",
      tabName: "Main",
      parentTabId: null,
      content,
      suggestions,
      contentHash: hashContent(content, suggestions),
    });
  }

  return { docId: doc.documentId, title: doc.title, tabs, suggestionsAccessible, raw: doc };
}

function* walkTabs(tabs: DocsTab[]): Generator<DocsTab> {
  for (const tab of tabs) {
    yield tab;
    if ((tab as any).childTabs?.length) yield* walkTabs((tab as any).childTabs);
  }
}

function extractContent(elements: DocsElement[], collector: SuggestionCollector, ctx: ExtractContext): string {
  const lines: string[] = [];
  // Track the running item number per (listId, nestingLevel) for ordered lists.
  const orderedCounters = new Map<string, number>();

  for (const el of elements) {
    if (el.paragraph) {
      // Floating objects render as placeholder lines at their anchor paragraph
      // (their only known location in the text flow).
      for (const posId of el.paragraph.positionedObjectIds ?? []) {
        lines.push(embeddedObjectPlaceholder(ctx.positionedObjects?.[posId]));
      }

      const style = el.paragraph.paragraphStyle?.namedStyleType;
      const text = extractParagraphText(el.paragraph.elements, collector, ctx);
      if (!text.trim()) {
        lines.push("");
        orderedCounters.clear(); // a blank line ends any list run
        continue;
      }

      const bullet = el.paragraph.bullet;
      if (bullet) {
        const level = bullet.nestingLevel ?? 0;
        const indent = "  ".repeat(level);
        const key = `${bullet.listId ?? ""}:${level}`;
        if (isOrderedList(ctx.lists, bullet.listId, level)) {
          const n = (orderedCounters.get(key) ?? 0) + 1;
          orderedCounters.set(key, n);
          lines.push(`${indent}${n}. ${text.trim()}`);
        } else {
          lines.push(`${indent}- ${text.trim()}`);
        }
      } else if (style?.startsWith("HEADING_")) {
        orderedCounters.clear();
        const level = parseInt(style.replace("HEADING_", ""), 10);
        lines.push(`${"#".repeat(level)} ${text.trim()}`);
      } else {
        orderedCounters.clear();
        lines.push(text);
      }
      collector.noteBaseText("\n");
    } else if (el.table) {
      orderedCounters.clear();
      lines.push(extractTable(el.table.tableRows, collector, ctx));
      collector.noteBaseText("\n");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Render the footnotes referenced during a body walk as real markdown footnote
 * definitions (`[^n]: text`). Bodies are walked with the same collector so
 * suggestions inside footnotes are still captured.
 */
function renderFootnotes(collector: SuggestionCollector, ctx: ExtractContext): string {
  if (ctx.footnoteRefs.size === 0 || !ctx.footnotes) return "";
  const defs: string[] = [];
  for (const [footnoteId, number] of ctx.footnoteRefs) {
    const body = ctx.footnotes[footnoteId]?.content;
    if (!body) continue;
    // Footnote bodies must not re-enter footnote collection (no nesting).
    const innerCtx: ExtractContext = { ...ctx, footnoteRefs: new Map() };
    const text = extractContent(body, collector, innerCtx).replace(/\n+/g, " ").trim();
    defs.push(`[^${number}]: ${text}`);
  }
  return defs.length > 0 ? `\n\n${defs.join("\n")}` : "";
}

type TextStyle = { bold?: boolean; italic?: boolean; strikethrough?: boolean };

function applyInlineStyle(text: string, style: TextStyle | undefined): string {
  if (!text) return text;
  // Preserve leading/trailing whitespace outside the emphasis markers so
  // markdown emphasis renders (e.g. "**bold** next", not "** bold ** next").
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const trail = text.match(/\s*$/)?.[0] ?? "";
  let core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  if (style?.strikethrough) core = `~~${core}~~`;
  if (style?.bold && style?.italic) core = `***${core}***`;
  else if (style?.bold) core = `**${core}**`;
  else if (style?.italic) core = `*${core}*`;
  return `${lead}${core}${trail}`;
}

/**
 * Suggestion bookkeeping for non-text elements (chips, footnote markers,
 * equations, inline objects), mirroring the textRun path: a suggested
 * insertion/deletion of an element is a real pending suggestion and must reach
 * the collector as its rendered placeholder - otherwise a chip-only suggestion
 * is invisible to cards, hashes, and sync. Returns true when the element is a
 * pending insertion and must be skipped from base content.
 */
function noteNonText(
  el: { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] },
  rendered: string,
  collector: SuggestionCollector,
): boolean {
  const insertionIds = el.suggestedInsertionIds ?? [];
  const deletionIds = el.suggestedDeletionIds ?? [];
  for (const id of insertionIds) collector.addInsertion(id, rendered);
  for (const id of deletionIds) collector.addDeletion(id, rendered);
  if (insertionIds.length > 0) return true;
  collector.noteBaseText(rendered, deletionIds);
  return false;
}

function extractParagraphText(elements: ParagraphElement[], collector: SuggestionCollector, ctx: ExtractContext): string {
  let text = "";
  for (const el of elements) {
    if (el.textRun) {
      const content = el.textRun.content;
      const insertionIds = el.textRun.suggestedInsertionIds ?? [];
      const deletionIds = el.textRun.suggestedDeletionIds ?? [];

      for (const id of insertionIds) collector.addInsertion(id, content);
      for (const id of deletionIds) collector.addDeletion(id, content);

      // Suggested insertions are pending - not part of the base (as-if-
      // rejected) content. Text pending deletion still exists, so it stays.
      if (insertionIds.length > 0) continue;

      // Base content in document order feeds placement context; a run's own
      // pending-deletion text must not fill its own after-context.
      collector.noteBaseText(content, deletionIds);

      const st = el.textRun.textStyle;
      if (st?.link?.url) {
        text += `[${content.trim()}](${st.link.url})`;
      } else {
        text += applyInlineStyle(content, st);
      }
    } else if (el.person) {
      const name = el.person.personProperties?.name?.trim();
      const email = el.person.personProperties?.email?.trim();
      const chip = name ? `@${name}` : email ? `@${email}` : "@person";
      if (noteNonText(el.person, chip, collector)) continue;
      text += email && name ? `[${chip}](mailto:${email})` : chip;
    } else if (el.richLink) {
      const title = el.richLink.richLinkProperties?.title?.trim();
      const uri = el.richLink.richLinkProperties?.uri;
      if (noteNonText(el.richLink, title || uri || "[link]", collector)) continue;
      text += uri ? `[${title || uri}](${uri})` : title ?? "[link]";
    } else if (el.dateElement) {
      const dp = el.dateElement.dateElementProperties;
      // Prefer the exact user-visible chip text; fall back to the ISO date.
      const rendered = dp?.displayText?.trim() || dp?.timestamp?.slice(0, 10) || "[date]";
      if (noteNonText(el.dateElement, rendered, collector)) continue;
      text += rendered;
    } else if (el.footnoteReference) {
      // A pending footnote suggestion is recorded as its placeholder; its
      // number/body only join the rendered footnotes once accepted.
      if (noteNonText(el.footnoteReference, "[footnote]", collector)) continue;
      const number = el.footnoteReference.footnoteNumber ?? String(ctx.footnoteRefs.size + 1);
      if (el.footnoteReference.footnoteId) {
        ctx.footnoteRefs.set(el.footnoteReference.footnoteId, number);
      }
      text += `[^${number}]`;
    } else if (el.equation) {
      // The API exposes no equation content at any role - placeholder is the
      // honest ceiling (even raw.md has nothing more).
      if (noteNonText(el.equation, "[equation]", collector)) continue;
      text += "[equation]";
    } else if (el.inlineObjectElement) {
      const placeholder = embeddedObjectPlaceholder(ctx.inlineObjects?.[el.inlineObjectElement.inlineObjectId]);
      if (noteNonText(el.inlineObjectElement, placeholder, collector)) continue;
      text += placeholder;
    } else if (el.horizontalRule) {
      text += "---";
    }
  }
  return text;
}

function extractTable(rows: TableRow[], collector: SuggestionCollector, ctx: ExtractContext): string {
  // Markdown pipe table - keeps the mirror markdown-first (greppable,
  // LLM-friendly). Markdown requires a header row, so row 1 is treated as the
  // header; Google Docs tables have no header concept, so this is a cosmetic
  // assumption (usually correct) and the lossless `raw.md` carries the true
  // structure. Cell newlines → spaces, pipes escaped so cells never break the
  // table.
  const rowLines = rows.map((row) => {
    const cells = row.tableCells.map((cell) => {
      const cellContent = cell.content ? extractContent(cell.content, collector, ctx) : "";
      return cellContent.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
    });
    return `| ${cells.join(" | ")} |`;
  });
  if (rowLines.length > 1) {
    const columnCount = rows[0]?.tableCells.length ?? 0;
    const separator = `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`;
    rowLines.splice(1, 0, separator);
  }
  return rowLines.join("\n");
}

function hashContent(content: string, suggestions: DocSuggestion[]): string {
  // Pending suggestions are part of the tab's observable state: a new or
  // resolved suggestion must change the hash so downstream refresh triggers.
  const suggestionDigest = suggestions
    .map((s) => `${s.suggestionId}\u0000${s.insertedText}\u0000${s.deletedText}`)
    .sort()
    .join("\u0001");
  const normalized = content.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).update(suggestionDigest).digest("hex").slice(0, 16);
}
