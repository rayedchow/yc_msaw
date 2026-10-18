import { getGoogleAccessToken } from "../src/lib/google-auth.js";

function parseXssi(raw: string) {
  for (const skip of [4, 5]) {
    try { return JSON.parse(raw.slice(skip)); } catch {}
  }
  return null;
}

async function main() {
  const token = await getGoogleAccessToken("system");

  const r = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=50&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const files = ((await r.json()) as any).files;

  console.log("=== Scanning all docs for rplc/rvrt (version restore) ===\n");

  for (const file of files) {
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
        const op = entry[0];
        if (op.ty === "rplc" || op.ty === "rvrt") {
          const ts = new Date(entry[1]).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          });
          const snapshot = Array.isArray(op.snapshot) ? op.snapshot : [];
          const types = [...new Set(snapshot.filter((s: any) => s?.ty).map((s: any) => s.ty))];
          const textOps = snapshot.filter((s: any) => s?.ty === "is" || s?.ty === "nm").length;
          console.log(`${file.name.slice(0, 30).padEnd(30)} [${start + i}] ${ts} | ${op.ty} | ${snapshot.length} snapshot ops | text-bearing: ${textOps} | types: ${types.join(",")}`);
        }
      }

      if (cl.length < 1000) break;
      start = end + 1;
    }
  }

  // Also check: does undo (Cmd+Z) produce any special operation?
  // Answer: No. Undo just produces regular ds (delete what was inserted) or is (re-insert what was deleted).
  // There is no "undo" operation type in the OT protocol.
  // Let's verify by looking for rapid insert-then-delete-at-same-position patterns (undo signature)
  console.log("\n=== Checking Ishan LinkedIn Post for undo patterns (rapid insert→delete at same position) ===\n");

  const DID = (process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID");
  let undoPatterns = 0;
  let prevOps: Array<{ ty: string; pos: number; ts: number; text?: string }> = [];
  let start2 = 1;

  while (true) {
    const end = start2 + 999;
    const res = await fetch(
      `https://docs.google.com/document/d/${DID}/revisions/load?id=${DID}&start=${start2}&end=${end}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) { await res.text(); break; }
    const data = parseXssi(await res.text());
    if (!data) break;
    const cl = (data.changelog ?? []) as any[];

    for (const entry of cl) {
      if (!Array.isArray(entry) || !entry[0]) continue;
      let op = entry[0];
      const ts = entry[1] as number;

      // Unwrap nm
      if (op.ty === "nm" && op.nmc) op = op.nmc;

      if (op.ty === "is" && op.ibi && op.s) {
        prevOps.push({ ty: "is", pos: op.ibi, ts, text: op.s });
      } else if (op.ty === "ds" && op.si && op.ei) {
        // Check if this delete reverses a recent insert (within 5 seconds)
        for (const prev of prevOps) {
          if (prev.ty === "is" && prev.pos === op.si && ts - prev.ts < 5000 && ts - prev.ts > 100) {
            const deletedLen = op.ei - op.si + 1;
            const insertedLen = prev.text?.length ?? 0;
            if (deletedLen === insertedLen) {
              undoPatterns++;
              if (undoPatterns <= 5) {
                const tsFmt = new Date(ts).toLocaleTimeString("en-US");
                console.log(`  Undo pattern #${undoPatterns}: insert "${prev.text?.slice(0, 30)}" at pos ${prev.pos}, then delete same range ${(ts - prev.ts)}ms later at ${tsFmt}`);
              }
            }
          }
        }
        prevOps.push({ ty: "ds", pos: op.si, ts });
      }

      // Keep only last 20 ops for matching
      if (prevOps.length > 20) prevOps = prevOps.slice(-20);
    }

    if (cl.length < 1000) break;
    start2 = end + 1;
  }

  console.log(`\nTotal undo-like patterns found: ${undoPatterns}`);
  console.log("(Cmd+Z produces regular ds operations, NOT a special 'undo' type)");
}

main().catch(console.error);
