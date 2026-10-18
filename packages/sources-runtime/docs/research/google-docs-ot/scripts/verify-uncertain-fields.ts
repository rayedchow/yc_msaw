/**
 * Verify EVERY uncertain style field mapping in the Google Docs OT humanizer
 * by scanning live data across all workspace docs.
 *
 * For each field, we record:
 *   - Every distinct value it takes
 *   - Which doc(s) it appeared in
 *   - Co-occurring fields for cross-reference
 *
 * Then we compare against the official Google Docs API where possible.
 *
 * Run: cd brain && set -a && source .env && set +a && npx tsx scripts/verify-uncertain-fields.ts
 */
import "dotenv/config";
import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldOccurrence {
  value: unknown;
  docId: string;
  docName: string;
  /** Full sm (style map) so we can see co-occurring fields */
  coFields: Record<string, unknown>;
  /** Parent op type (as/sas/astss) */
  opType: string;
  /** Nesting path if inside mlti/nm */
  path: string;
}

interface FieldReport {
  fieldName: string;
  totalOccurrences: number;
  distinctValues: Map<string, { count: number; examples: FieldOccurrence[] }>;
  docsWithField: Set<string>;
}

// Target fields to verify
const TARGET_FIELDS = [
  "ps_lslm",
  "ps_sm",
  "ps_rd",
  "tbls_dshb",
  "tbls_dsvb",
  "tbls_eslr",
  "tbls_eslc",
  "tbls_esfr",
  "tbls_esfc",
  "iws_iwids",
  "nrs_ei",
  "das_a",
  "tbls_ftp",
  "isc_osh",
  "isc_smer",
];

