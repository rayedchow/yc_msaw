import { getGoogleAccessToken } from "../src/lib/google-auth.js";
import { gFetch } from "../src/polling/gdocs-api.js";

async function test() {
  const token = await getGoogleAccessToken("default");
  const docId = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID"); // Ishan Linkedin Post

  // Fetch full changelog
  const loadUrl = `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=1&end=2352`;
  const res = await gFetch(loadUrl, token);
  const raw = await res.text();
  const data = JSON.parse(raw.slice(4));
  const changelog = data.changelog ?? [];

  console.log(`Total changelog entries: ${changelog.length}\n`);

  // Count ALL raw operation types (including inside mlti)
  const allTypes = new Map<string, number>();

  function countTypes(op: any) {
    if (!op || typeof op !== "object") return;
    const ty = op.ty as string ?? "null";
    allTypes.set(ty, (allTypes.get(ty) ?? 0) + 1);

    // Recurse into multi-operations
    if (ty === "mlti" && Array.isArray(op.mts)) {
      for (const sub of op.mts) countTypes(sub);
    }
    // Recurse into replace/revert snapshots
    if ((ty === "rplc" || ty === "rvrt") && Array.isArray(op.snapshot)) {
      for (const sub of op.snapshot) countTypes(sub);
    }
  }

  for (const entry of changelog) {
    countTypes(entry[0]);
  }

  console.log("ALL operation types (including nested):");
  const sorted = [...allTypes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ty, count] of sorted) {
    console.log(`  ${ty}: ${count}`);
  }

  // Show examples of each unknown type
  console.log("\n--- Examples of each type ---");
  const seen = new Set<string>();

  for (const entry of changelog) {
    const op = entry[0];
    if (!op) continue;
    const ty = op.ty as string;
    if (!seen.has(ty)) {
      seen.add(ty);
      // Show the operation structure (keys only, no huge values)
      const keys = Object.keys(op);
      const sample: Record<string, unknown> = {};
      for (const k of keys) {
        const v = op[k];
        if (typeof v === "string" && v.length > 50) {
          sample[k] = v.slice(0, 50) + "...";
        } else if (Array.isArray(v)) {
          sample[k] = `[Array(${v.length})]`;
        } else {
          sample[k] = v;
        }
      }
      console.log(`\n  ${ty}: ${JSON.stringify(sample)}`);
      console.log(`    timestamp: ${new Date(entry[1]).toISOString()}, user: ${entry[2]}, rev: ${entry[3]}`);
    }
  }

  // Show how many entries have text-affecting ops (is, ds, iss, dss) inside mlti
  let textOpsInMlti = 0;
  let textOpsTopLevel = 0;
  for (const entry of changelog) {
    const op = entry[0];
    if (!op) continue;
    const ty = op.ty;
    if (ty === "is" || ty === "ds" || ty === "iss" || ty === "dss") textOpsTopLevel++;
    if (ty === "mlti" && Array.isArray(op.mts)) {
      for (const sub of op.mts) {
        if (sub.ty === "is" || sub.ty === "ds" || sub.ty === "iss" || sub.ty === "dss") textOpsInMlti++;
      }
    }
  }
  console.log(`\nText-affecting operations: ${textOpsTopLevel} top-level, ${textOpsInMlti} inside mlti`);
}

test().catch(console.error);
