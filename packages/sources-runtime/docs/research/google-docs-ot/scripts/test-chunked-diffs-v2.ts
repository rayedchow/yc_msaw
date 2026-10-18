import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");

  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=1&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const filesData = (await filesRes.json()) as { files?: Array<{ id: string; name: string }> };
  const doc = filesData.files![0];
  console.log(`Doc: "${doc.name}" (${doc.id})`);

  // Step 1: Get tiles to find the REAL last revision number
  const tilesUrl = `https://docs.google.com/document/d/${doc.id}/revisions/tiles?id=${doc.id}&start=1&showDetailedRevisions=true`;
  const tilesRes = await gFetch(tilesUrl, token);
  const tilesRaw = await tilesRes.text();
  const tilesData = JSON.parse(tilesRaw.slice(4));
  const lastTileEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;
  console.log(`Tiles say last revision: ${lastTileEnd}`);

  // Step 2: Get official API's last revision
  const revRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${doc.id}/revisions?fields=revisions(id)&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const revData = (await revRes.json()) as { revisions?: Array<{ id: string }> };
  const officialLastRev = revData.revisions?.[revData.revisions.length - 1]?.id ?? "1";
  console.log(`Official API last revision: ${officialLastRev}`);

  // Step 3: Fetch /revisions/load with the TILES end value
  const loadUrl = `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=${lastTileEnd}`;
  const loadRes = await gFetch(loadUrl, token);
  const loadRaw = await loadRes.text();

  let loadData: any;
  try { loadData = JSON.parse(loadRaw.slice(4)); } catch { loadData = JSON.parse(loadRaw.slice(5)); }

  const changelog = loadData.changelog ?? [];
  console.log(`Changelog entries with tiles end (${lastTileEnd}): ${changelog.length}`);

  // Step 4: Also try with official API's end value for comparison
  const loadUrl2 = `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=${officialLastRev}`;
  const loadRes2 = await gFetch(loadUrl2, token);
  const loadRaw2 = await loadRes2.text();
  let loadData2: any;
  try { loadData2 = JSON.parse(loadRaw2.slice(4)); } catch { loadData2 = JSON.parse(loadRaw2.slice(5)); }
  const changelog2 = loadData2.changelog ?? [];
  console.log(`Changelog entries with official end (${officialLastRev}): ${changelog2.length}`);

  // Show what the full changelog looks like
  if (changelog.length > 0) {
    const types = new Map<string, number>();
    for (const entry of changelog) {
      const ty = entry[0]?.ty ?? "unknown";
      types.set(ty, (types.get(ty) ?? 0) + 1);
    }
    console.log(`\nOperation types: ${JSON.stringify(Object.fromEntries(types))}`);
    console.log(`First op: ty=${changelog[0][0]?.ty} at ${new Date(changelog[0][1]).toISOString()}`);
    console.log(`Last op:  ty=${changelog[changelog.length-1][0]?.ty} at ${new Date(changelog[changelog.length-1][1]).toISOString()}`);
  }
}

test().catch(console.error);
