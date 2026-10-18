import { getGoogleAccessToken } from "../src/lib/google-auth.js";

function parseXssi(raw: string) {
  for (const skip of [4, 5]) {
    try { return JSON.parse(raw.slice(skip)); } catch {}
  }
  return null;
}

async function main() {
  const token = await getGoogleAccessToken("system");

  const listRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=50&orderBy=modifiedTime+desc&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const files = ((await listRes.json()) as any).files;

  console.log("Scanning all docs for tab operations (ac, dc, mkch, mch) with timestamps...\n");

  for (const file of files) {
    const tabOps: Array<{ idx: number; ty: string; ts: string; data: any }> = [];
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
          month: "short", day: "numeric", year: "numeric",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        });

        function scan(op: any) {
          if (!op || typeof op !== "object") return;
          const ty = op.ty;
          if (ty === "ac") tabOps.push({ idx, ty, ts, data: op.d });
          if (ty === "dc") tabOps.push({ idx, ty, ts, data: op.d });
          if (ty === "mkch") tabOps.push({ idx, ty, ts, data: op.d });
          if (ty === "mch") tabOps.push({ idx, ty, ts, data: op.d });
          if (ty === "mlti" && Array.isArray(op.mts)) for (const s of op.mts) scan(s);
        }
        scan(entry[0]);
      }

      if (cl.length < 1000) break;
      start = end + 1;
    }

    if (tabOps.length > 0) {
      console.log(`${file.name} (${tabOps.length} tab ops):`);
      for (const op of tabOps) {
        const dataStr = JSON.stringify(op.data).slice(0, 120);
        console.log(`  [${op.idx}] ${op.ts} | ${op.ty.padEnd(5)} | ${dataStr}`);
      }
      console.log();
    }
  }
}

main().catch(console.error);
