/**
 * Deep OT analysis: exhaustively inspect every field, every nesting pattern,
 * every edge case across multiple docs. Leave nothing unverified.
 */
import "dotenv/config";
import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");

  // Test across multiple docs with different characteristics
  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=10&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const files = ((await filesRes.json()) as any).files ?? [];

  // Aggregate across ALL docs
  const globalTopLevelTypes = new Map<string, number>();
  const globalNestedTypes = new Map<string, number>(); // path like "mlti>nm>is"
  const globalNmrPrefixes = new Map<string, number>();
  const globalFieldsByType = new Map<string, Set<string>>();
  const globalExamples = new Map<string, any[]>(); // type -> first 2 examples
  let totalEntries = 0;
  let totalDocs = 0;

  // Track nesting patterns
  const nestingPatterns = new Map<string, number>(); // e.g. "mlti[nm[is], as]"

  function recordFields(ty: string, obj: Record<string, unknown>) {
    if (!globalFieldsByType.has(ty)) globalFieldsByType.set(ty, new Set());
    const fields = globalFieldsByType.get(ty)!;
    for (const key of Object.keys(obj)) {
      fields.add(key);
    }
  }

  function recordExample(ty: string, obj: any) {
    if (!globalExamples.has(ty)) globalExamples.set(ty, []);
    const examples = globalExamples.get(ty)!;
    if (examples.length < 2) examples.push(obj);
  }

  function describeOp(op: any, depth: number = 0): string {
    if (!op || typeof op !== "object") return "null";
    const ty = op.ty as string ?? "null";
    if (ty === "mlti" && Array.isArray(op.mts)) {
      const children = (op.mts as any[]).map(s => describeOp(s, depth + 1));
      return `mlti[${children.join(",")}]`;
    }
    if (ty === "nm" && op.nmc) {
      return `nm[${describeOp(op.nmc, depth + 1)}]`;
    }
    return ty;
  }

  function walkOp(op: any, path: string) {
    if (!op || typeof op !== "object") return;
    const ty = op.ty as string ?? "null";

    const fullPath = path ? `${path}>${ty}` : ty;
    globalNestedTypes.set(fullPath, (globalNestedTypes.get(fullPath) ?? 0) + 1);
    recordFields(ty, op);
    recordExample(ty, op);

    // Check nm for nmr prefixes
    if (ty === "nm" && Array.isArray(op.nmr)) {
      for (const r of op.nmr) {
        if (typeof r === "string") {
          const prefix = r.includes(".") ? r.split(".")[0] + "." : r;
          globalNmrPrefixes.set(prefix, (globalNmrPrefixes.get(prefix) ?? 0) + 1);
        }
      }
    }

    // Recurse
    if (ty === "mlti" && Array.isArray(op.mts)) {
      for (const sub of op.mts) walkOp(sub, fullPath);
    }
    if (ty === "nm" && op.nmc) {
      walkOp(op.nmc, fullPath);
    }
    if ((ty === "rplc" || ty === "rvrt") && Array.isArray(op.snapshot)) {
      for (const sub of op.snapshot) walkOp(sub, fullPath);
    }
  }

  for (const file of files) {
    console.log(`\nAnalyzing: "${file.name}"...`);
    try {
      const tilesUrl = `https://docs.google.com/document/d/${file.id}/revisions/tiles?id=${file.id}&start=1&showDetailedRevisions=true`;
      const tilesRes = await gFetch(tilesUrl, token);
      if (!tilesRes.ok) { console.log(`  SKIP: tiles ${tilesRes.status}`); continue; }
      const tilesRaw = await tilesRes.text();
      let tilesData: any;
      try { tilesData = JSON.parse(tilesRaw.slice(4)); } catch { try { tilesData = JSON.parse(tilesRaw.slice(5)); } catch { continue; } }
      if (!tilesData.tileInfo?.length) { console.log("  SKIP: no tiles"); continue; }
      const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

      const loadUrl = `https://docs.google.com/document/d/${file.id}/revisions/load?id=${file.id}&start=1&end=${lastEnd}`;
      const res = await gFetch(loadUrl, token);
      if (!res.ok) { console.log(`  SKIP: load ${res.status}`); continue; }
      const rawText = await res.text();
      let data: any;
      try { data = JSON.parse(rawText.slice(5)); } catch { try { data = JSON.parse(rawText.slice(4)); } catch { continue; } }
      const changelog = data.changelog ?? [];

      console.log(`  ${changelog.length} entries`);
      totalEntries += changelog.length;
      totalDocs++;

      // Check entry tuple structure
      if (changelog.length > 0) {
        const maxLen = Math.max(...changelog.map((e: any[]) => e.length));
        const minLen = Math.min(...changelog.map((e: any[]) => e.length));
        console.log(`  Entry tuple length: min=${minLen}, max=${maxLen}`);
        if (maxLen > 6) {
          const bigEntry = changelog.find((e: any[]) => e.length > 6);
          console.log(`  Extra fields beyond [op,ts,uid,rev,sid,sidx]: ${JSON.stringify(bigEntry?.slice(6)).slice(0, 200)}`);
        }
      }

      // Walk all operations
      for (const entry of changelog) {
        const op = entry[0];
        if (!op) {
          globalTopLevelTypes.set("null", (globalTopLevelTypes.get("null") ?? 0) + 1);
          continue;
        }
        const ty = op.ty as string ?? "null";
        globalTopLevelTypes.set(ty, (globalTopLevelTypes.get(ty) ?? 0) + 1);

        // Record nesting pattern
        const pattern = describeOp(op);
        nestingPatterns.set(pattern, (nestingPatterns.get(pattern) ?? 0) + 1);

        // Walk recursively
        walkOp(op, "");
      }

      // Check for tab-related fields in the nm operations
      let nmWithTabNmr = 0;
      let nmWithKixNmr = 0;
      let nmWithOtherNmr = 0;
      for (const entry of changelog) {
        const op = entry[0];
        if (op?.ty === "nm" && Array.isArray(op.nmr)) {
          const nmrStrs = (op.nmr as any[]).filter(r => typeof r === "string");
          const hasTab = nmrStrs.some(r => r.startsWith("t."));
          const hasKix = nmrStrs.some(r => r.startsWith("kix."));
          const hasKsm = nmrStrs.some(r => r === "ksm");
          if (hasTab) nmWithTabNmr++;
          if (hasKix) nmWithKixNmr++;
          if (!hasTab && !hasKix && !hasKsm) nmWithOtherNmr++;
        }
      }
      console.log(`  nm ranges: tab(t.)=${nmWithTabNmr}, kix=${nmWithKixNmr}, other=${nmWithOtherNmr}`);

      // Check the "second to last chunk" for tab info
      const withContent = [];
      let opIdx = 0;
      const allOps: any[] = [];
      for (let i = 0; i < changelog.length; i++) {
        allOps.push({ raw: changelog[i][0], idx: i + 1 });
      }

    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }

  // === GLOBAL RESULTS ===
  console.log(`\n${"=".repeat(70)}`);
  console.log(`GLOBAL ANALYSIS: ${totalDocs} docs, ${totalEntries} total entries`);
  console.log("=".repeat(70));

  console.log(`\n--- Top-level operation types ---`);
  for (const [ty, count] of [...globalTopLevelTypes.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalEntries) * 100).toFixed(1);
    console.log(`  ${ty}: ${count} (${pct}%)`);
  }

  console.log(`\n--- ALL nested paths (type>subtype chains) ---`);
  for (const [path, count] of [...globalNestedTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${path}: ${count}`);
  }

  console.log(`\n--- nmr prefix distribution ---`);
  for (const [prefix, count] of [...globalNmrPrefixes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${prefix}: ${count}`);
  }

  console.log(`\n--- Fields by operation type ---`);
  for (const [ty, fields] of [...globalFieldsByType.entries()].sort()) {
    console.log(`  ${ty}: ${[...fields].sort().join(", ")}`);
  }

  console.log(`\n--- Top 20 nesting patterns ---`);
  for (const [pattern, count] of [...nestingPatterns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${count}x ${pattern}`);
  }

  console.log(`\n--- Examples of each type ---`);
  for (const [ty, examples] of [...globalExamples.entries()].sort()) {
    console.log(`\n  ${ty}:`);
    for (const ex of examples) {
      const json = JSON.stringify(ex, null, 2);
      console.log(`    ${json.slice(0, 300).replace(/\n/g, "\n    ")}${json.length > 300 ? "..." : ""}`);
    }
  }
}

test().catch(console.error);
