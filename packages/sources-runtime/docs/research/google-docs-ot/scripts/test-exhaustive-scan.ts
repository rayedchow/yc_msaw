/**
 * Exhaustive OT type scanner: scan ALL Google Docs in the workspace
 * to discover rare/undiscovered operation types.
 *
 * Walks every operation recursively including inside nm.nmc, mlti.mts[], rplc.snapshot[].
 * Highlights any type NOT in the known set of 24.
 */
import "dotenv/config";
import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

// ---------------------------------------------------------------------------
// Known types (24 + null)
// ---------------------------------------------------------------------------

const KNOWN_TYPES = new Set([
  "is", "ds", "iss", "dss", "msfd", "usfd",
  "nm", "mlti",
  "as", "sas", "astss",
  "ae", "de", "ue", "te",
  "rplc", "rvrt",
  "ac", "mch", "mkch", "ucp", "dc",
  "ras", "umv", "utlp",
  "null", // null ops
]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface TypeOccurrence {
  ty: string;
  docId: string;
  docName: string;
  /** Nesting path, e.g. "mlti>nm>???" */
  path: string;
  /** First example of the full operation JSON (truncated) */
  example: string;
  count: number;
}

const globalTypeCounts = new Map<string, number>();
const newTypes = new Map<string, TypeOccurrence>();
const globalPathCounts = new Map<string, number>();
let totalDocs = 0;
let totalEntries = 0;
let totalSkipped = 0;

// ---------------------------------------------------------------------------
// Recursive walker
// ---------------------------------------------------------------------------

function walkOp(
  op: any,
  path: string,
  docId: string,
  docName: string,
): void {
  if (!op || typeof op !== "object") {
    globalTypeCounts.set("null", (globalTypeCounts.get("null") ?? 0) + 1);
    const fullPath = path ? `${path}>null` : "null";
    globalPathCounts.set(fullPath, (globalPathCounts.get(fullPath) ?? 0) + 1);
    return;
  }

  const ty = (op.ty as string) ?? "null";
  globalTypeCounts.set(ty, (globalTypeCounts.get(ty) ?? 0) + 1);

  const fullPath = path ? `${path}>${ty}` : ty;
  globalPathCounts.set(fullPath, (globalPathCounts.get(fullPath) ?? 0) + 1);

  // Check if this is a NEW type
  if (!KNOWN_TYPES.has(ty)) {
    if (!newTypes.has(ty)) {
      const example = JSON.stringify(op).slice(0, 2000);
      newTypes.set(ty, {
        ty,
        docId,
        docName,
        path: fullPath,
        example,
        count: 1,
      });
      console.log(`\n!!! NEW TYPE FOUND: "${ty}" in "${docName}" (${docId})`);
      console.log(`    Path: ${fullPath}`);
      console.log(`    Full JSON: ${example}`);
    } else {
      newTypes.get(ty)!.count++;
    }
  }

  // Recurse into containers
  if (ty === "mlti" && Array.isArray(op.mts)) {
    for (const sub of op.mts) {
      walkOp(sub, fullPath, docId, docName);
    }
  }

  if (ty === "nm") {
    if (op.nmc && typeof op.nmc === "object") {
      walkOp(op.nmc, fullPath, docId, docName);
    }
  }

  if ((ty === "rplc" || ty === "rvrt") && Array.isArray(op.snapshot)) {
    for (const sub of op.snapshot) {
      walkOp(sub, fullPath, docId, docName);
    }
  }

  // Also check for any array or object fields that might contain nested ops
  // beyond the known containers (mts, nmc, snapshot)
  for (const key of Object.keys(op)) {
    if (key === "mts" || key === "nmc" || key === "snapshot" || key === "ty") continue;
    const val = op[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === "object" && item.ty !== undefined) {
          // Found a nested operation in an unexpected field!
          console.log(`    !!! Nested op in field "${key}" of type "${ty}": sub.ty="${item.ty}"`);
          walkOp(item, `${fullPath}.${key}[]`, docId, docName);
        }
      }
    } else if (val && typeof val === "object" && !Array.isArray(val) && val.ty !== undefined) {
      console.log(`    !!! Nested op in field "${key}" of type "${ty}": sub.ty="${val.ty}"`);
      walkOp(val, `${fullPath}.${key}`, docId, docName);
    }
  }
}

// ---------------------------------------------------------------------------
// List ALL Google Docs in the workspace (paginated)
// ---------------------------------------------------------------------------

