/**
 * Standalone test for nm operation parsing — no imports from the brain service.
 * Uses Google Auth library directly to get a token, then hits /revisions/load.
 */
import "dotenv/config";
import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function getToken(): Promise<string> {
  return getGoogleAccessToken("default");
}

// ---- Parser (mirrors gdocs-revisions-load.ts with nm fix) ----

interface ParsedOp {
  type: string;
  text?: string;
  startIndex?: number;
  endIndex?: number;
  rawTy?: string;
}

function parseOperation(raw: Record<string, unknown>): ParsedOp | null {
  if (!raw || typeof raw !== "object") return null;
  const ty = raw.ty as string | undefined;
  switch (ty) {
    case "is":
      return { type: "insert", text: raw.s as string, startIndex: raw.ibi as number, rawTy: "is" };
    case "ds":
      return { type: "delete", startIndex: raw.si as number, endIndex: raw.ei as number, rawTy: "ds" };
    case "iss":
      return { type: "insert_suggestion", text: raw.s as string, startIndex: raw.ibi as number, rawTy: "iss" };
    case "dss":
      return { type: "delete_suggestion", startIndex: raw.si as number, endIndex: raw.ei as number, rawTy: "dss" };
    case "as":
      return { type: "format", startIndex: raw.si as number, endIndex: raw.ei as number, rawTy: "as" };
    case "msfd":
      return { type: "mark_deletion", startIndex: raw.si as number, endIndex: raw.ei as number, rawTy: "msfd" };
    case "usfd":
      return { type: "unmark_deletion", startIndex: raw.si as number, endIndex: raw.ei as number, rawTy: "usfd" };
    case "nm": {
      const nmc = raw.nmc as Record<string, unknown> | undefined;
      if (nmc && typeof nmc === "object") {
        const inner = parseOperation(nmc);
        if (inner) return { ...inner, rawTy: `nm>${inner.rawTy}` };
      }
      return { type: "other", rawTy: "nm>none" };
    }
    case "mlti":
      return { type: "multi", rawTy: "mlti" };
    case "rplc":
      return { type: "replace", rawTy: "rplc" };
    case "rvrt":
      return { type: "revert", rawTy: "rvrt" };
    case "ae": case "de": case "ue": case "te": case "sas":
    case "ac": case "mch": case "mkch": case "ucp":
      return { type: "other", rawTy: ty };
    default:
      return { type: "other", rawTy: ty ?? "null" };
  }
}

function flattenMultiOps(raw: Record<string, unknown>): ParsedOp[] {
  const ty = raw.ty as string | undefined;
  if (ty === "mlti") {
    const subs = (raw.mts as Array<Record<string, unknown>>) ?? [];
    const results: ParsedOp[] = [];
    for (const sub of subs) results.push(...flattenMultiOps(sub));
    return results;
  }
  if (ty === "nm") {
    const nmc = raw.nmc as Record<string, unknown> | undefined;
    if (nmc && typeof nmc === "object") return flattenMultiOps(nmc);
    return [{ type: "other", rawTy: "nm>none" }];
  }
  const op = parseOperation(raw);
  return op ? [op] : [{ type: "other", rawTy: "unknown" }];
}

