/**
 * Comprehensive validation: test nm parsing + replay across multiple docs.
 * Verifies that our OT replay produces the same document length as the live doc.
 */
import "dotenv/config";
import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

interface ParsedOp {
  type: string;
  text?: string;
  startIndex?: number;
  endIndex?: number;
}

function parseOp(raw: Record<string, unknown>): ParsedOp | null {
  if (!raw || typeof raw !== "object") return null;
  const ty = raw.ty as string | undefined;
  switch (ty) {
    case "is": return { type: "insert", text: raw.s as string, startIndex: raw.ibi as number };
    case "ds": return { type: "delete", startIndex: raw.si as number, endIndex: raw.ei as number };
    case "iss": return { type: "insert_suggestion", text: raw.s as string, startIndex: raw.ibi as number };
    case "dss": return { type: "delete_suggestion", startIndex: raw.si as number, endIndex: raw.ei as number };
    case "nm": {
      const nmc = raw.nmc as Record<string, unknown> | undefined;
      if (nmc) { const inner = parseOp(nmc); if (inner) return inner; }
      return { type: "other" };
    }
    case "as": case "msfd": case "usfd": case "sas":
    case "ae": case "de": case "ue": case "te":
    case "ac": case "mch": case "mkch": case "ucp":
      return { type: "other" };
    case "mlti": return { type: "multi" };
    case "rplc": return { type: "replace" };
    case "rvrt": return { type: "revert" };
    default: return { type: "other" };
  }
}

function flatten(raw: Record<string, unknown>): ParsedOp[] {
  const ty = raw.ty as string | undefined;
  if (ty === "mlti") return ((raw.mts as any[]) ?? []).flatMap(s => flatten(s));
  if (ty === "nm") {
    const nmc = raw.nmc as Record<string, unknown> | undefined;
    if (nmc) return flatten(nmc);
    return [{ type: "other" }];
  }
  const op = parseOp(raw);
  return op ? [op] : [{ type: "other" }];
}

