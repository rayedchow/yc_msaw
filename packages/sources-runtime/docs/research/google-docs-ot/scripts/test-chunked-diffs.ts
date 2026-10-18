import { buildChunkedDiffs } from "../src/polling/gdocs-revisions-load.js";

async function test() {
  // Find a doc to test with
  const { getGoogleAccessToken } = await import("../src/lib/google-auth.js");
  const token = await getGoogleAccessToken("default");

  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=5&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const filesData = (await filesRes.json()) as { files?: Array<{ id: string; name: string }> };

  if (!filesData.files?.length) {
    console.log("No docs found.");
    return;
  }

  // Pick the first doc with some history
  for (const file of filesData.files) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Testing: "${file.name}"`);
    console.log(`${"=".repeat(60)}`);

    const result = await buildChunkedDiffs("default", file.id);
    if (!result) {
      console.log("  No diffs available (empty doc or fetch failed)");
      continue;
    }

    console.log(`Tiles: ${result.tiles.length}`);
    console.log(`Chunks with changes: ${result.chunks.length}`);
    console.log(`Authors: ${[...result.userMap.entries()].map(([id, u]) => `${u.name} (${id})`).join(", ")}`);

    for (const chunk of result.chunks.slice(0, 5)) {
      console.log(`\n--- Chunk ${chunk.tileIndex} (ops ${chunk.startOp}-${chunk.endOp}, ${chunk.timestamp.toISOString()}) ---`);
      console.log(`  Authors: ${chunk.authors.map((a) => a.name).join(", ")}`);
      console.log(`  Operations: ${chunk.operationCount}`);
      console.log(`  Net change: ${chunk.netCharChange > 0 ? "+" : ""}${chunk.netCharChange} chars`);

      if (chunk.insertions.length > 0) {
        console.log(`  Insertions (${chunk.insertions.length}):`);
        for (const ins of chunk.insertions.slice(0, 3)) {
          const preview = ins.text.length > 100 ? ins.text.slice(0, 100) + "..." : ins.text;
          console.log(`    + "${preview}" (at pos ${ins.position})`);
        }
        if (chunk.insertions.length > 3) {
          console.log(`    ... and ${chunk.insertions.length - 3} more`);
        }
      }

      if (chunk.deletions.length > 0) {
        console.log(`  Deletions (${chunk.deletions.length}):`);
        for (const del of chunk.deletions.slice(0, 3)) {
          const preview = del.text.length > 100 ? del.text.slice(0, 100) + "..." : del.text;
          console.log(`    - "${preview}" (at pos ${del.position})`);
        }
        if (chunk.deletions.length > 3) {
          console.log(`    ... and ${chunk.deletions.length - 3} more`);
        }
      }
    }

    if (result.chunks.length > 5) {
      console.log(`\n... and ${result.chunks.length - 5} more chunks`);
    }

    break; // Just test one doc
  }
}

test().catch(console.error);
