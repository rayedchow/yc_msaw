import { getGoogleAccessToken } from "../src/lib/google-auth.js";

const DID = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID");

function parseXssi(raw: string) {
  for (const skip of [4, 5]) {
    try { return JSON.parse(raw.slice(skip)); } catch {}
  }
  return null;
}

async function main() {
  const token = await getGoogleAccessToken("system");

  const tr = await fetch(
    `https://docs.google.com/document/d/${DID}/revisions/tiles?id=${DID}&start=1&showDetailedRevisions=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const td = parseXssi(await tr.text());
  const total = td.tileInfo[td.tileInfo.length - 1].end;
  console.log(`Total entries now: ${total}\n`);

  const start = Math.max(1, total - 49);
  const res = await fetch(
    `https://docs.google.com/document/d/${DID}/revisions/load?id=${DID}&start=${start}&end=${total}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = parseXssi(await res.text());
  const cl = (data?.changelog ?? []) as any[];

  console.log(`Last ${cl.length} entries (from ${start}):\n`);

  for (let i = 0; i < cl.length; i++) {
    const entry = cl[i];
    if (!Array.isArray(entry)) continue;
    const op = entry[0];
    const ts = new Date(entry[1]).toLocaleString("en-US", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const idx = start + i;

    if (!op || typeof op !== "object") {
      console.log(`[${idx}] ${ts} | ty=${op?.ty ?? "null"}`);
      continue;
    }

    const ty = op.ty as string;
    let detail = "";

    if (ty === "ac") detail = `CREATE TAB: ${JSON.stringify(op.d).slice(0, 100)}`;
    else if (ty === "dc") detail = `TAB CONFIG: ${JSON.stringify(op.d).slice(0, 100)}`;
    else if (ty === "mkch") detail = `TAB RENAME: ${JSON.stringify(op.d).slice(0, 100)}`;
    else if (ty === "mch") detail = `TAB REORDER: ${JSON.stringify(op.d).slice(0, 100)}`;
    else if (ty === "nm") {
      const nmr = (op.nmr ?? []) as string[];
      const tabId = nmr.find((r) => r.startsWith("t.")) ?? "";
      const inner = (op.nmc as any)?.ty ?? "?";
      if (inner === "is") detail = `INSERT on ${tabId}: "${((op.nmc as any)?.s ?? "").slice(0, 50)}"`;
      else if (inner === "ds") detail = `DELETE on ${tabId}: si=${(op.nmc as any)?.si} ei=${(op.nmc as any)?.ei}`;
      else detail = `${inner} on ${tabId}`;
    } else if (ty === "mlti") {
      const subs = ((op.mts ?? []) as any[]).map((s) => s.ty).join(",");
      detail = `MULTI[${subs}]`;
      for (const sub of (op.mts ?? []) as any[]) {
        if (sub.ty === "ac") detail += ` CREATE=${JSON.stringify(sub.d).slice(0, 80)}`;
        if (sub.ty === "dc") detail += ` CONFIG=${JSON.stringify(sub.d).slice(0, 80)}`;
        if (sub.ty === "mkch") detail += ` RENAME=${JSON.stringify(sub.d).slice(0, 80)}`;
        if (sub.ty === "mch") detail += ` REORDER=${JSON.stringify(sub.d).slice(0, 80)}`;
      }
    } else if (ty === "null") detail = "(no-op)";
    else detail = JSON.stringify(op).slice(0, 120);

    console.log(`[${idx}] ${ts} | ${(ty ?? "null").padEnd(5)} | ${detail}`);
  }
}

main().catch(console.error);
