import "dotenv/config";
import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");
  // Company Brain has dc operations
  const docId = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID");

  const tilesUrl = `https://docs.google.com/document/d/${docId}/revisions/tiles?id=${docId}&start=1&showDetailedRevisions=true`;
  const tilesRes = await gFetch(tilesUrl, token);
  const tilesRaw = await tilesRes.text();
  let tilesData: any;
  try { tilesData = JSON.parse(tilesRaw.slice(4)); } catch { tilesData = JSON.parse(tilesRaw.slice(5)); }
  const lastEnd = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

  const loadUrl = `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=${lastEnd}`;
  const res = await gFetch(loadUrl, token);
  const rawText = await res.text();
  const data = JSON.parse(rawText.slice(5));
  const changelog = data.changelog ?? [];

  console.log(`Total entries: ${changelog.length}`);

  // Find dc operations
  let dcCount = 0;
  for (const entry of changelog) {
    const op = entry[0];
    if (op?.ty === "dc") {
      dcCount++;
      if (dcCount <= 5) {
        console.log(`\ndc operation #${dcCount} (rev ${entry[3]}, time ${new Date(entry[1]).toISOString()}):`);
        console.log(JSON.stringify(op, null, 2).slice(0, 800));
      }
    }
  }
  console.log(`\nTotal dc operations: ${dcCount}`);

  // Also look for any other unknown types
  const unknownTypes = new Set<string>();
  for (const entry of changelog) {
    const op = entry[0];
    if (!op) continue;
    const ty = op.ty as string;
    if (!["nm", "mlti", "is", "ds", "iss", "dss", "as", "msfd", "usfd", "sas",
          "ae", "de", "ue", "te", "rplc", "rvrt", "ac", "mch", "mkch", "ucp"].includes(ty)) {
      unknownTypes.add(ty);
    }
    // Check inside mlti
    if (ty === "mlti" && Array.isArray(op.mts)) {
      for (const sub of op.mts as any[]) {
        const subTy = sub?.ty as string;
        if (subTy && !["nm", "mlti", "is", "ds", "iss", "dss", "as", "msfd", "usfd", "sas",
              "ae", "de", "ue", "te", "rplc", "rvrt", "ac", "mch", "mkch", "ucp", "dc"].includes(subTy)) {
          unknownTypes.add(`mlti>${subTy}`);
        }
      }
    }
  }
  console.log(`\nUnknown types found: ${[...unknownTypes].join(", ") || "NONE"}`);
}

test().catch(console.error);
