/**
 * Translates Google Docs internal style field names into human-readable descriptions.
 *
 * The OT protocol uses abbreviated field names like ts_bd (text style: bold),
 * ps_hd (paragraph style: heading), cell_bgc2 (cell background color), etc.
 * This module maps them to English for the synthesis layer.
 *
 * Fields ending in _i are "inherit" flags - when true, the property inherits
 * from the parent style. We skip these in humanization since they're metadata
 * about whether the value is explicit or inherited.
 */

// ---------------------------------------------------------------------------
// Text style fields (ts_ prefix)
// ---------------------------------------------------------------------------

const TEXT_STYLES: Record<string, string | ((v: unknown) => string)> = {
  ts_bd: (v) => v ? "bold" : "removed bold",
  ts_it: (v) => v ? "italic" : "removed italic",
  ts_un: (v) => v ? "underline" : "removed underline",
  ts_st: (v) => v ? "strikethrough" : "removed strikethrough",
  ts_sc: (v) => v ? "small caps" : "removed small caps",
  ts_fs: (v) => `font size ${v}pt`,
  ts_ff: (v) => `font "${v}"`,
  ts_tw: (v) => {
    const w = v as number;
    const names: Record<number, string> = {
      100: "thin", 200: "extra-light", 300: "light", 400: "normal",
      500: "medium", 600: "semi-bold", 700: "bold", 800: "extra-bold", 900: "black",
    };
    return `font weight ${names[w] ?? w} (${w})`;
  },
  ts_va: (v) => {
    if (v === "sup") return "superscript";
    if (v === "sub") return "subscript";
    return "normal vertical alignment";
  },
  ts_fgc: (v) => `text color ${v}`,
  ts_fgc2: (v) => {
    const c = v as Record<string, unknown> | null;
    if (c?.hclr_color) return `text color ${c.hclr_color}`;
    return "text color changed";
  },
  ts_bgc: (v) => v ? `highlight color ${v}` : "removed highlight",
  ts_bgc2: (v) => {
    const c = v as Record<string, unknown> | null;
    if (c?.hclr_color) return `highlight ${c.hclr_color}`;
    return "highlight changed";
  },
};

// ---------------------------------------------------------------------------
// Paragraph style fields (ps_ prefix)
// ---------------------------------------------------------------------------

const PARAGRAPH_STYLES: Record<string, string | ((v: unknown) => string)> = {
  ps_hd: (v) => {
    const level = v as number;
    if (level === 0) return "normal text";
    return `Heading ${level}`;
  },
  ps_al: (v) => {
    const align = v as number;
    if (align === 0) return "left aligned";
    if (align === 1) return "centered";
    if (align === 2) return "right aligned";
    if (align === 3) return "justified";
    return `alignment ${align}`;
  },
  ps_ls: (v) => `line spacing ${v}`,
  ps_sa: (v) => `space after ${v}pt`,
  ps_sb: (v) => `space before ${v}pt`,
  ps_ifl: (v) => `first line indent ${v}pt`,
  ps_il: (v) => `left indent ${v}pt`,
  ps_ir: (v) => `right indent ${v}pt`,
  ps_ltr: (v) => v ? "left-to-right" : "right-to-left",
  ps_bl: "border left",
  ps_br: "border right",
  ps_bb: "border bottom",
  ps_bt: "border top/bullet style",
  ps_bbtw: "border between",
  ps_sd: "shading",
  ps_shd: (v) => {
    if (typeof v === "object" && v !== null) {
      const shd = v as Record<string, unknown>;
      const bg = shd.backgroundColor as Record<string, unknown> | undefined;
      if (bg?.color) return `paragraph shading ${JSON.stringify(bg.color).slice(0, 30)}`;
      return "paragraph shading changed";
    }
    return v ? "shading enabled" : "shading disabled";
  },
  ps_klt: (v) => v ? "keep lines together" : "allow line breaks",
  ps_kwn: (v) => v ? "keep with next paragraph" : "allow page break before",
  ps_awao: (v) => v ? "avoid widow/orphan" : "allow widow/orphan",
  ps_pbb: (v) => v ? "page break before" : "no page break before",
  ps_lslm: (v) => {
    // Verified: only values 0 and 1 across 33k+ occurrences (12 docs).
    // 0=proportional (ps_ls is a multiplier like 1.15, 1.5).
    // 1=absolute (ps_ls is a fixed value, but may still be in multiplier-
    //   scale units - NOT necessarily pt; Google Docs API calls this "FIXED"
    //   and the magnitude is in hundredths of a point internally).
    const mode = v as number;
    if (mode === 0) return "proportional line spacing (e.g., 1.5x)";
    if (mode === 1) return "absolute/fixed line spacing";
    return `line spacing mode ${mode}`;
  },
  ps_sm: (v) => {
    // Verified: only values 0 and 1 across 33k+ occurrences (12 docs).
    // Maps to Google Docs API spacingMode enum:
    //   0 = COLLAPSE_LISTS (default - collapse spacing between same-style paragraphs)
    //   1 = NEVER_COLLAPSE (always apply before/after spacing)
    const mode = v as number;
    if (mode === 0) return "collapse spacing between same-style paragraphs";
    if (mode === 1) return "never collapse paragraph spacing";
    return `spacing mode ${mode}`;
  },
  ps_rd: (v) => v ? `run direction "${v}"` : "default run direction",
  // Verified: ps_rd is always empty string ("") across 44k+ occurrences.
  // Would be "rtl" for right-to-left content but none found in workspace.
  ps_hdid: (v) => v ? `heading ID "${v}"` : "no heading ID",
  ps_ts: "tab stops",
};