async function test() {
  const token = await getToken();
  const docId = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID"); // Ishan Linkedin Post

  console.log("Fetching tiles...");
  const tilesUrl = `https://docs.google.com/document/d/${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=true`;
  const tilesRes = await gFetch(tilesUrl, token);
  const tilesRaw = await tilesRes.text();
  let tilesData: any;
  try { tilesData = JSON.parse(tilesRaw.slice(4)); } catch { tilesData = JSON.parse(tilesRaw.slice(5)); }
  const tiles = tilesData.tileInfo as Array<{ start: number; end: number; endMillis: number; users: string[] }>;
  const lastEnd = tiles[tiles.length - 1].end;
  console.log(`Tiles: ${tiles.length}, last end: ${lastEnd}`);

  console.log("Fetching changelog...");
  const loadUrl = `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=${lastEnd}`;
  const res = await gFetch(loadUrl, token);
  const rawText = await res.text();
  const data = JSON.parse(rawText.slice(5));
  const changelog = data.changelog ?? [];
  console.log(`Changelog entries: ${changelog.length}\n`);

  // === RAW TYPE COUNTS (before parsing) ===
  const rawTypeCounts = new Map<string, number>();
  for (const entry of changelog) {
    const op = entry[0];
    const ty = op?.ty ?? "null";
    rawTypeCounts.set(ty, (rawTypeCounts.get(ty) ?? 0) + 1);
  }
  console.log("=== Raw top-level operation types ===");
  for (const [ty, count] of [...rawTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ty}: ${count}`);
  }

  // === PARSED TYPES (after nm extraction) ===
  const parsedTypeCounts = new Map<string, number>();
  const rawTyCounts = new Map<string, number>();
  let totalInsertChars = 0;
  let totalDeleteOps = 0;

  type FullOp = ParsedOp & { ts: number; userId: string; changelogIdx: number };
  const allOps: FullOp[] = [];

  for (let i = 0; i < changelog.length; i++) {
    const entry = changelog[i];
    const rawOp = entry[0] as Record<string, unknown>;
    if (!rawOp) continue;

    const topTy = rawOp.ty as string;
    let partials: ParsedOp[];

    if (topTy === "mlti") {
      partials = flattenMultiOps(rawOp);
    } else {
      partials = flattenMultiOps(rawOp);
    }

    for (const p of partials) {
      parsedTypeCounts.set(p.type, (parsedTypeCounts.get(p.type) ?? 0) + 1);
      rawTyCounts.set(p.rawTy ?? "?", (rawTyCounts.get(p.rawTy ?? "?") ?? 0) + 1);
      allOps.push({ ...p, ts: entry[1], userId: entry[2], changelogIdx: i + 1 });

      if (p.type === "insert" || p.type === "insert_suggestion") {
        totalInsertChars += p.text?.length ?? 0;
      }
      if (p.type === "delete" || p.type === "delete_suggestion") {
        totalDeleteOps++;
      }
    }
  }

  console.log("\n=== Parsed types (after nm/mlti flattening) ===");
  for (const [ty, count] of [...parsedTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ty}: ${count}`);
  }

  console.log("\n=== Source breakdown (rawTy) ===");
  for (const [ty, count] of [...rawTyCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ty}: ${count}`);
  }

  console.log(`\n=== Content stats ===`);
  console.log(`  Total inserted characters: ${totalInsertChars}`);
  console.log(`  Total delete operations: ${totalDeleteOps}`);

  // Show first 15 insert operations
  console.log(`\n=== Sample inserts (first 15) ===`);
  const inserts = allOps.filter(o => o.type === "insert");
  for (const op of inserts.slice(0, 15)) {
    const preview = (op.text ?? "").slice(0, 100).replace(/\n/g, "\\n");
    console.log(`  [${op.changelogIdx}] pos=${op.startIndex} from=${op.rawTy} "${preview}"`);
  }

  // Show first 10 delete operations
  console.log(`\n=== Sample deletes (first 10) ===`);
  const deletes = allOps.filter(o => o.type === "delete");
  for (const op of deletes.slice(0, 10)) {
    console.log(`  [${op.changelogIdx}] range=${op.startIndex}-${op.endIndex} from=${op.rawTy}`);
  }

  // === REPLAY with diffs ===
  console.log(`\n=== Document state replay ===`);
  const docState: string[] = [];
  let opIdx = 0;
  let chunksWithContent = 0;
  let totalChunkInsertChars = 0;
  let totalChunkDeleteChars = 0;

  for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
    const tile = tiles[tileIdx];
    const chunkIns: Array<{ text: string; position: number }> = [];
    const chunkDel: Array<{ text: string; position: number }> = [];
    let chunkOpCount = 0;

    while (opIdx < allOps.length && allOps[opIdx].changelogIdx <= tile.end) {
      const op = allOps[opIdx];

      if (op.type === "insert" || op.type === "insert_suggestion") {
        const text = op.text ?? "";
        const pos = (op.startIndex ?? 1) - 1;
        if (text.length > 0) {
          chunkIns.push({ text, position: pos });
          docState.splice(pos, 0, ...text.split(""));
        }
        chunkOpCount++;
      } else if (op.type === "delete" || op.type === "delete_suggestion") {
        const si = (op.startIndex ?? 1) - 1;
        const ei = (op.endIndex ?? op.startIndex ?? 1) - 1;
        const count = ei - si + 1;
        if (count > 0 && si < docState.length) {
          const deletedText = docState.slice(si, si + count).join("");
          if (deletedText.length > 0) {
            chunkDel.push({ text: deletedText, position: si });
          }
          docState.splice(si, count);
        }
        chunkOpCount++;
      } else if (op.type === "replace" || op.type === "revert") {
        docState.length = 0;
        chunkOpCount++;
      } else {
        chunkOpCount++;
      }

      opIdx++;
    }

    if (chunkIns.length > 0 || chunkDel.length > 0) {
      chunksWithContent++;
      const insertChars = chunkIns.reduce((s, i) => s + i.text.length, 0);
      const deleteChars = chunkDel.reduce((s, d) => s + d.text.length, 0);
      totalChunkInsertChars += insertChars;
      totalChunkDeleteChars += deleteChars;

      if (chunksWithContent <= 8) {
        console.log(`\n--- Chunk ${tileIdx} (changelog ${tile.start}-${tile.end}, ${new Date(tile.endMillis).toISOString()}) ---`);
        console.log(`  +${insertChars} chars, -${deleteChars} chars`);
        for (const ins of chunkIns.slice(0, 3)) {
          const preview = ins.text.slice(0, 150).replace(/\n/g, "\\n");
          console.log(`  + "${preview}"${ins.text.length > 150 ? "..." : ""}`);
        }
        for (const del of chunkDel.slice(0, 3)) {
          const preview = del.text.slice(0, 150).replace(/\n/g, "\\n");
          console.log(`  - "${preview}"${del.text.length > 150 ? "..." : ""}`);
        }
      }
    }
  }

  console.log(`\n=== REPLAY SUMMARY ===`);
  console.log(`  Chunks with content: ${chunksWithContent} / ${tiles.length}`);
  console.log(`  Total inserted chars (in replay): ${totalChunkInsertChars}`);
  console.log(`  Total deleted chars (in replay): ${totalChunkDeleteChars}`);
  console.log(`  Final document length: ${docState.length} chars`);

  // Cross-verify: fetch actual doc content
  console.log("\nFetching actual document content for comparison...");
  const docRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}?includeTabsContent=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const docData = await docRes.json() as any;
  let actualText = "";
  for (const tab of (docData.tabs ?? [])) {
    const body = tab.documentTab?.body;
    if (body?.content) {
      for (const elem of body.content) {
        if (elem.paragraph?.elements) {
          for (const e of elem.paragraph.elements) {
            if (e.textRun?.content) actualText += e.textRun.content;
          }
        }
      }
    }
  }
  console.log(`  Actual doc text length: ${actualText.length} chars`);
  console.log(`  Replay doc length: ${docState.length} chars`);
  console.log(`  Match: ${docState.length === actualText.length ? "YES" : `NO (diff: ${Math.abs(docState.length - actualText.length)} chars)`}`);

  // Show first/last 100 chars of both
  const replayText = docState.join("");
  const replayFirst = replayText.slice(0, 100).replace(/\n/g, "\\n");
  const actualFirst = actualText.slice(0, 100).replace(/\n/g, "\\n");
  console.log(`  Replay first 100: "${replayFirst}"`);
  console.log(`  Actual first 100: "${actualFirst}"`);
}

test().catch(console.error);
