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
  if (ty === "mlti") {
    return ((raw.mts as any[]) ?? []).flatMap(s => flatten(s));
  }
  if (ty === "nm") {
    const nmc = raw.nmc as Record<string, unknown> | undefined;
    if (nmc) return flatten(nmc);
    return [{ type: "other" }];
  }
  const op = parseOp(raw);
  return op ? [op] : [{ type: "other" }];
}

async function test() {
  const token = await getGoogleAccessToken("default");
  const docId = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID");

  const tilesUrl = `https://docs.google.com/document/d/${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=true`;
  const tilesRes = await gFetch(tilesUrl, token);
  const tilesRaw = await tilesRes.text();
  let tilesData: any;
  try { tilesData = JSON.parse(tilesRaw.slice(4)); } catch { tilesData = JSON.parse(tilesRaw.slice(5)); }
  const tiles = tilesData.tileInfo as Array<{ start: number; end: number; endMillis: number; users: string[] }>;
  const userMap = tilesData.userMap as Record<string, { name: string }>;

  const loadUrl = `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=${tiles[tiles.length - 1].end}`;
  const res = await gFetch(loadUrl, token);
  const rawText = await res.text();
  const data = JSON.parse(rawText.slice(5));
  const changelog = data.changelog ?? [];

  // Build all ops
  type FullOp = ParsedOp & { changelogIdx: number };
  const allOps: FullOp[] = [];
  for (let i = 0; i < changelog.length; i++) {
    const entry = changelog[i];
    const rawOp = entry[0] as Record<string, unknown>;
    if (!rawOp) { allOps.push({ type: "other", changelogIdx: i + 1 }); continue; }
    const partials = flatten(rawOp);
    for (const p of partials) allOps.push({ ...p, changelogIdx: i + 1 });
  }

  // Replay and show LAST 10 chunks
  const docState: string[] = [];
  let opIdx = 0;
  const allChunks: Array<{
    tileIdx: number;
    tile: typeof tiles[0];
    insertions: Array<{ text: string; position: number }>;
    deletions: Array<{ text: string; position: number }>;
    opCount: number;
  }> = [];

  for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
    const tile = tiles[tileIdx];
    const ins: Array<{ text: string; position: number }> = [];
    const del: Array<{ text: string; position: number }> = [];
    let opCount = 0;

    while (opIdx < allOps.length && allOps[opIdx].changelogIdx <= tile.end) {
      const op = allOps[opIdx];
      if (op.type === "insert" || op.type === "insert_suggestion") {
        const text = op.text ?? "";
        const pos = (op.startIndex ?? 1) - 1;
        if (text.length > 0) {
          ins.push({ text, position: pos });
          docState.splice(pos, 0, ...text.split(""));
        }
        opCount++;
      } else if (op.type === "delete" || op.type === "delete_suggestion") {
        const si = (op.startIndex ?? 1) - 1;
        const ei = (op.endIndex ?? op.startIndex ?? 1) - 1;
        const count = ei - si + 1;
        if (count > 0 && si < docState.length) {
          const deletedText = docState.slice(si, si + count).join("");
          if (deletedText.length > 0) del.push({ text: deletedText, position: si });
          docState.splice(si, count);
        }
        opCount++;
      } else if (op.type === "replace" || op.type === "revert") {
        docState.length = 0;
        opCount++;
      } else {
        opCount++;
      }
      opIdx++;
    }

    allChunks.push({ tileIdx, tile, insertions: ins, deletions: del, opCount });
  }

  // Show last 10 chunks with content
  const withContent = allChunks.filter(c => c.insertions.length > 0 || c.deletions.length > 0);
  console.log(`Total chunks: ${allChunks.length}, with content: ${withContent.length}\n`);
  console.log(`=== LAST 10 CHUNKS WITH CONTENT ===\n`);

  for (const chunk of withContent.slice(-10)) {
    const t = chunk.tile;
    const authors = t.users.map(u => userMap[u]?.name ?? u).join(", ");
    const insertChars = chunk.insertions.reduce((s, i) => s + i.text.length, 0);
    const deleteChars = chunk.deletions.reduce((s, d) => s + d.text.length, 0);

    console.log(`--- Chunk ${chunk.tileIdx} (changelog ${t.start}-${t.end}) ---`);
    console.log(`  Time: ${new Date(t.endMillis).toISOString()}`);
    console.log(`  Authors: ${authors}`);
    console.log(`  Ops: ${chunk.opCount}, +${insertChars} chars, -${deleteChars} chars`);

    for (const ins of chunk.insertions) {
      const preview = ins.text.slice(0, 200).replace(/\n/g, "\\n");
      console.log(`  + "${preview}"${ins.text.length > 200 ? "..." : ""}`);
    }
    for (const del of chunk.deletions) {
      const preview = del.text.slice(0, 200).replace(/\n/g, "\\n");
      console.log(`  - "${preview}"${del.text.length > 200 ? "..." : ""}`);
    }
    console.log();
  }

  // Final doc state preview
  const finalText = docState.join("");
  console.log(`\n=== FINAL DOCUMENT STATE (last 300 chars) ===`);
  console.log(finalText.slice(-300));
}

test().catch(console.error);