// ---------------------------------------------------------------------------
// Document style fields (ds_ prefix)
// ---------------------------------------------------------------------------

const DOCUMENT_STYLES: Record<string, string | ((v: unknown) => string)> = {
  ds_pw: (v) => `page width ${v}pt`,
  ds_ph: (v) => `page height ${v}pt`,
  ds_mt: (v) => `top margin ${v}pt`,
  ds_mb: (v) => `bottom margin ${v}pt`,
  ds_ml: (v) => `left margin ${v}pt`,
  ds_mr: (v) => `right margin ${v}pt`,
  ds_lhs: "layout header/section",
  ds_ulhfl: "use landscape header/footer layout",
  ds_df: "default formatting",
  ds_fpo: (v) => v ? "first page different" : "same first page",
  ds_pnsi: (v) => `page number start index ${v}`,
};

// ---------------------------------------------------------------------------
// Custom section style fields (css_ prefix)
// ---------------------------------------------------------------------------

const SECTION_STYLES: Record<string, string | ((v: unknown) => string)> = {
  css_ml: "section left margin",
  css_mr: "section right margin",
  css_mt: "section top margin",
  css_mb: "section bottom margin",
  css_pnsi: "section page number start",
  css_fpo: "section first page different",
};

// ---------------------------------------------------------------------------
// Heading style definitions (hs_ prefix)
// ---------------------------------------------------------------------------

const HEADING_STYLES: Record<string, string | ((v: unknown) => string)> = {
  hs_h1: "Heading 1 style definition",
  hs_h2: "Heading 2 style definition",
  hs_h3: "Heading 3 style definition",
  hs_h4: "Heading 4 style definition",
  hs_h5: "Heading 5 style definition",
  hs_h6: "Heading 6 style definition",
  hs_t: "Title style definition",
  hs_st: "Subtitle style definition",
  hs_nt: "Normal text style definition",
};

// ---------------------------------------------------------------------------
// Table cell fields (cell_ prefix)
// ---------------------------------------------------------------------------

const CELL_STYLES: Record<string, string | ((v: unknown) => string)> = {
  cell_pt: (v) => `cell padding top ${v}pt`,
  cell_pb: (v) => `cell padding bottom ${v}pt`,
  cell_pl: (v) => `cell padding left ${v}pt`,
  cell_pr: (v) => `cell padding right ${v}pt`,
  cell_bt: "cell border top",
  cell_bb: "cell border bottom",
  cell_bl: "cell border left",
  cell_br: "cell border right",
  cell_bgc2: (v) => {
    const c = v as Record<string, unknown> | null;
    if (c?.hclr_color) return `cell background ${c.hclr_color}`;
    return "cell background changed";
  },
  cell_va: (v) => {
    const align = v as number;
    if (align === 0) return "cell vertical align top";
    if (align === 1) return "cell vertical align middle";
    if (align === 2) return "cell vertical align bottom";
    return `cell vertical align ${align}`;
  },
  cell_cs: (v) => `cell column span ${v}`,
  cell_rs: (v) => `cell row span ${v}`,
  cell_esc: "cell end of section content",
  cell_edc: "cell end of document content",
};