async function listAllDocs(
  token: string,
): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
  const allFiles: Array<{ id: string; name: string; modifiedTime: string }> = [];
  let pageToken: string | undefined;
  let page = 0;

  console.log("Listing ALL Google Docs in workspace...");

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", "mimeType='application/vnd.google-apps.document'");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("fields", "nextPageToken,files(id,name,modifiedTime)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await gFetch(url.toString(), token);
    if (!res.ok) {
      console.error(`Drive files.list failed (${res.status})`);
      break;
    }

    const data = (await res.json()) as {
      files?: Array<{ id: string; name: string; modifiedTime: string }>;
      nextPageToken?: string;
    };

    const files = data.files ?? [];
    allFiles.push(...files);
    page++;
    console.log(`  Page ${page}: ${files.length} docs (total so far: ${allFiles.length})`);

    pageToken = data.nextPageToken;
  } while (pageToken);

  console.log(`Found ${allFiles.length} total Google Docs\n`);
  return allFiles;
}

// ---------------------------------------------------------------------------
// Also check for Sheets/Slides/other workspace files
// ---------------------------------------------------------------------------

async function listWorkspaceFiles(
  token: string,
): Promise<void> {
  console.log("\n--- Checking for other workspace file types ---");

  for (const [mime, label] of [
    ["application/vnd.google-apps.spreadsheet", "Sheets"],
    ["application/vnd.google-apps.presentation", "Slides"],
    ["application/vnd.google-apps.drawing", "Drawings"],
    ["application/vnd.google-apps.form", "Forms"],
  ]) {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `mimeType='${mime}'`);
    url.searchParams.set("pageSize", "5");
    url.searchParams.set("fields", "files(id,name)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");

    const res = await gFetch(url.toString(), token);
    if (!res.ok) {
      console.log(`  ${label}: API error (${res.status})`);
      continue;
    }

    const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
    const count = data.files?.length ?? 0;
    console.log(`  ${label}: ${count > 0 ? `found ${count}+` : "none found"}`);

    // Try /revisions/load on a Sheet to see if it uses the same endpoint
    if (label === "Sheets" && data.files?.[0]) {
      const sheetId = data.files[0].id;
      const sheetName = data.files[0].name;
      console.log(`    Testing /revisions/load on Sheet "${sheetName}"...`);
      try {
        const loadUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/revisions/load?id=${sheetId}&start=1&end=9999`;
        const loadRes = await gFetch(loadUrl, token);
        console.log(`    Sheet revisions/load status: ${loadRes.status}`);
        if (loadRes.ok) {
          const raw = await loadRes.text();
          console.log(`    Response size: ${raw.length} bytes, prefix: ${JSON.stringify(raw.slice(0, 20))}`);
        }
      } catch (e) {
        console.log(`    Sheet test failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (label === "Slides" && data.files?.[0]) {
      const slideId = data.files[0].id;
      const slideName = data.files[0].name;
      console.log(`    Testing /revisions/load on Slide "${slideName}"...`);
      try {
        const loadUrl = `https://docs.google.com/presentation/d/${slideId}/revisions/load?id=${slideId}&start=1&end=9999`;
        const loadRes = await gFetch(loadUrl, token);
        console.log(`    Slide revisions/load status: ${loadRes.status}`);
        if (loadRes.ok) {
          const raw = await loadRes.text();
          console.log(`    Response size: ${raw.length} bytes, prefix: ${JSON.stringify(raw.slice(0, 20))}`);
        }
      } catch (e) {
        console.log(`    Slide test failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process a single doc
// ---------------------------------------------------------------------------

async function processDoc(
  token: string,
  fileId: string,
  fileName: string,
  index: number,
  total: number,
): Promise<void> {
  process.stdout.write(`[${index}/${total}] "${fileName}" (${fileId})... `);

  try {
    // 1. Get tiles to find the last revision
    const tilesUrl = `https://docs.google.com/document/d/${fileId}/revisions/tiles?id=${fileId}&start=1&showDetailedRevisions=true`;
    const tilesRes = await gFetch(tilesUrl, token);
    if (!tilesRes.ok) {
      console.log(`SKIP (tiles ${tilesRes.status})`);
      totalSkipped++;
      return;
    }

    const tilesRaw = await tilesRes.text();
    let tilesData: any;
    try {
      tilesData = JSON.parse(tilesRaw.slice(4));
    } catch {
      try {
        tilesData = JSON.parse(tilesRaw.slice(5));
      } catch {
        console.log("SKIP (tiles parse fail)");
        totalSkipped++;
        return;
      }
    }

    const tiles = tilesData.tileInfo ?? [];
    if (tiles.length === 0) {
      console.log("SKIP (no tiles)");
      totalSkipped++;
      return;
    }

    const lastEnd = tiles[tiles.length - 1].end;

    // 2. Fetch the full changelog
    const loadUrl = `https://docs.google.com/document/d/${fileId}/revisions/load?id=${fileId}&start=1&end=${lastEnd}`;
    const loadRes = await gFetch(loadUrl, token);
    if (!loadRes.ok) {
      console.log(`SKIP (load ${loadRes.status})`);
      totalSkipped++;
      return;
    }

    const loadRaw = await loadRes.text();
    let loadData: any;
    try {
      loadData = JSON.parse(loadRaw.slice(5));
    } catch {
      try {
        loadData = JSON.parse(loadRaw.slice(4));
      } catch {
        console.log("SKIP (load parse fail)");
        totalSkipped++;
        return;
      }
    }

    const changelog = loadData.changelog ?? [];

    // 3. Walk every operation recursively
    const docTypes = new Map<string, number>();
    for (const entry of changelog) {
      const op = entry[0];
      walkOp(op, "", fileId, fileName);

      // Track per-doc type counts
      const ty = op?.ty ?? "null";
      docTypes.set(ty, (docTypes.get(ty) ?? 0) + 1);
    }

    totalDocs++;
    totalEntries += changelog.length;

    const typeSummary = [...docTypes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ty, count]) => `${ty}:${count}`)
      .join(", ");

    console.log(`${changelog.length} entries, ${tiles.length} tiles [${typeSummary}]`);

    // Also check the chunkedSnapshot for any operation types
    if (loadData.chunkedSnapshot) {
      const cs = loadData.chunkedSnapshot;
      if (Array.isArray(cs)) {
        for (const chunk of cs) {
          if (chunk && typeof chunk === "object" && chunk.ty !== undefined) {
            walkOp(chunk, "chunkedSnapshot", fileId, fileName);
          }
        }
      }
    }

  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : err}`);
    totalSkipped++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(70));
  console.log("EXHAUSTIVE OT TYPE SCANNER");
  console.log("Scanning ALL Google Docs in workspace for undiscovered operation types");
  console.log("=".repeat(70));
  console.log();

  const token = await getGoogleAccessToken("default");
  console.log("Auth OK\n");

  // 1. List ALL docs
  const allDocs = await listAllDocs(token);

  if (allDocs.length === 0) {
    console.log("No Google Docs found in workspace.");
    return;
  }

  // 2. Process each doc
  console.log("--- Processing all docs ---\n");

  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i];
    await processDoc(token, doc.id, doc.name, i + 1, allDocs.length);

    // Small delay between docs to avoid rate limiting
    if (i < allDocs.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 3. Check other workspace file types
  await listWorkspaceFiles(token);

  // 4. Print results
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  console.log(`Docs processed: ${totalDocs} (${totalSkipped} skipped)`);
  console.log(`Total changelog entries: ${totalEntries}`);

  console.log("\n--- All operation types (global) ---");
  const sortedTypes = [...globalTypeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ty, count] of sortedTypes) {
    const isNew = !KNOWN_TYPES.has(ty);
    const pct = ((count / totalEntries) * 100).toFixed(2);
    console.log(`  ${isNew ? ">>> NEW >>> " : ""}${ty}: ${count} (${pct}%)${isNew ? " <<< NEW" : ""}`);
  }

  console.log("\n--- All nesting paths (top 50) ---");
  const sortedPaths = [...globalPathCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [path, count] of sortedPaths.slice(0, 50)) {
    console.log(`  ${path}: ${count}`);
  }

  // 5. Report NEW types
  if (newTypes.size > 0) {
    console.log("\n" + "!".repeat(70));
    console.log(`CRITICAL: ${newTypes.size} NEW OPERATION TYPE(S) DISCOVERED!`);
    console.log("!".repeat(70));

    for (const [ty, info] of newTypes) {
      console.log(`\n  Type: "${ty}" (seen ${info.count} times)`);
      console.log(`  First found in: "${info.docName}" (${info.docId})`);
      console.log(`  Nesting path: ${info.path}`);
      console.log(`  Full JSON example:`);
      console.log(`    ${info.example}`);
    }
  } else {
    console.log("\nNo new operation types found beyond the known 24.");
    console.log("All types in the workspace are accounted for.");
  }

  console.log("\nDone.");
}

main().catch(console.error);
