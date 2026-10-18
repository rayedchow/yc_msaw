import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

interface ParsedOp {
  type: string;
  text?: string;
  startIndex?: number;
  endIndex?: number;
}

function parseOperation(raw: Record<string, unknown> | null | undefined): ParsedOp | null {
  if (!raw || typeof raw !== "object") return null;
  const ty = raw.ty as string | undefined;
  switch (ty) {
    case "is":
      return { type: "insert", text: raw.s as string, startIndex: raw.ibi as number };
    case "ds":
      return { type: "delete", startIndex: raw.si as number, endIndex: raw.ei as number };
    case "iss":
      return { type: "insert_suggestion", text: raw.s as string, startIndex: raw.ibi as number };
    case "dss":
      return { type: "delete_suggestion", startIndex: raw.si as number, endIndex: raw.ei as number };
    case "as":
      return { type: "format", startIndex: raw.si as number, endIndex: raw.ei as number };
    case "nm": {
      const nmc = raw.nmc as Record<string, unknown> | undefined;
      if (nmc && typeof nmc === "object") {
        const inner = parseOperation(nmc);
        if (inner) return inner;
      }
      return { type: "other" };
    }
    case "mlti":
      return { type: "multi" };
    case "rplc":
      return { type: "replace" };
    case "rvrt":
      return { type: "revert" };
    case "ae": case "de": case "ue": case "te": case "sas":
    case "ac": case "mch": case "mkch": case "ucp": case "msfd": case "usfd":
      return { type: "other" };
    default:
      return null;
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
    return [{ type: "other" }];
  }
  const op = parseOperation(raw);
  return op ? [op] : [];
}

async function test() {
  const token = await getGoogleAccessToken("default");
  const docId = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID"); // Ishan Linkedin Post

  // Fetch tiles to get the last revision
  const tilesUrl = `https://docs.google.com/document/d/${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=true`;
  const tilesRes = await gFetch(tilesUrl, token);
  const tilesRaw = await tilesRes.text();
  let tilesData: any;
  try {
    tilesData = JSON.parse(tilesRaw.slice(4));
  } catch {
    tilesData = JSON.parse(tilesRaw.slice(5));
  }
  const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

  // Fetch full changelog
  const loadUrl = `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=${lastEnd}`;
  const res = await gFetch(loadUrl, token);
  const raw = await res.text();
  const data = JSON.parse(raw.slice(5));
  const changelog = data.changelog ?? [];

  console.log(`Total changelog entries: ${changelog.length}\n`);

  // Parse all operations with nm support
  const typeCounts = new Map<string, number>();
  let totalInsertChars = 0;
  let totalDeleteOps = 0;
  let nmWithTextOps = 0;
  let nmWithoutTextOps = 0;

  const allOps: Array<ParsedOp & { ts: number; userId: string; rev: number; changelogIdx: number }> = [];

  for (let i = 0; i < changelog.length; i++) {
    const entry = changelog[i];
    const rawOp = entry[0] as Record<string, unknown>;
    const ts = entry[1] as number;
    const userId = entry[2] as string;
    const rev = entry[3] as number;

    if (!rawOp) continue;

    const topTy = rawOp.ty as string;

    let partials: ParsedOp[];
    if (topTy === "mlti") {
      partials = flattenMultiOps(rawOp);
    } else if (topTy === "nm") {
      partials = flattenMultiOps(rawOp);
      if (partials.length > 0 && partials[0].type !== "other") {
        nmWithTextOps++;
      } else {
        nmWithoutTextOps++;
      }
    } else {
      const parsed = parseOperation(rawOp);
      partials = parsed ? [parsed] : [{ type: "other" }];
    }

    for (const p of partials) {
      typeCounts.set(p.type, (typeCounts.get(p.type) ?? 0) + 1);
      allOps.push({ ...p, ts, userId, rev, changelogIdx: i + 1 });

      if (p.type === "insert" || p.type === "insert_suggestion") {
        totalInsertChars += p.text?.length ?? 0;
      }
      if (p.type === "delete" || p.type === "delete_suggestion") {
        totalDeleteOps++;
      }
    }
  }

  console.log("=== Parsed operation types (after nm extraction) ===");
  const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ty, count] of sorted) {
    console.log(`  ${ty}: ${count}`);
  }

  console.log(`\n=== nm breakdown ===`);
  console.log(`  nm with text ops (is/ds/iss/dss inside nmc): ${nmWithTextOps}`);
  console.log(`  nm without text ops (format/other inside nmc): ${nmWithoutTextOps}`);

  console.log(`\n=== Content stats ===`);
  console.log(`  Total inserted characters: ${totalInsertChars}`);
  console.log(`  Total delete operations: ${totalDeleteOps}`);

  // Show first 10 insert operations from nm
  console.log(`\n=== Sample insert operations (first 10) ===`);
  const inserts = allOps.filter(o => o.type === "insert");
  for (const op of inserts.slice(0, 10)) {
    const preview = (op.text ?? "").slice(0, 80).replace(/\n/g, "\\n");
    console.log(`  [${op.changelogIdx}] pos=${op.startIndex} "${preview}"`);
  }

  // Now do the replay
  console.log(`\n=== Document state replay ===`);
  const tiles = tilesData.tileInfo as Array<{ start: number; end: number; endMillis: number; users: string[] }>;
  const docState: string[] = [];

  let opIdx = 0;
  let chunksWithContent = 0;
  let totalChunkInserts = 0;
  let totalChunkDeletes = 0;

  for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
    const tile = tiles[tileIdx];
    const chunkInsertions: Array<{ text: string; position: number }> = [];
    const chunkDeletions: Array<{ text: string; position: number }> = [];
    let chunkOpCount = 0;

    while (opIdx < allOps.length && allOps[opIdx].changelogIdx <= tile.end) {
      const op = allOps[opIdx];

      if (op.type === "insert" || op.type === "insert_suggestion") {
        const text = op.text ?? "";
        const pos = (op.startIndex ?? 1) - 1;
        if (text.length > 0) {
          chunkInsertions.push({ text, position: pos });
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
            chunkDeletions.push({ text: deletedText, position: si });
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

    if (chunkInsertions.length > 0 || chunkDeletions.length > 0) {
      chunksWithContent++;
      totalChunkInserts += chunkInsertions.length;
      totalChunkDeletes += chunkDeletions.length;

      if (chunksWithContent <= 5) {
        const insertChars = chunkInsertions.reduce((s, i) => s + i.text.length, 0);
        const deleteChars = chunkDeletions.reduce((s, d) => s + d.text.length, 0);
        console.log(`\n--- Chunk ${tileIdx} (ops ${tile.start}-${tile.end}) ---`);
        console.log(`  +${insertChars} chars, -${deleteChars} chars`);
        for (const ins of chunkInsertions.slice(0, 3)) {
          const preview = ins.text.slice(0, 120).replace(/\n/g, "\\n");
          console.log(`  + "${preview}"`);
        }
        for (const del of chunkDeletions.slice(0, 3)) {
          const preview = del.text.slice(0, 120).replace(/\n/g, "\\n");
          console.log(`  - "${preview}"`);
        }
      }
    }
  }

  console.log(`\n=== Replay summary ===`);
  console.log(`  Chunks with content: ${chunksWithContent} / ${tiles.length}`);
  console.log(`  Total insert groups: ${totalChunkInserts}`);
  console.log(`  Total delete groups: ${totalChunkDeletes}`);
  console.log(`  Final doc length: ${docState.length} chars`);
}

test().catch(console.error);