// ---------------------------------------------------------------------------
// Table row fields (row_ prefix)
// ---------------------------------------------------------------------------

const ROW_STYLES: Record<string, string | ((v: unknown) => string)> = {
  row_th: (v) => v ? "table header row" : "normal row",
  row_mh: (v) => `min row height ${v}pt`,
  row_ich: (v) => v ? "row content changed" : "row unchanged",
  row_trid: "table row ID",
  row_cs: (v) => v ? "row collapsed" : "row expanded",
  row_tr: "table row properties",
};

// ---------------------------------------------------------------------------
// Table style fields (tbls_ prefix)
// ---------------------------------------------------------------------------

const TABLE_STYLES: Record<string, string | ((v: unknown) => string)> = {
  tbls_cols: "table column widths",
  tbls_al: (v) => {
    const a = v as number;
    if (a === 0) return "table left aligned";
    if (a === 1) return "table centered";
    if (a === 2) return "table right aligned";
    return `table alignment ${a}`;
  },
  tbls_ltr: (v) => v ? "table left-to-right" : "table right-to-left",
  tbls_in: (v) => `table indent ${v}pt`,
  tbls_tblid: "table ID",
  tbls_bc2: "table border color",
  tbls_bw: (v) => `table border width ${v}pt`,
  tbls_pt: (v) => `table padding ${v}pt`,
  tbls_tt: "table type",
  tbls_vn: "table version",
  tbls_ftp: (v) => {
    // Verified: always an object with ft_ml/ft_mb/ft_mr/ft_mt (margin/padding
    // in pt) and ft_p (a complex object with hover/border/padding/viewport
    // properties - hp, bd, tw, vp sub-objects).
    // This is the table's formatting template defining default cell margins
    // and visual rendering properties, NOT a template ID.
    const ftp = v as Record<string, unknown> | null;
    if (ftp && typeof ftp === "object") {
      const margins = [ftp.ft_mt, ftp.ft_mr, ftp.ft_mb, ftp.ft_ml].filter(Boolean);
      if (margins.length > 0) return `table formatting template (margins: ${margins.join("/")}pt)`;
    }
    return "table formatting template";
  },
  // Verified: boolean, true/false across 55 occurrences (4 docs with tables).
  tbls_dshb: (v) => v ? "show horizontal banding" : "no horizontal banding",
  tbls_dsvb: (v) => v ? "show vertical banding" : "no vertical banding",
  // Verified: boolean. All 55 occurrences were false - enable/disable special
  // formatting for first/last row/column. These correspond to the Google Docs
  // table property checkboxes (Column header, Row header, etc).
  tbls_eslr: (v) => v ? "enable special last row formatting" : "no special last row formatting",
  tbls_eslc: (v) => v ? "enable special last column formatting" : "no special last column formatting",
  tbls_esfr: (v) => v ? "enable special first row formatting" : "no special first row formatting",
  tbls_esfc: (v) => v ? "enable special first column formatting" : "no special first column formatting",
  tbls_emcid: "merge cell ID",
  tbls_emrk: "merge key",
  tbls_emoid: "merge origin ID",
  tbls_cfwt: "conditional format whole table",
  tbls_cffr: "conditional format first row",
  tbls_cflr: "conditional format last row",
  tbls_cffc: "conditional format first column",
  tbls_cflc: "conditional format last column",
  tbls_cfb1h: "conditional format band 1 horizontal",
  tbls_cfb2h: "conditional format band 2 horizontal",
  tbls_cfb1v: "conditional format band 1 vertical",
  tbls_cfb2v: "conditional format band 2 vertical",
  tbls_cfnwc: "conditional format NW corner",
  tbls_cfnec: "conditional format NE corner",
  tbls_cfswc: "conditional format SW corner",
  tbls_cfsec: "conditional format SE corner",
};

// ---------------------------------------------------------------------------
// List style fields (ls_ prefix)
// ---------------------------------------------------------------------------

const LIST_STYLES: Record<string, string | ((v: unknown) => string)> = {
  ls_ts: "list text style",
  ls_nest: (v) => `list nesting level ${v}`,
  ls_id: (v) => `list ID ${v}`,
  ls_c: "list continuation",
};

// ---------------------------------------------------------------------------
// Link fields (lnks_ prefix)
// ---------------------------------------------------------------------------

