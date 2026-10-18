import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { humanizeStyleChanges, summarizeStyleChanges } from "../src/polling/gdocs-style-humanizer.js";

function parseXssi(raw: string) {
  for (const skip of [4, 5]) {
    try { return JSON.parse(raw.slice(skip)); } catch {}
  }
  return null;
}

async function main() {
  const token = await getGoogleAccessToken("system");
  const DID = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID");

  // Get tiles
  const tilesRes = await fetch(
    `https://docs.google.com/document/d/${DID}/revisions/tiles?id=${DID}&start=1&showDetailedRevisions=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const tilesData = parseXssi(await tilesRes.text());
  const tiles = tilesData.tileInfo;
  const total = tiles[tiles.length - 1].end;

  // Fetch all entries
  const allEntries: any[] = [];
  let start = 1;
  while (start <= total) {
    const end = Math.min(start + 999, total);
    const res = await fetch(
      `https://docs.google.com/document/d/${DID}/revisions/load?id=${DID}&start=${start}&end=${end}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = parseXssi(await res.text());
    allEntries.push(...(data?.changelog ?? []));
    if ((data?.changelog?.length ?? 0) < 1000) break;
    start = end + 1;
  }

  // Replay to get document state for text context on format ops
  const docState: string[] = [];

  function apply(op: any) {
    if (!op || typeof op !== "object") return;
    if (op.ty === "nm" && op.nmc) apply(op.nmc);
    else if (op.ty === "mlti" && Array.isArray(op.mts)) for (const s of op.mts) apply(s);
    else if (op.ty === "rplc" || op.ty === "rvrt") {
      docState.length = 0;
      if (Array.isArray(op.snapshot)) for (const s of op.snapshot) apply(s);
    } else if ((op.ty === "is" || op.ty === "iss") && op.s) {
      docState.splice((op.ibi ?? 1) - 1, 0, ...op.s.split(""));
    } else if ((op.ty === "ds" || op.ty === "dss") && op.si != null) {
      const c = (op.ei ?? op.si) - op.si + 1;
      if (c > 0 && op.si - 1 < docState.length) docState.splice(op.si - 1, c);
    }
  }

  // Group last 10 tiles into sessions (2-min gap = new session)
  const lastTiles = tiles.slice(-10);
  const cutoff = lastTiles[0].start - 1;

  // Replay up to cutoff
  for (let i = 0; i < Math.min(cutoff, allEntries.length); i++) {
    const e = allEntries[i];
    if (Array.isArray(e) && e[0]) apply(e[0]);
  }

  // For each of the last 10 tiles, build what the LLM would see
  console.log("=== Token estimates for last 10 chunks of Ishan LinkedIn Post ===\n");

  let totalTokens = 0;

  for (const tile of lastTiles) {
    const ts = new Date(tile.endMillis).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });

    const sessionData: string[] = [];
    let inserts: string[] = [];
    let deletes: string[] = [];
    let formatDescs: string[] = [];

    for (let idx = tile.start - 1; idx < Math.min(tile.end, allEntries.length); idx++) {
      const entry = allEntries[idx];
      if (!Array.isArray(entry) || !entry[0]) continue;

      function collect(op: any) {
        if (!op || typeof op !== "object") return;
        if (op.ty === "nm") {
          if (op.nmc) collect(op.nmc);
          return;
        }
        if (op.ty === "mlti" && Array.isArray(op.mts)) {
          for (const s of op.mts) collect(s);
          return;
        }
        if ((op.ty === "is" || op.ty === "iss") && op.s) {
          inserts.push(op.s);
        }
        if ((op.ty === "ds" || op.ty === "dss") && op.si != null) {
          const si = op.si;
          const ei = op.ei ?? op.si;
          const c = ei - si + 1;
          if (c > 0 && si - 1 < docState.length) {
            deletes.push(docState.slice(si - 1, si - 1 + c).join(""));
          }
        }
        if ((op.ty === "as" || op.ty === "sas" || op.ty === "astss") && op.sm) {
          // Get affected text from current doc state
          const si = op.si as number | undefined;
          const ei = op.ei as number | undefined;
          let affectedText = "";
          if (si && ei && si - 1 < docState.length) {
            affectedText = docState.slice(si - 1, Math.min(ei, docState.length)).join("");
            if (affectedText.length > 50) affectedText = affectedText.slice(0, 50) + "...";
          }
          const changes = humanizeStyleChanges(op.sm);
          const summary = summarizeStyleChanges(changes);
          if (summary) {
            formatDescs.push(affectedText ? `${summary} on "${affectedText}"` : summary);
          }
        }
      }
      collect(entry[0]);
      apply(entry[0]);
    }

    const insertedText = inserts.join("");
    const deletedText = deletes.join("");

    // Build what the LLM would see for this chunk
    const llmInput: string[] = [];
    llmInput.push(`Chunk ${tile.start}-${tile.end} | ${ts}`);
    if (insertedText) llmInput.push(`Added (${insertedText.length} chars): "${insertedText.slice(0, 200)}${insertedText.length > 200 ? '...' : ''}"`);
    if (deletedText) llmInput.push(`Removed (${deletedText.length} chars): "${deletedText.slice(0, 200)}${deletedText.length > 200 ? '...' : ''}"`);
    if (formatDescs.length > 0) llmInput.push(`Format changes:\n  ${formatDescs.slice(0, 5).join("\n  ")}${formatDescs.length > 5 ? `\n  ...and ${formatDescs.length - 5} more` : ''}`);

    const text = llmInput.join("\n");
    // Rough token estimate: ~4 chars per token for English
    const tokens = Math.ceil(text.length / 4);
    totalTokens += tokens;

    console.log(text);
    console.log(`  → ~${tokens} tokens\n`);
  }

  console.log(`\n=== TOTAL: ~${totalTokens} tokens for last 10 chunks ===`);
  console.log(`(This is what the LLM would see for one session's worth of data)`);
}

main().catch(console.error);
