import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");

  // Find a doc with some history
  const filesRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=5&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const filesData = (await filesRes.json()) as { files?: Array<{ id: string; name: string }> };

  for (const file of filesData.files ?? []) {
    console.log(`\n=== Testing "${file.name}" (${file.id}) ===`);

    // Test /revisions/tiles WITHOUT the token parameter
    const tilesUrl = `https://docs.google.com/document/d/${file.id}/revisions/tiles?id=${file.id}&start=1&showDetailedRevisions=false`;
    const tilesRes = await gFetch(tilesUrl, token);
    console.log("tiles status:", tilesRes.status);

    if (tilesRes.ok) {
      const rawText = await tilesRes.text();
      console.log("Response size:", rawText.length, "bytes");
      console.log("Prefix:", JSON.stringify(rawText.slice(0, 10)));

      // Try stripping 4 chars (DocuViz2 does 4), then 5 (Harvard does 5)
      let data: any;
      try {
        data = JSON.parse(rawText.slice(4));
        console.log("Parsed with 4-char strip");
      } catch {
        try {
          data = JSON.parse(rawText.slice(5));
          console.log("Parsed with 5-char strip");
        } catch (e) {
          console.log("JSON parse failed both ways:", (e as Error).message);
          console.log("Raw sample:", rawText.slice(0, 200));
          continue;
        }
      }

      // Check tileInfo
      if (data.tileInfo) {
        console.log("tileInfo entries:", data.tileInfo.length);
        if (data.tileInfo.length > 0) {
          const first = data.tileInfo[0];
          const last = data.tileInfo[data.tileInfo.length - 1];
          console.log("First tile: start=" + first.start + " end=" + first.end + " endMillis=" + new Date(first.endMillis).toISOString() + " users=" + JSON.stringify(first.users));
          console.log("Last tile:  start=" + last.start + " end=" + last.end + " endMillis=" + new Date(last.endMillis).toISOString() + " users=" + JSON.stringify(last.users));
          console.log("Total revision range: 1 -", last.end);
        }
      } else {
        console.log("No tileInfo in response. Keys:", Object.keys(data));
      }

      // Check userMap
      if (data.userMap) {
        const users = Object.entries(data.userMap as Record<string, any>);
        console.log("userMap entries:", users.length);
        for (const [id, info] of users.slice(0, 3)) {
          console.log(`  ${id}: name="${(info as any).name}" anonymous=${(info as any).anonymous}`);
        }
      }

      // Also test with showDetailedRevisions=true
      const detailedUrl = `https://docs.google.com/document/d/${file.id}/revisions/tiles?id=${file.id}&start=1&showDetailedRevisions=true`;
      const detailedRes = await gFetch(detailedUrl, token);
      if (detailedRes.ok) {
        const detailedRaw = await detailedRes.text();
        let detailedData: any;
        try { detailedData = JSON.parse(detailedRaw.slice(4)); } catch { detailedData = JSON.parse(detailedRaw.slice(5)); }
        if (detailedData.tileInfo) {
          console.log("Detailed tiles:", detailedData.tileInfo.length, "(vs", data.tileInfo?.length ?? 0, "grouped)");
        }
      }

      console.log("\n✅ /revisions/tiles works with OAuth!");
      break; // Only need one successful test
    } else {
      const errText = await tilesRes.text();
      console.log("FAILED:", errText.slice(0, 200));
    }
  }
}

test().catch(console.error);