const LINK_STYLES: Record<string, string | ((v: unknown) => string)> = {
  lnks_link: (v) => {
    const link = v as Record<string, unknown> | null;
    if (link?.ulnk_url) return `link to ${(link.ulnk_url as string).slice(0, 60)}`;
    return "link changed";
  },
};

// ---------------------------------------------------------------------------
// Language fields (lgs_ prefix)
// ---------------------------------------------------------------------------

const LANGUAGE_STYLES: Record<string, string | ((v: unknown) => string)> = {
  lgs_l: (v) => `language "${v}"`,
};

// ---------------------------------------------------------------------------
// Other/misc fields
// ---------------------------------------------------------------------------

const MISC_STYLES: Record<string, string | ((v: unknown) => string)> = {
  das_a: (v) => {
    // Verified: a cv (collection value) operating on an array of kix.* element
    // anchor IDs. These are internal document element IDs that anchor content
    // to specific positions. Operations include "set" (replace all), "insert"
    // (add new anchor), and "delete" (remove anchor). The kix.* IDs match
    // internal element identifiers used by the Docs editor.
    // 297 distinct value patterns across 2494 occurrences (12 docs).
    const anchor = v as Record<string, unknown> | null;
    if (anchor?.cv) {
      const cv = anchor.cv as Record<string, unknown>;
      const op = cv.op as string;
      if (op === "set") {
        const ids = cv.opValue as string[] | undefined;
        if (ids && ids.length > 0) return `anchored to ${ids.length} element(s)`;
        return "anchor cleared";
      }
      if (op === "insert") return "anchor added";
      if (op === "delete") return "anchor removed";
    }
    return "document anchor changed";
  },
  isc_osh: (v) => {
    // Verified: either null (99% of occurrences - 2036 of 2054) or a base64-
    // encoded hash string (e.g. "SA+OSzkOnGKW+wOQaTABpQ=="). This is NOT an
    // "inline style override" - it's an Original Style Hash used by the
    // suggestion system to detect if the original styling changed since the
    // suggestion was created. When null, no suggestion context is active.
    if (v === null || v === undefined) return "no original style hash (no suggestion context)";
    return `original style hash "${String(v).slice(0, 20)}..." (suggestion tracking)`;
  },
  isc_smer: (v) => {
    // Verified: ALWAYS true across 2040 occurrences (12 docs). Never false.
    // This is an "inline style merge enabled" flag that tells the editor to
    // merge inline content styles with inherited styles. Always co-occurs
    // with isc_osh.
    return v ? "style merge enabled" : "style merge disabled";
  },
  iws_iwids: (v) => {
    // Verified: ALWAYS {"cv":{"op":"set","opValue":[]}} across 2031 occurrences
    // (12 docs). Never has actual widget IDs - always an empty set operation.
    // This is the inline widget ID collection, always reset to empty in
    // regular paragraph style operations.
    const obj = v as Record<string, unknown> | null;
    if (obj?.cv) {
      const cv = obj.cv as Record<string, unknown>;
      const ids = cv.opValue as unknown[] | undefined;
      if (ids && ids.length > 0) return `inline widget IDs (${ids.length})`;
    }
    return "inline widget IDs cleared";
  },
  cs_cids: "comment style IDs",
  ms_id: "mention style ID",
  nrs_ei: (v) => {
    // Verified: ALWAYS {"cv":{"op":"set","opValue":[]}} across 1492 occurrences
    // (12 docs). Never has actual indices. This is the named range end index
    // collection, always reset to empty in regular paragraph style operations.
    // Actual named range data lives in the nm (named mutation) operations, not
    // in style maps.
    const obj = v as Record<string, unknown> | null;
    if (obj?.cv) {
      const cv = obj.cv as Record<string, unknown>;
      const ids = cv.opValue as unknown[] | undefined;
      if (ids && ids.length > 0) return `named range end indices (${ids.length})`;
    }
    return "named range end indices cleared";
  },
  sfs_sst: (v) => v ? "suggestion state" : "suggestion state cleared",
  colh_ich: (v) => v ? "column header content changed" : "column header unchanged",
};

// ---------------------------------------------------------------------------
// Unified lookup
// ---------------------------------------------------------------------------

const ALL_STYLES: Record<string, Record<string, string | ((v: unknown) => string)>> = {
  ts_: TEXT_STYLES,
  ps_: PARAGRAPH_STYLES,
  ds_: DOCUMENT_STYLES,
  css_: SECTION_STYLES,
  hs_: HEADING_STYLES,
  cell_: CELL_STYLES,
  row_: ROW_STYLES,
  tbls_: TABLE_STYLES,
  ls_: LIST_STYLES,
  lnks_: LINK_STYLES,
  lgs_: LANGUAGE_STYLES,
};

