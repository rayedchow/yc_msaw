import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";
import { fetchRevisionTiles, fetchDocChangelog, replayWithDiffs } from "../src/polling/gdocs-revisions-load.js";

async function test() {
  const token = await getGoogleAccessToken("default");

  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=1&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const doc = ((await filesRes.json()) as any).files[0];
  console.log(`Doc: "${doc.name}"`);

  const changelog = await fetchDocChangelog("default", doc.id);
  const tilesResult = await fetchRevisionTiles("default", doc.id, true);

  if (!changelog || !tilesResult) {
    console.log("Failed to fetch data");
    return;
  }

  console.log(`Operations: ${changelog.operations.length}`);
  console.log(`Tiles: ${tilesResult.tiles.length}`);

  // Show operation type distribution
  const types = new Map<string, number>();
  for (const op of changelog.operations) {
    types.set(op.type, (types.get(op.type) ?? 0) + 1);
  }
  console.log(`Operation types after parsing:`, Object.fromEntries(types));

  // Show revision ID distribution
  const revIds = new Set(changelog.operations.map(o => o.revisionId));
  console.log(`Unique revision IDs in operations: ${revIds.size}`);
  console.log(`Revision ID range: ${Math.min(...revIds)} - ${Math.max(...revIds)}`);

  // Show tile boundaries
  console.log(`\nFirst 5 tiles:`);
  for (const tile of tilesResult.tiles.slice(0, 5)) {
    console.log(`  Tile: ops ${tile.start}-${tile.end}, ${new Date(tile.endMillis).toISOString()}, users: ${tile.users.join(", ")}`);

    // Count how many operations fall in this tile range
    const opsInTile = changelog.operations.filter(o => o.revisionId >= tile.start && o.revisionId <= tile.end);
    console.log(`    -> ${opsInTile.length} parsed operations in range`);
    if (opsInTile.length > 0) {
      const subTypes = new Map<string, number>();
      for (const o of opsInTile) subTypes.set(o.type, (subTypes.get(o.type) ?? 0) + 1);
      console.log(`    -> types: ${JSON.stringify(Object.fromEntries(subTypes))}`);
    }
  }

  // Now run the replay
  console.log(`\nRunning replay...`);
  const chunks = replayWithDiffs(changelog.operations, tilesResult.tiles, tilesResult.userMap);
  console.log(`Chunks with diffs: ${chunks.length}`);

  for (const chunk of chunks.slice(0, 5)) {
    console.log(`\n--- Chunk ${chunk.tileIndex} (ops ${chunk.startOp}-${chunk.endOp}) ---`);
    console.log(`  Authors: ${chunk.authors.map(a => a.name).join(", ")}`);
    console.log(`  Ops: ${chunk.operationCount}, Net: ${chunk.netCharChange > 0 ? "+" : ""}${chunk.netCharChange} chars`);
    for (const ins of chunk.insertions.slice(0, 2)) {
      const preview = ins.text.length > 120 ? ins.text.slice(0, 120) + "..." : ins.text;
      console.log(`  + "${preview}"`);
    }
    for (const del of chunk.deletions.slice(0, 2)) {
      const preview = del.text.length > 120 ? del.text.slice(0, 120) + "..." : del.text;
      console.log(`  - "${preview}"`);
    }
  }
}

test().catch(console.error);
