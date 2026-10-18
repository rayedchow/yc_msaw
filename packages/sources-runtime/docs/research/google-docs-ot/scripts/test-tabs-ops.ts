import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");

  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=10&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const files = ((await filesRes.json()) as any).files ?? [];

  for (const file of files) {
    const docRes = await fetch(
      `https://docs.googleapis.com/v1/documents/${file.id}?includeTabsContent=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const doc = (await docRes.json()) as any;
    const tabCount = doc.tabs?.length ?? 0;

    if (tabCount > 1) {
      console.log(`Multi-tab doc: "${file.name}" — ${tabCount} tabs`);
      for (const tab of doc.tabs) {
        console.log(`  Tab: "${tab.tabProperties.title}" (${tab.tabProperties.tabId})`);
      }

      // Fetch changelog
      const tilesRes = await gFetch(
        `https://docs.google.com/document/d/${file.id}/revisions/tiles?id=${file.id}&start=1&showDetailedRevisions=true`,
        token,
      );
      const tilesRaw = await tilesRes.text();
      const tilesData = JSON.parse(tilesRaw.slice(4));
      const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

      const loadRes = await gFetch(
        `https://docs.google.com/document/d/${file.id}/revisions/load?id=${file.id}&start=1&end=${lastEnd}`,
        token,
      );
      const loadRaw = await loadRes.text();
      const loadData = JSON.parse(loadRaw.slice(4));
      const changelog = loadData.changelog ?? [];

      console.log(`Changelog entries: ${changelog.length}`);

      // Dump ALL unique keys across all operations
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

      for (const entry of changelog.slice(0, 500)) {
        collectKeys(entry[0], "");
      }

      const tabRelated = [...allKeys].filter((k) =>
        k.toLowerCase().includes("tab") || k.includes("t_") || k.includes("tid"),
      );
      console.log(`Tab-related keys: ${tabRelated.length > 0 ? tabRelated.join(", ") : "NONE"}`);
      console.log(`All unique keys: ${[...allKeys].sort().join(", ")}`);
      return;
    }
  }

  console.log("No multi-tab docs found. Checking single-tab doc for tab fields anyway...");
  const docId = files[0].id;
  const tilesRes = await gFetch(
    `https://docs.google.com/document/d/${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=true`,
    token,
  );
  const tilesRaw = await tilesRes.text();
  const tilesData = JSON.parse(tilesRaw.slice(4));
  const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

  const loadRes = await gFetch(
    `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=${lastEnd}`,
    token,
  );
  const loadRaw = await loadRes.text();
  const loadData = JSON.parse(loadRaw.slice(4));
  const changelog = loadData.changelog ?? [];

  // Look for nm operations and dump their full structure
  let nmCount = 0;
  for (const entry of changelog) {
    const op = entry[0];
    if (op?.ty === "nm" && nmCount < 3) {
      console.log(`\nnm operation example (rev ${entry[3]}):`);
      console.log(JSON.stringify(op, null, 2).slice(0, 500));
      nmCount++;
    }
  }
}

test().catch(console.error);