// ---------------------------------------------------------------------------
// Element type humanizer
// ---------------------------------------------------------------------------

const ELEMENT_TYPES: Record<string, string> = {
  list: "list",
  inline: "inline object",
  table: "table",
  toc: "table of contents",
  hr: "horizontal rule",
  "page_break": "page break",
  "section_break": "section break",
  footnote: "footnote",
  equation: "equation",
};

export function humanizeElementType(et: string | undefined): string {
  if (!et) return "element";
  return ELEMENT_TYPES[et] ?? et;
}

// ---------------------------------------------------------------------------
// Main humanizer
// ---------------------------------------------------------------------------

export interface HumanizedStyleChange {
  category: "text" | "paragraph" | "document" | "heading_defs" | "table" | "table_cell" | "table_row" | "list" | "link" | "section" | "language" | "other";
  description: string;
}

/**
 * Humanize a style modification map from a Google Docs OT format operation.
 * Returns an array of human-readable change descriptions grouped by category.
 *
 * Inherit flags (_i suffix) are skipped - they're metadata, not user-visible changes.
 * Unknown fields are returned with their raw name for LLM interpretation.
 */
export function humanizeStyleChanges(
  sm: Record<string, unknown> | undefined,
): HumanizedStyleChange[] {
  if (!sm) return [];

  const results: HumanizedStyleChange[] = [];

  for (const [key, value] of Object.entries(sm)) {
    // Skip inherit flags
    if (key.endsWith("_i")) continue;

    // Skip null/undefined values (reset to default)
    if (value === null || value === undefined) continue;

    // Try each prefix
    let found = false;

    for (const [prefix, table] of Object.entries(ALL_STYLES)) {
      if (key.startsWith(prefix) || key in table) {
        const entry = table[key];
        if (entry) {
          const desc = typeof entry === "function" ? entry(value) : entry;
          const category = prefixToCategory(prefix);
          results.push({ category, description: desc });
          found = true;
          break;
        }
      }
    }

    // Check misc
    if (!found && key in MISC_STYLES) {
      const entry = MISC_STYLES[key];
      const desc = typeof entry === "function" ? entry(value) : entry;
      results.push({ category: "other", description: desc });
      found = true;
    }

    // Unknown field - pass through raw for LLM interpretation
    if (!found) {
      const valStr = typeof value === "object" ? JSON.stringify(value).slice(0, 50) : String(value);
      results.push({
        category: "other",
        description: `unknown style "${key}": ${valStr}`,
      });
    }
  }

  return results;
}

function prefixToCategory(prefix: string): HumanizedStyleChange["category"] {
  switch (prefix) {
    case "ts_": return "text";
    case "ps_": return "paragraph";
    case "ds_": return "document";
    case "css_": return "section";
    case "hs_": return "heading_defs";
    case "cell_": return "table_cell";
    case "row_": return "table_row";
    case "tbls_": return "table";
    case "ls_": return "list";
    case "lnks_": return "link";
    case "lgs_": return "language";
    default: return "other";
  }
}

/**
 * Produce a compact summary of style changes for a session.
 * Groups changes by category and deduplicates.
 */
export function summarizeStyleChanges(
  changes: HumanizedStyleChange[],
): string {
  if (changes.length === 0) return "";

  const byCategory = new Map<string, Set<string>>();
  for (const c of changes) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, new Set());
    byCategory.get(c.category)!.add(c.description);
  }

  const parts: string[] = [];
  for (const [cat, descs] of byCategory) {
    const label = cat === "text" ? "Text" : cat === "paragraph" ? "Paragraph" :
      cat === "table" ? "Table" : cat === "table_cell" ? "Cell" :
      cat === "table_row" ? "Row" : cat === "list" ? "List" :
      cat === "link" ? "Link" : cat === "heading_defs" ? "Heading styles" :
      cat === "document" ? "Document" : cat === "section" ? "Section" :
      cat === "language" ? "Language" : "Other";

    if (descs.size <= 3) {
      parts.push(`${label}: ${[...descs].join(", ")}`);
    } else {
      parts.push(`${label}: ${[...descs].slice(0, 2).join(", ")} and ${descs.size - 2} more`);
    }
  }

  return parts.join(". ");
}
