import "dotenv/config";
import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");

  // 1. Find multi-tab docs
  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=20&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const files = ((await filesRes.json()) as any).files ?? [];
  console.log(`Checking ${files.length} docs for tabs...\n`);

  for (const file of files) {
    const docRes = await fetch(
      `https://docs.googleapis.com/v1/documents/${file.id}?includeTabsContent=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const doc = (await docRes.json()) as any;
    const tabCount = doc.tabs?.length ?? 0;

    if (tabCount > 1) {
      console.log(`\n=== MULTI-TAB DOC: "${file.name}" (${file.id}) — ${tabCount} tabs ===`);
      for (const tab of doc.tabs) {
        const props = tab.tabProperties;
        console.log(`  Tab: "${props.title}" (tabId=${props.tabId}, index=${props.index})`);
      }

      // Fetch changelog
      const tilesUrl = `https://docs.google.com/document/d/${file.id}/revisions/tiles?id=${file.id}&start=1&showDetailedRevisions=true`;
      const tilesRes = await gFetch(tilesUrl, token);
      const tilesRaw = await tilesRes.text();
      let tilesData: any;
      try { tilesData = JSON.parse(tilesRaw.slice(4)); } catch { tilesData = JSON.parse(tilesRaw.slice(5)); }
      const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

      const loadUrl = `https://docs.google.com/document/d/${file.id}/revisions/load?id=${file.id}&start=1&end=${lastEnd}`;
      const loadRes = await gFetch(loadUrl, token);
      const loadRaw = await loadRes.text();
      const loadData = JSON.parse(loadRaw.slice(5));
      const changelog = loadData.changelog ?? [];

      console.log(`\n  Changelog entries: ${changelog.length}`);

      // Collect ALL unique keys recursively
      const allKeys = new Set<string>();
      function collectKeys(obj: any, prefix: string) {
        if (!obj || typeof obj !== "object") return;
        for (const key of Object.keys(obj)) {
          allKeys.add(prefix + key);
          if (typeof obj[key] === "object" && !Array.isArray(obj[key]) && obj[key] !== null) {
            collectKeys(obj[key], prefix + key + ".");
          }
        }
      }

      // Check for tab-related fields in operations
      const tabFields = new Set<string>();
      for (const entry of changelog) {
        const op = entry[0];
        if (!op) continue;

        collectKeys(op, "");

        // Deep search for any field containing "tab" in its name or value
        function searchForTab(obj: any, path: string) {
          if (!obj || typeof obj !== "object") return;
          for (const [key, val] of Object.entries(obj)) {
            const fullPath = path ? `${path}.${key}` : key;
            if (key.toLowerCase().includes("tab") || key.includes("tid") || key.includes("t_")) {
              tabFields.add(`${fullPath}=${JSON.stringify(val).slice(0, 100)}`);
            }
            if (typeof val === "object" && val !== null) {
              searchForTab(val, fullPath);
            }
          }
        }
        searchForTab(op, "");
      }

      console.log(`\n  Tab-related fields found: ${tabFields.size}`);
      for (const f of [...tabFields].slice(0, 20)) {
        console.log(`    ${f}`);
      }

      // Also check if there are tab IDs in the changelog metadata
      console.log(`\n  Checking changelog structure for tab fields...`);
      if (changelog.length > 0) {
        const entry = changelog[0];
        console.log(`  Entry tuple length: ${entry.length}`);
        console.log(`  Entry structure: [op, ts, userId, revId, sessionId, ...rest]`);
        if (entry.length > 5) {
          for (let i = 5; i < entry.length; i++) {
            console.log(`  entry[${i}]: ${JSON.stringify(entry[i]).slice(0, 200)}`);
          }
        }
      }

      // Check tiles for tab fields
      console.log(`\n  Checking tiles for tab fields...`);
      const tileKeys = new Set<string>();
      for (const tile of tilesData.tileInfo) {
        collectKeys(tile, "tile.");
      }
      const tileTabs = [...allKeys].filter(k => k.startsWith("tile.") && (k.toLowerCase().includes("tab") || k.includes("tid")));
      console.log(`  Tab fields in tiles: ${tileTabs.length > 0 ? tileTabs.join(", ") : "NONE"}`);

      // Check top-level response keys
      console.log(`\n  Top-level /revisions/load response keys: ${Object.keys(loadData).join(", ")}`);
      console.log(`  Top-level /revisions/tiles response keys: ${Object.keys(tilesData).join(", ")}`);

      // Check nm operations specifically for tab info
      let nmCount = 0;
      const nmrValues = new Set<string>();
      for (const entry of changelog) {
        const op = entry[0];
        if (op?.ty === "nm") {
          nmCount++;
          const nmr = op.nmr;
          if (Array.isArray(nmr)) {
            for (const range of nmr) {
              if (typeof range === "string") nmrValues.add(range);
              else if (typeof range === "object") nmrValues.add(JSON.stringify(range).slice(0, 100));
            }
          }
        }
      }
      console.log(`\n  nm operations: ${nmCount}`);
      console.log(`  Unique nmr values (named range IDs): ${nmrValues.size}`);
      for (const v of [...nmrValues].slice(0, 10)) {
        console.log(`    nmr: ${v}`);
      }

      console.log("\n  === DONE with multi-tab doc ===\n");
      return;
    }
  }

  console.log("\nNo multi-tab docs found in the 20 most recent docs.");
  console.log("Checking single-tab doc for tab fields anyway...");

  const docId = files[0].id;
  console.log(`\nUsing: "${files[0].name}" (${docId})`);

  const tilesUrl = `https://docs.google.com/document/d/${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=true`;
  const tilesRes = await gFetch(tilesUrl, token);
  const tilesRaw = await tilesRes.text();
  let tilesData: any;
  try { tilesData = JSON.parse(tilesRaw.slice(4)); } catch { tilesData = JSON.parse(tilesRaw.slice(5)); }
  const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

  const loadUrl = `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=${lastEnd}`;
  const loadRes = await gFetch(loadUrl, token);
  const loadRaw = await loadRes.text();
  const loadData = JSON.parse(loadRaw.slice(5));
  const changelog = loadData.changelog ?? [];

  console.log(`Changelog entries: ${changelog.length}`);

  // Look at nm operations and their nmr field
  let nmCount = 0;
  const nmrValues = new Set<string>();
  for (const entry of changelog) {
    const op = entry[0];
    if (op?.ty === "nm") {
      nmCount++;
      const nmr = op.nmr;
      if (Array.isArray(nmr)) {
        for (const range of nmr) {
          if (typeof range === "string") nmrValues.add(range);
          else nmrValues.add(JSON.stringify(range).slice(0, 150));
        }
      }
    }
  }
  console.log(`nm operations: ${nmCount}`);
  console.log(`Unique nmr values: ${nmrValues.size}`);
  for (const v of [...nmrValues].slice(0, 15)) {
    console.log(`  nmr: ${v}`);
  }

  // Check top-level keys
  console.log(`\nTop-level /revisions/load keys: ${Object.keys(loadData).join(", ")}`);
  console.log(`Top-level /revisions/tiles keys: ${Object.keys(tilesData).join(", ")}`);

  // Show example nm operation with full structure
  for (const entry of changelog) {
    const op = entry[0];
    if (op?.ty === "nm") {
      console.log(`\nExample nm operation (full):`);
      console.log(JSON.stringify(op, null, 2).slice(0, 500));
      break;
    }
  }
}

test().catch(console.error);