// We also want to capture ps_ls whenever ps_lslm is present (cross-ref)
const EXTRA_WATCH = ["ps_ls"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseXssi(raw: string): any {
  for (const skip of [4, 5]) {
    try { return JSON.parse(raw.slice(skip)); } catch {}
  }
  return null;
}

function valueKey(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// List all docs
// ---------------------------------------------------------------------------

async function listAllDocs(token: string): Promise<Array<{ id: string; name: string }>> {
  const allFiles: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", "mimeType='application/vnd.google-apps.document'");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("fields", "nextPageToken,files(id,name)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await gFetch(url.toString(), token);
    if (!res.ok) break;

    const data = (await res.json()) as { files?: Array<{ id: string; name: string }>; nextPageToken?: string };
    allFiles.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

// ---------------------------------------------------------------------------
// Walk operations to find style maps
// ---------------------------------------------------------------------------

function walkForStyleMaps(
  op: any,
  path: string,
  docId: string,
  docName: string,
  reports: Map<string, FieldReport>,
  lslmLsCorrelation: Array<{ lslm: number; ls: unknown; docName: string }>,
): void {
  if (!op || typeof op !== "object") return;
  const ty = op.ty as string ?? "null";

  // Check if this op has a style map (sm field)
  if ((ty === "as" || ty === "sas" || ty === "astss") && op.sm && typeof op.sm === "object") {
    const sm = op.sm as Record<string, unknown>;

    // Check each target field
    for (const field of TARGET_FIELDS) {
      if (field in sm) {
        const val = sm[field];
        const vk = valueKey(val);

        if (!reports.has(field)) {
          reports.set(field, {
            fieldName: field,
            totalOccurrences: 0,
            distinctValues: new Map(),
            docsWithField: new Set(),
          });
        }

        const report = reports.get(field)!;
        report.totalOccurrences++;
        report.docsWithField.add(docId);

        if (!report.distinctValues.has(vk)) {
          report.distinctValues.set(vk, { count: 0, examples: [] });
        }
        const entry = report.distinctValues.get(vk)!;
        entry.count++;

        // Keep up to 3 examples per value
        if (entry.examples.length < 3) {
          // Collect co-occurring fields (excluding _i inherit flags)
          const coFields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(sm)) {
            if (k !== field && !k.endsWith("_i")) {
              coFields[k] = v;
            }
          }
          entry.examples.push({
            value: val,
            docId,
            docName,
            coFields,
            opType: ty,
            path,
          });
        }
      }
    }

    // Cross-reference: when ps_lslm is present, also capture ps_ls
    if ("ps_lslm" in sm && "ps_ls" in sm) {
      lslmLsCorrelation.push({
        lslm: sm.ps_lslm as number,
        ls: sm.ps_ls,
        docName,
      });
    }
  }

  // Recurse
  if (ty === "mlti" && Array.isArray(op.mts)) {
    for (const sub of op.mts) {
      walkForStyleMaps(sub, `${path}>${ty}`, docId, docName, reports, lslmLsCorrelation);
    }
  }
  if (ty === "nm" && op.nmc) {
    walkForStyleMaps(op.nmc, `${path}>${ty}`, docId, docName, reports, lslmLsCorrelation);
  }
  if ((ty === "rplc" || ty === "rvrt") && Array.isArray(op.snapshot)) {
    for (const sub of op.snapshot) {
      walkForStyleMaps(sub, `${path}>${ty}`, docId, docName, reports, lslmLsCorrelation);
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch and compare against official Docs API
// ---------------------------------------------------------------------------

async function fetchDocsApiData(
  token: string,
  docId: string,
): Promise<any> {
  const url = `https://docs.googleapis.com/v1/documents/${docId}?fields=body.content,namedStyles,documentStyle,namedRanges,lists`;
  const res = await gFetch(url, token);
  if (!res.ok) return null;
  return (await res.json()) as any;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=" .repeat(80));
  console.log("VERIFY UNCERTAIN STYLE FIELD MAPPINGS");
  console.log("Scanning all workspace Google Docs for target fields");
  console.log("=".repeat(80));
  console.log();

  const token = await getGoogleAccessToken("system");
  console.log("Auth OK\n");

  // 1. List all docs
  const allDocs = await listAllDocs(token);
  console.log(`Found ${allDocs.length} Google Docs\n`);

  const reports = new Map<string, FieldReport>();
  const lslmLsCorrelation: Array<{ lslm: number; ls: unknown; docName: string }> = [];
  let totalEntries = 0;
  let docsProcessed = 0;

  // 2. Process each doc
  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i];
    process.stdout.write(`[${i + 1}/${allDocs.length}] "${doc.name}"... `);

    try {
      // Get tiles
      const tilesUrl = `https://docs.google.com/document/d/${doc.id}/revisions/tiles?id=${doc.id}&start=1&showDetailedRevisions=true`;
      const tilesRes = await gFetch(tilesUrl, token);
      if (!tilesRes.ok) { console.log(`SKIP (tiles ${tilesRes.status})`); continue; }

      const tilesRaw = await tilesRes.text();
      const tilesData = parseXssi(tilesRaw);
      if (!tilesData?.tileInfo?.length) { console.log("SKIP (no tiles)"); continue; }

      const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

      // Fetch full changelog
      const loadUrl = `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=${lastEnd}`;
      const loadRes = await gFetch(loadUrl, token);
      if (!loadRes.ok) { console.log(`SKIP (load ${loadRes.status})`); continue; }

      const loadRaw = await loadRes.text();
      const loadData = parseXssi(loadRaw);
      if (!loadData) { console.log("SKIP (parse fail)"); continue; }

      const changelog = loadData.changelog ?? [];
      totalEntries += changelog.length;
      docsProcessed++;

      // Walk all ops
      for (const entry of changelog) {
        walkForStyleMaps(entry[0], "", doc.id, doc.name, reports, lslmLsCorrelation);
      }

      // Also check chunkedSnapshot
      if (loadData.chunkedSnapshot) {
        const cs = Array.isArray(loadData.chunkedSnapshot)
          ? loadData.chunkedSnapshot
          : [loadData.chunkedSnapshot];
        for (const chunk of cs) {
          if (Array.isArray(chunk)) {
            for (const item of chunk) {
              walkForStyleMaps(item, "snapshot", doc.id, doc.name, reports, lslmLsCorrelation);
            }
          } else {
            walkForStyleMaps(chunk, "snapshot", doc.id, doc.name, reports, lslmLsCorrelation);
          }
        }
      }

      const fieldsFound = [...reports.entries()]
        .filter(([_, r]) => r.docsWithField.has(doc.id))
        .map(([f]) => f);
      console.log(`${changelog.length} entries${fieldsFound.length ? ` [found: ${fieldsFound.join(", ")}]` : ""}`);

    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : err}`);
    }

    // Rate limit
    if (i < allDocs.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  // 3. Also try to get Docs API data for a few docs to cross-reference
  console.log("\n\n" + "=".repeat(80));
  console.log("CROSS-REFERENCE: Official Google Docs API");
  console.log("=".repeat(80));

  // Pick up to 3 docs that had interesting fields
  const docsWithTables = new Set<string>();
  const docsWithNamedRanges = new Set<string>();
  for (const [field, report] of reports) {
    if (field.startsWith("tbls_")) {
      for (const docId of report.docsWithField) docsWithTables.add(docId);
    }
    if (field === "nrs_ei") {
      for (const docId of report.docsWithField) docsWithNamedRanges.add(docId);
    }
  }

  const apiCheckDocs = new Set<string>();
  for (const d of docsWithTables) { apiCheckDocs.add(d); if (apiCheckDocs.size >= 3) break; }
  for (const d of docsWithNamedRanges) { apiCheckDocs.add(d); if (apiCheckDocs.size >= 5) break; }
  // Also add first 2 docs as general check
  for (const d of allDocs.slice(0, 2)) { apiCheckDocs.add(d.id); }

  for (const docId of apiCheckDocs) {
    const docName = allDocs.find(d => d.id === docId)?.name ?? docId;
    console.log(`\nChecking "${docName}" via Docs API...`);
    const apiDoc = await fetchDocsApiData(token, docId);
    if (!apiDoc) { console.log("  SKIP (API error)"); continue; }

    // Check for tables
    let tableCount = 0;
    let tablesWithBanding = 0;
    let tablesWithHeaderRow = 0;

    function walkContent(content: any[]) {
      for (const elem of content) {
        if (elem.table) {
          tableCount++;
          const tp = elem.table.tableStyle ?? {};
          // The API doesn't expose banding directly in tableStyle, but tableRows may have tableCellStyle
          // Check for tableStyle properties
          console.log(`  Table found: ${elem.table.rows}x${elem.table.columns}, tableStyle keys: ${Object.keys(tp).join(", ") || "(empty)"}`);

          // Check first row for header-style
          const firstRow = elem.table.tableRows?.[0];
          if (firstRow?.tableRowStyle?.tableHeader) {
            tablesWithHeaderRow++;
            console.log(`    -> Has header row`);
          }

          // Check if banding info is in tableStyle
          if (tp.tableColumnProperties) {
            console.log(`    -> Column props: ${JSON.stringify(tp.tableColumnProperties).slice(0, 100)}`);
          }
        }
        // Recurse into table cells
        if (elem.table?.tableRows) {
          for (const row of elem.table.tableRows) {
            for (const cell of row.tableCells ?? []) {
              if (cell.content) walkContent(cell.content);
            }
          }
        }
      }
    }

    const body = apiDoc.body?.content ?? [];
    walkContent(body);

    // Check named ranges
    const namedRanges = apiDoc.namedRanges ?? {};
    const nrCount = Object.keys(namedRanges).length;
    if (nrCount > 0) {
      console.log(`  Named ranges (${nrCount}):`);
      for (const [name, nr] of Object.entries(namedRanges).slice(0, 5)) {
        const ranges = (nr as any).namedRanges ?? [];
        for (const r of ranges.slice(0, 2)) {
          console.log(`    "${name}": namedRangeId=${r.namedRangeId}, ranges=${JSON.stringify(r.ranges).slice(0, 100)}`);
        }
      }
    }

    // Check document style for anything about line spacing
    const docStyle = apiDoc.documentStyle ?? {};
    console.log(`  Doc style keys: ${Object.keys(docStyle).join(", ")}`);

    // Check paragraph styles for spacingMode, lineSpacing
    let lsExamples = 0;
    for (const elem of body) {
      if (!elem.paragraph) continue;
      const ps = elem.paragraph.paragraphStyle ?? {};
      if (ps.spacingMode || ps.lineSpacing) {
        if (lsExamples < 3) {
          console.log(`  Paragraph spacingMode="${ps.spacingMode ?? "unset"}", lineSpacing=${ps.lineSpacing ?? "unset"}, direction="${ps.direction ?? "unset"}"`);
          lsExamples++;
        }
      }
    }

    // Check lists
    const lists = apiDoc.lists ?? {};
    if (Object.keys(lists).length > 0) {
      console.log(`  Lists (${Object.keys(lists).length}): first list keys: ${JSON.stringify(Object.values(lists)[0]).slice(0, 200)}`);
    }

    if (tableCount > 0) {
      console.log(`  Summary: ${tableCount} tables, ${tablesWithHeaderRow} with header rows`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // 4. Print field-by-field reports
  console.log("\n\n" + "=".repeat(80));
  console.log("FIELD-BY-FIELD VERIFICATION RESULTS");
  console.log(`${docsProcessed} docs, ${totalEntries} changelog entries scanned`);
  console.log("=".repeat(80));

  for (const field of TARGET_FIELDS) {
    const report = reports.get(field);
    console.log(`\n${"─".repeat(70)}`);
    console.log(`FIELD: ${field}`);
    console.log(`${"─".repeat(70)}`);

    if (!report || report.totalOccurrences === 0) {
      console.log("  NOT FOUND in any doc. Field never appears in OT data.");
      console.log("  VERDICT: STILL UNKNOWN (no live data to verify)");
      continue;
    }

    console.log(`  Total occurrences: ${report.totalOccurrences}`);
    console.log(`  Docs with field: ${report.docsWithField.size} (${[...report.docsWithField].map(id => allDocs.find(d => d.id === id)?.name ?? id).join(", ")})`);
    console.log(`  Distinct values (${report.distinctValues.size}):`);

    for (const [vk, { count, examples }] of [...report.distinctValues.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    Value: ${vk.slice(0, 200)}  (${count}x)`);
      for (const ex of examples.slice(0, 2)) {
        const coKeys = Object.keys(ex.coFields);
        const coSummary = coKeys.length > 0
          ? `co-fields: ${coKeys.slice(0, 8).map(k => `${k}=${JSON.stringify(ex.coFields[k]).slice(0, 40)}`).join(", ")}${coKeys.length > 8 ? ` +${coKeys.length - 8} more` : ""}`
          : "no co-fields";
        console.log(`      in "${ex.docName}" via ${ex.opType} | ${coSummary}`);
      }
    }
  }

  // 5. ps_lslm / ps_ls correlation analysis
  console.log(`\n${"─".repeat(70)}`);
  console.log("CROSS-REFERENCE: ps_lslm vs ps_ls correlation");
  console.log(`${"─".repeat(70)}`);

  if (lslmLsCorrelation.length === 0) {
    console.log("  No ops found where both ps_lslm and ps_ls appear together.");
  } else {
    console.log(`  ${lslmLsCorrelation.length} ops with both ps_lslm and ps_ls:`);

    // Group by lslm value
    const byLslm = new Map<number, Array<{ ls: unknown; docName: string }>>();
    for (const c of lslmLsCorrelation) {
      if (!byLslm.has(c.lslm)) byLslm.set(c.lslm, []);
      byLslm.get(c.lslm)!.push({ ls: c.ls, docName: c.docName });
    }

    for (const [lslm, entries] of byLslm) {
      const lsValues = entries.map(e => e.ls);
      const distinct = [...new Set(lsValues.map(v => JSON.stringify(v)))];
      console.log(`  ps_lslm=${lslm}: ps_ls values = [${distinct.slice(0, 10).join(", ")}] (${entries.length} ops)`);

      // Check: if lslm=0, are all ls values multipliers (< 5 typically)?
      // If lslm=1, are all ls values point sizes (>= 5 typically)?
      if (lslm === 0) {
        const nums = lsValues.filter(v => typeof v === "number") as number[];
        const allMultipliers = nums.every(n => n >= 0.5 && n <= 5);
        console.log(`    -> lslm=0: ${nums.length} numeric ls values, range [${Math.min(...nums)}, ${Math.max(...nums)}], all look like multipliers? ${allMultipliers}`);
      }
      if (lslm === 1) {
        const nums = lsValues.filter(v => typeof v === "number") as number[];
        const allPoints = nums.every(n => n >= 5);
        console.log(`    -> lslm=1: ${nums.length} numeric ls values, range [${Math.min(...nums)}, ${Math.max(...nums)}], all look like point sizes? ${allPoints}`);
      }
    }
  }

  // 6. VERDICTS
  console.log("\n\n" + "=".repeat(80));
  console.log("FINAL VERDICTS");
  console.log("=".repeat(80));

  const verdicts: Array<{ field: string; verdict: string; note: string }> = [];

  // ps_lslm
  {
    const r = reports.get("ps_lslm");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "ps_lslm", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      const hasZero = vals.includes("0");
      const hasOne = vals.includes("1");
      const only01 = vals.every(v => v === "0" || v === "1");
      const lslm0Props = lslmLsCorrelation.filter(c => c.lslm === 0).map(c => c.ls as number).filter(v => typeof v === "number");
      const lslm1Props = lslmLsCorrelation.filter(c => c.lslm === 1).map(c => c.ls as number).filter(v => typeof v === "number");

      let note = `Values: ${vals.join(", ")}. `;
      if (only01) note += "Only 0 and 1. ";
      if (lslm0Props.length > 0) note += `When 0: ls=[${[...new Set(lslm0Props)].slice(0, 5).join(",")}]. `;
      if (lslm1Props.length > 0) note += `When 1: ls=[${[...new Set(lslm1Props)].slice(0, 5).join(",")}]. `;

      const lslm0AllMult = lslm0Props.length > 0 && lslm0Props.every(n => n >= 0.5 && n <= 5);
      const lslm1AllPt = lslm1Props.length > 0 && lslm1Props.every(n => n >= 5);

      if (only01 && (lslm0AllMult || lslm0Props.length === 0) && (lslm1AllPt || lslm1Props.length === 0)) {
        verdicts.push({ field: "ps_lslm", verdict: "CONFIRMED", note: note + "0=proportional, 1=fixed-point interpretation holds." });
      } else {
        verdicts.push({ field: "ps_lslm", verdict: "REVISED", note });
      }
    }
  }

  // ps_sm
  {
    const r = reports.get("ps_sm");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "ps_sm", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      // Google Docs API spacingMode: SPACING_MODE_UNSPECIFIED, NEVER_COLLAPSE, COLLAPSE_LISTS
      verdicts.push({
        field: "ps_sm",
        verdict: vals.every(v => v === "0" || v === "1") ? "CONFIRMED" : "REVISED",
        note: `Values: ${vals.join(", ")}. API equivalents: COLLAPSE_LISTS(0?), NEVER_COLLAPSE(1?). ${r.totalOccurrences} total occurrences.`,
      });
    }
  }

  // ps_rd
  {
    const r = reports.get("ps_rd");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "ps_rd", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      verdicts.push({
        field: "ps_rd",
        verdict: "CONFIRMED",
        note: `Values: ${vals.join(", ")}. ${r.totalOccurrences} occurrences across ${r.docsWithField.size} docs.`,
      });
    }
  }

  // tbls_dshb, tbls_dsvb
  for (const f of ["tbls_dshb", "tbls_dsvb"]) {
    const r = reports.get(f);
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: f, verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      const allBool = vals.every(v => v === "true" || v === "false");
      verdicts.push({
        field: f,
        verdict: allBool ? "CONFIRMED" : "REVISED",
        note: `Values: ${vals.join(", ")}. ${allBool ? "Boolean as expected." : "Non-boolean values found!"} ${r.totalOccurrences} occurrences.`,
      });
    }
  }

  // tbls_eslr, tbls_eslc, tbls_esfr, tbls_esfc
  for (const f of ["tbls_eslr", "tbls_eslc", "tbls_esfr", "tbls_esfc"]) {
    const r = reports.get(f);
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: f, verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      const allBool = vals.every(v => v === "true" || v === "false");
      verdicts.push({
        field: f,
        verdict: allBool ? "CONFIRMED" : "REVISED",
        note: `Values: ${vals.join(", ")}. ${r.totalOccurrences} occurrences.`,
      });
    }
  }

  // iws_iwids
  {
    const r = reports.get("iws_iwids");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "iws_iwids", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      verdicts.push({
        field: "iws_iwids",
        verdict: vals.length === 1 && vals[0].includes('"op":"set"') ? "CONFIRMED" : "REVISED",
        note: `${r.distinctValues.size} distinct value structures. ${r.totalOccurrences} occurrences. Values: ${vals.slice(0, 3).map(v => v.slice(0, 100)).join(" | ")}`,
      });
    }
  }

  // nrs_ei
  {
    const r = reports.get("nrs_ei");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "nrs_ei", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      verdicts.push({
        field: "nrs_ei",
        verdict: "REVISED",
        note: `${r.distinctValues.size} distinct value structures. ${r.totalOccurrences} occurrences. Values: ${vals.slice(0, 5).map(v => v.slice(0, 100)).join(" | ")}`,
      });
    }
  }

  // das_a
  {
    const r = reports.get("das_a");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "das_a", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      verdicts.push({
        field: "das_a",
        verdict: "REVISED",
        note: `${r.distinctValues.size} distinct values. ${r.totalOccurrences} occurrences. Values: ${vals.slice(0, 5).map(v => v.slice(0, 200)).join(" | ")}`,
      });
    }
  }

  // tbls_ftp
  {
    const r = reports.get("tbls_ftp");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "tbls_ftp", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      verdicts.push({
        field: "tbls_ftp",
        verdict: "REVISED",
        note: `${r.distinctValues.size} distinct values. ${r.totalOccurrences} occurrences. Values: ${vals.slice(0, 5).map(v => v.slice(0, 200)).join(" | ")}`,
      });
    }
  }

  // isc_osh
  {
    const r = reports.get("isc_osh");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "isc_osh", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      verdicts.push({
        field: "isc_osh",
        verdict: "REVISED",
        note: `${r.distinctValues.size} distinct values. ${r.totalOccurrences} occurrences. Values: ${vals.slice(0, 5).map(v => v.slice(0, 100)).join(" | ")}`,
      });
    }
  }

  // isc_smer
  {
    const r = reports.get("isc_smer");
    if (!r || r.totalOccurrences === 0) {
      verdicts.push({ field: "isc_smer", verdict: "STILL UNKNOWN", note: "No occurrences found" });
    } else {
      const vals = [...r.distinctValues.keys()];
      verdicts.push({
        field: "isc_smer",
        verdict: vals.length === 1 && vals[0] === "true" ? "CONFIRMED" : "REVISED",
        note: `Values: ${vals.join(", ")}. ${r.totalOccurrences} occurrences.`,
      });
    }
  }

  // Print verdict table
  console.log();
  console.log("┌─────────────────┬────────────────┬─────────────────────────────────────────────────────────────┐");
  console.log("│ Field           │ Verdict        │ Notes                                                       │");
  console.log("├─────────────────┼────────────────┼─────────────────────────────────────────────────────────────┤");
  for (const v of verdicts) {
    const field = v.field.padEnd(15);
    const verdict = v.verdict.padEnd(14);
    const note = v.note.slice(0, 59).padEnd(59);
    console.log(`│ ${field} │ ${verdict} │ ${note} │`);
  }
  console.log("└─────────────────┴────────────────┴─────────────────────────────────────────────────────────────┘");

  console.log("\nDone.");
}

main().catch(console.error);
