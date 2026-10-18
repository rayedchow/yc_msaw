import { getGoogleAccessToken } from "../src/lib/google-auth.js";

function parseXssi(raw: string) {
  for (const skip of [4, 5]) {
    try { return JSON.parse(raw.slice(skip)); } catch {}
  }
  return null;
}

async function main() {
  const token = await getGoogleAccessToken("system");

  // Get all docs
  const listRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=50&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const files = ((await listRes.json()) as any).files;

  // Check each doc for subtabs via the official Docs API
  console.log("=== Checking docs for subtabs via Docs API ===\n");

  for (const file of files) {
    const res = await fetch(
      `https://docs.googleapis.com/v1/documents/${file.id}?fields=tabs(tabProperties,childTabs)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) { await res.text(); continue; }
    const data = (await res.json()) as any;
    const tabs = data.tabs ?? [];

    let hasChildren = false;
    function printTab(tab: any, depth: number) {
      const props = tab.tabProperties ?? {};
      const indent = "  ".repeat(depth);
      const children = tab.childTabs ?? [];
      if (children.length > 0) hasChildren = true;
      console.log(`${indent}${props.title ?? "(untitled)"} (id=${props.tabId}, index=${props.index})${children.length > 0 ? ` [${children.length} children]` : ""}`);
      for (const child of children) printTab(child, depth + 1);
    }

    if (tabs.some((t: any) => (t.childTabs ?? []).length > 0)) {
      console.log(`${file.name} — HAS SUBTABS:`);
      for (const tab of tabs) printTab(tab, 1);
      console.log();
    }
  }

  // Now check OT log for nested position arrays in mch/ac/dc ops
  console.log("\n=== Checking OT logs for nested position arrays ===\n");

  for (const file of files) {
    const nestedOps: Array<{ idx: number; ty: string; ts: string; data: any; depth: number }> = [];
    let start = 1;

    while (true) {
      const end = start + 999;
      const res = await fetch(
        `https://docs.google.com/document/d/${file.id}/revisions/load?id=${file.id}&start=${start}&end=${end}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) { await res.text(); break; }
      const data = parseXssi(await res.text());
      if (!data) break;
      const cl = (data.changelog ?? []) as any[];

      for (let i = 0; i < cl.length; i++) {
        const entry = cl[i];
        if (!Array.isArray(entry) || !entry[0]) continue;
        const idx = start + i;
        const ts = new Date(entry[1]).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });

        function scan(op: any) {
          if (!op || typeof op !== "object") return;
          const ty = op.ty;
          if ((ty === "mch" || ty === "ac" || ty === "dc") && Array.isArray(op.d)) {
            // Check for nested arrays (depth > 1) in position fields
            for (const elem of op.d) {
              if (Array.isArray(elem) && elem.some((e: any) => Array.isArray(e) || (typeof e === "number" && elem.length > 2))) {
                nestedOps.push({ idx, ty, ts, data: op.d, depth: elem.length });
              }
              // Also check for position arrays with length > 1 (subtab positions)
              if (Array.isArray(elem) && elem.length > 1 && elem.every((e: any) => typeof e === "number")) {
                nestedOps.push({ idx, ty, ts, data: op.d, depth: elem.length });
              }
            }
          }
          if (ty === "mlti" && Array.isArray(op.mts)) for (const s of op.mts) scan(s);
        }
        scan(entry[0]);
      }

      if (cl.length < 1000) break;
      start = end + 1;
    }

    if (nestedOps.length > 0) {
      console.log(`${file.name} — ${nestedOps.length} ops with nested positions:`);
      // Show first 10
      for (const op of nestedOps.slice(0, 10)) {
        console.log(`  [${op.idx}] ${op.ts} | ${op.ty.padEnd(5)} | ${JSON.stringify(op.data).slice(0, 100)}`);
      }
      if (nestedOps.length > 10) console.log(`  ... and ${nestedOps.length - 10} more`);
      console.log();
    }
  }
}

main().catch(console.error);