function getDocTextFromApi(doc: any): string {
  let text = "";
  // Try tabs format first
  for (const tab of (doc.tabs ?? [])) {
    const body = tab.documentTab?.body;
    if (body?.content) {
      for (const elem of body.content) {
        if (elem.paragraph?.elements) {
          for (const e of elem.paragraph.elements) {
            if (e.textRun?.content) text += e.textRun.content;
          }
        }
        if (elem.table) {
          for (const row of elem.table.tableRows ?? []) {
            for (const cell of row.tableCells ?? []) {
              for (const cellElem of cell.content ?? []) {
                if (cellElem.paragraph?.elements) {
                  for (const e of cellElem.paragraph.elements) {
                    if (e.textRun?.content) text += e.textRun.content;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  // Fallback to non-tabs format
  if (!text && doc.body?.content) {
    for (const elem of doc.body.content) {
      if (elem.paragraph?.elements) {
        for (const e of elem.paragraph.elements) {
          if (e.textRun?.content) text += e.textRun.content;
        }
      }
    }
  }
  return text;
}

async function testDoc(token: string, fileId: string, fileName: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: "${fileName}" (${fileId})`);
  console.log("=".repeat(60));

  // 1. Get tiles
  const tilesUrl = `https://docs.google.com/document/d/${fileId}/revisions/tiles?id=${fileId}&start=1&showDetailedRevisions=true`;
  const tilesRes = await gFetch(tilesUrl, token);
  if (!tilesRes.ok) { console.log(`  SKIP: tiles failed (${tilesRes.status})`); return; }
  const tilesRaw = await tilesRes.text();
  let tilesData: any;
  try { tilesData = JSON.parse(tilesRaw.slice(4)); } catch { try { tilesData = JSON.parse(tilesRaw.slice(5)); } catch { console.log("  SKIP: tiles parse failed"); return; } }
  const tiles = tilesData.tileInfo ?? [];
  if (tiles.length === 0) { console.log("  SKIP: no tiles"); return; }
  const lastEnd = tiles[tiles.length - 1].end;

  // 2. Get changelog
  const loadUrl = `https://docs.google.com/document/d/${fileId}/revisions/load?id=${fileId}&start=1&end=${lastEnd}`;
  const loadRes = await gFetch(loadUrl, token);
  if (!loadRes.ok) { console.log(`  SKIP: load failed (${loadRes.status})`); return; }
  const loadRaw = await loadRes.text();
  let loadData: any;
  try { loadData = JSON.parse(loadRaw.slice(5)); } catch { try { loadData = JSON.parse(loadRaw.slice(4)); } catch { console.log("  SKIP: load parse failed"); return; } }
  const changelog = loadData.changelog ?? [];

  // 3. Parse operations
  const rawTypes = new Map<string, number>();
  const parsedTypes = new Map<string, number>();
  type FullOp = ParsedOp & { changelogIdx: number };
  const allOps: FullOp[] = [];

  for (let i = 0; i < changelog.length; i++) {
    const entry = changelog[i];
    const rawOp = entry[0] as Record<string, unknown>;
    if (!rawOp) { allOps.push({ type: "other", changelogIdx: i + 1 }); continue; }
    rawTypes.set(rawOp.ty as string ?? "null", (rawTypes.get(rawOp.ty as string ?? "null") ?? 0) + 1);
    const partials = flatten(rawOp);
    for (const p of partials) {
      parsedTypes.set(p.type, (parsedTypes.get(p.type) ?? 0) + 1);
      allOps.push({ ...p, changelogIdx: i + 1 });
    }
  }

  console.log(`  Changelog: ${changelog.length} entries, ${tiles.length} tiles`);
  console.log(`  Raw types: ${[...rawTypes.entries()].map(([k, v]) => `${k}:${v}`).join(", ")}`);
  console.log(`  Parsed types: ${[...parsedTypes.entries()].map(([k, v]) => `${k}:${v}`).join(", ")}`);

  // 4. Replay
  const docState: string[] = [];
  let opIdx = 0;
  let chunksWithContent = 0;

  for (const tile of tiles) {
    let hasContent = false;
    while (opIdx < allOps.length && allOps[opIdx].changelogIdx <= tile.end) {
      const op = allOps[opIdx];
      if (op.type === "insert" || op.type === "insert_suggestion") {
        const text = op.text ?? "";
        const pos = (op.startIndex ?? 1) - 1;
        if (text.length > 0) {
          docState.splice(pos, 0, ...text.split(""));
          hasContent = true;
        }
      } else if (op.type === "delete" || op.type === "delete_suggestion") {
        const si = (op.startIndex ?? 1) - 1;
        const ei = (op.endIndex ?? op.startIndex ?? 1) - 1;
        const count = ei - si + 1;
        if (count > 0 && si < docState.length) {
          docState.splice(si, count);
          hasContent = true;
        }
      } else if (op.type === "replace" || op.type === "revert") {
        docState.length = 0;
      }
      opIdx++;
    }
    if (hasContent) chunksWithContent++;
  }

  console.log(`  Replay: ${chunksWithContent}/${tiles.length} chunks with content`);
  console.log(`  Replay doc length: ${docState.length} chars`);

  // 5. Compare with live doc
  const docRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${fileId}?includeTabsContent=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const docData = await docRes.json() as any;
  const actualText = getDocTextFromApi(docData);

  console.log(`  Actual doc length: ${actualText.length} chars`);
  const replayText = docState.join("");

  if (actualText.length === 0) {
    console.log(`  WARN: Could not extract text from API (tabs structure issue?)`);
    console.log(`  Replay first 100: "${replayText.slice(0, 100).replace(/\n/g, "\\n")}"`);
  } else if (replayText === actualText) {
    console.log(`  MATCH: EXACT ✓`);
  } else {
    const diff = Math.abs(replayText.length - actualText.length);
    const pct = ((diff / Math.max(actualText.length, 1)) * 100).toFixed(1);
    console.log(`  DIFF: ${diff} chars (${pct}%)`);
    // Find first divergence
    let firstDiff = 0;
    for (let i = 0; i < Math.min(replayText.length, actualText.length); i++) {
      if (replayText[i] !== actualText[i]) { firstDiff = i; break; }
    }
    if (firstDiff > 0) {
      console.log(`  First divergence at char ${firstDiff}:`);
      console.log(`    Replay: "...${replayText.slice(Math.max(0, firstDiff - 20), firstDiff + 30).replace(/\n/g, "\\n")}..."`);
      console.log(`    Actual: "...${actualText.slice(Math.max(0, firstDiff - 20), firstDiff + 30).replace(/\n/g, "\\n")}..."`);
    }
  }

  // 6. Check for unknown operation types (anything not handled)
  const unknownOps = allOps.filter(o => o.type === "other");
  if (unknownOps.length > 0) {
    console.log(`  Unknown/other ops: ${unknownOps.length} (non-text affecting, safe to ignore)`);
  }
}

async function main() {
  const token = await getGoogleAccessToken("default");

  // Get recent docs
  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=5&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const files = ((await filesRes.json()) as any).files ?? [];

  console.log(`Testing ${files.length} most recently modified docs...\n`);

  for (const file of files) {
    try {
      await testDoc(token, file.id, file.name);
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\n\nDone.");
}

main().catch(console.error);
