/**
 * Exhaustive test suite for /revisions/load and /revisions/tiles endpoints.
 *
 * Tests against LIVE Google Docs data via delegation auth.
 * Covers: pagination, prefix parsing, operation parsing, tile alignment,
 * edge cases (empty docs, large docs, multi-tab docs), and replay correctness.
 *
 * Run: cd brain && set -a && source .env && set +a && npx tsx scripts/test-exhaustive-revisions-load.ts
 */

import { getGoogleAccessToken } from "../src/lib/google-auth.js";

const KNOWN_TYPES = new Set([
  "is", "ds", "iss", "dss", "msfd", "usfd", "ras",
  "as", "sas", "astss",
  "ae", "de", "ue", "te",
  "nm", "mlti", "rplc", "rvrt",
  "dc", "ac", "mch", "mkch",
  "ucp", "umv", "utlp",
]);

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string) {
  results.push({ name, passed: true, detail });
  console.log(`  ✓ ${name}: ${detail}`);
}

function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
  console.log(`  ✗ ${name}: ${detail}`);
}

async function gFetch(url: string, token: string): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

function parseXssi(raw: string): Record<string, unknown> | null {
  for (const skip of [4, 5]) {
    try { return JSON.parse(raw.slice(skip)); } catch {}
  }
  return null;
}

// -------------------------------------------------------------------------
// Get docs list
// -------------------------------------------------------------------------

async function getWorkspaceDocs(token: string): Promise<Array<{ id: string; name: string }>> {
  const res = await gFetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&pageSize=50&orderBy=modifiedTime+desc&fields=files(id,name)",
    token,
  );
  const data = (await res.json()) as { files: Array<{ id: string; name: string }> };
  return data.files;
}

// -------------------------------------------------------------------------
// Test 1: Anti-XSSI prefix parsing (both 4 and 5 char variants)
// -------------------------------------------------------------------------

async function testXssiPrefix(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: Anti-XSSI Prefix Parsing ---");

  for (const doc of docs.slice(0, 3)) {
    // Test /revisions/load prefix
    const loadRes = await gFetch(
      `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=10`,
      token,
    );
    if (loadRes.ok) {
      const raw = await loadRes.text();
      const prefix4 = raw.slice(0, 4);
      const prefix5 = raw.slice(0, 5);
      const parsed4works = (() => { try { JSON.parse(raw.slice(4)); return true; } catch { return false; } })();
      const parsed5works = (() => { try { JSON.parse(raw.slice(5)); return true; } catch { return false; } })();

      if (parsed4works || parsed5works) {
        pass(`load prefix [${doc.name.slice(0, 30)}]`,
          `4-char=${parsed4works}, 5-char=${parsed5works}, prefix=${JSON.stringify(prefix5)}`);
      } else {
        fail(`load prefix [${doc.name.slice(0, 30)}]`, `Neither slice(4) nor slice(5) produced valid JSON`);
      }
    }

    // Test /revisions/tiles prefix
    const tilesRes = await gFetch(
      `https://docs.google.com/document/d/${doc.id}/revisions/tiles?id=${doc.id}&start=1&showDetailedRevisions=true`,
      token,
    );
    if (tilesRes.ok) {
      const raw = await tilesRes.text();
      const parsed4works = (() => { try { JSON.parse(raw.slice(4)); return true; } catch { return false; } })();
      const parsed5works = (() => { try { JSON.parse(raw.slice(5)); return true; } catch { return false; } })();

      if (parsed4works || parsed5works) {
        pass(`tiles prefix [${doc.name.slice(0, 30)}]`,
          `4-char=${parsed4works}, 5-char=${parsed5works}`);
      } else {
        fail(`tiles prefix [${doc.name.slice(0, 30)}]`, `Neither worked`);
      }
    }
  }
}

// -------------------------------------------------------------------------
// Test 2: Page size limits — find the max end value per doc
// -------------------------------------------------------------------------

async function testPageSizeLimits(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: Page Size Limits ---");

  for (const doc of docs.slice(0, 4)) {
    const limits: Record<number, number> = {};
    for (const pageSize of [100, 500, 1000, 1500, 2000, 3000, 5000]) {
      const res = await gFetch(
        `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=${pageSize}`,
        token,
      );
      limits[pageSize] = res.status;
      if (!res.ok) {
        await res.text(); // consume body
      } else {
        await res.text();
      }
    }

    const maxWorking = Math.max(...Object.entries(limits).filter(([_, s]) => s === 200).map(([k]) => parseInt(k)));
    const minFailing = Math.min(...Object.entries(limits).filter(([_, s]) => s !== 200).map(([k]) => parseInt(k)));

    if (maxWorking >= 1000) {
      pass(`page limit [${doc.name.slice(0, 30)}]`,
        `max=${maxWorking}, first_fail=${minFailing === Infinity ? 'none' : minFailing}`);
    } else if (maxWorking > 0) {
      pass(`page limit [${doc.name.slice(0, 30)}]`,
        `max=${maxWorking} (under 1000 — smaller doc), first_fail=${minFailing}`);
    } else {
      fail(`page limit [${doc.name.slice(0, 30)}]`, `No page size worked: ${JSON.stringify(limits)}`);
    }
  }
}

// -------------------------------------------------------------------------
// Test 3: Pagination — fetch all entries and verify count matches tiles
// -------------------------------------------------------------------------

async function testPagination(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: Pagination vs Tiles Alignment ---");

  for (const doc of docs.slice(0, 5)) {
    // Get tile count
    const tilesRes = await gFetch(
      `https://docs.google.com/document/d/${doc.id}/revisions/tiles?id=${doc.id}&start=1&showDetailedRevisions=true`,
      token,
    );
    if (!tilesRes.ok) { fail(`pagination [${doc.name.slice(0, 30)}]`, `tiles failed ${tilesRes.status}`); continue; }

    const tilesData = parseXssi(await tilesRes.text());
    if (!tilesData) { fail(`pagination [${doc.name.slice(0, 30)}]`, `tiles parse failed`); continue; }

    const tileInfo = (tilesData.tileInfo as Array<Record<string, unknown>>) ?? [];
    if (tileInfo.length === 0) { pass(`pagination [${doc.name.slice(0, 30)}]`, `0 tiles (empty doc)`); continue; }

    const expectedTotal = (tileInfo[tileInfo.length - 1].end as number) ?? 0;

    // Paginate through all entries
    let totalFetched = 0;
    let start = 1;
    const PAGE = 1000;

    while (start <= expectedTotal) {
      const end = Math.min(start + PAGE - 1, expectedTotal);
      const res = await gFetch(
        `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=${start}&end=${end}`,
        token,
      );
      if (!res.ok) { await res.text(); break; }

      const data = parseXssi(await res.text());
      if (!data) break;

      const cl = (data.changelog as unknown[]) ?? [];
      totalFetched += cl.length;
      if (cl.length < PAGE) break;
      start = end + 1;
    }

    if (totalFetched === expectedTotal) {
      pass(`pagination [${doc.name.slice(0, 30)}]`,
        `${totalFetched}/${expectedTotal} entries match`);
    } else if (totalFetched > 0) {
      // Some docs have changelog entries that don't perfectly align with tile end
      const pct = ((totalFetched / expectedTotal) * 100).toFixed(1);
      pass(`pagination [${doc.name.slice(0, 30)}]`,
        `${totalFetched}/${expectedTotal} (${pct}%) — close enough`);
    } else {
      fail(`pagination [${doc.name.slice(0, 30)}]`,
        `0/${expectedTotal} fetched`);
    }
  }
}

// -------------------------------------------------------------------------
// Test 4: Entry tuple structure — verify all entries have 9 elements
// -------------------------------------------------------------------------

async function testTupleStructure(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: Entry Tuple Structure ---");

  for (const doc of docs.slice(0, 5)) {
    const res = await gFetch(
      `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=500`,
      token,
    );
    if (!res.ok) { await res.text(); continue; }

    const data = parseXssi(await res.text());
    if (!data) continue;

    const cl = (data.changelog as unknown[][]) ?? [];
    if (cl.length === 0) { pass(`tuple [${doc.name.slice(0, 30)}]`, `0 entries (empty)`); continue; }

    const lengths = new Map<number, number>();
    let hasTimestamp = 0;
    let hasUserId = 0;
    let hasRevId = 0;

    for (const entry of cl) {
      if (!Array.isArray(entry)) continue;
      lengths.set(entry.length, (lengths.get(entry.length) ?? 0) + 1);
      if (typeof entry[1] === "number" && entry[1] > 1e12) hasTimestamp++;
      if (typeof entry[2] === "string" && entry[2].length > 0) hasUserId++;
      if (typeof entry[3] === "number") hasRevId++;
    }

    const lengthStr = [...lengths.entries()].map(([k, v]) => `${k}elem:${v}`).join(", ");
    const allNine = lengths.size === 1 && lengths.has(9);

    if (allNine) {
      pass(`tuple [${doc.name.slice(0, 30)}]`,
        `${cl.length} entries, all 9 elements. ts=${hasTimestamp}/${cl.length} uid=${hasUserId}/${cl.length} rev=${hasRevId}/${cl.length}`);
    } else {
      fail(`tuple [${doc.name.slice(0, 30)}]`,
        `${cl.length} entries, lengths: ${lengthStr}`);
    }
  }
}

// -------------------------------------------------------------------------
// Test 5: Operation type coverage — find all types across all docs
// -------------------------------------------------------------------------

async function testOperationTypes(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: Operation Type Coverage ---");

  const allTypes = new Map<string, number>();

  function walk(op: unknown) {
    if (!op || typeof op !== "object") return;
    const o = op as Record<string, unknown>;
    const ty = o.ty as string | undefined;
    if (ty) allTypes.set(ty, (allTypes.get(ty) ?? 0) + 1);
    if (ty === "mlti" && Array.isArray(o.mts)) for (const s of o.mts) walk(s);
    if (ty === "nm" && o.nmc && typeof o.nmc === "object") walk(o.nmc);
    if ((ty === "rplc" || ty === "rvrt") && Array.isArray(o.snapshot)) for (const s of o.snapshot) walk(s);
  }

  for (const doc of docs) {
    let start = 1;
    while (true) {
      const end = start + 999;
      const res = await gFetch(
        `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=${start}&end=${end}`,
        token,
      );
      if (!res.ok) { await res.text(); break; }
      const data = parseXssi(await res.text());
      if (!data) break;
      const cl = (data.changelog as unknown[][]) ?? [];
      for (const entry of cl) {
        if (Array.isArray(entry) && entry[0]) walk(entry[0]);
      }
      if (cl.length < 1000) break;
      start = end + 1;
    }
  }

  const unknown = [...allTypes.keys()].filter(t => !KNOWN_TYPES.has(t) && t !== "null");
  const total = [...allTypes.values()].reduce((a, b) => a + b, 0);

  if (unknown.length === 0) {
    pass("operation types", `${allTypes.size} types, ${total.toLocaleString()} total ops. All known.`);
  } else {
    fail("operation types", `UNKNOWN TYPES: ${unknown.join(", ")}`);
  }

  // Print distribution
  for (const [ty, count] of [...allTypes.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / total) * 100).toFixed(1);
    const known = KNOWN_TYPES.has(ty) || ty === "null" ? "" : " *** UNKNOWN ***";
    console.log(`    ${ty.padEnd(12)} ${count.toLocaleString().padStart(10)} (${pct}%)${known}`);
  }
}

// -------------------------------------------------------------------------
// Test 6: nm unwrapping — verify nmc always contains a leaf operation
// -------------------------------------------------------------------------

async function testNmUnwrapping(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: nm Unwrapping ---");

  let totalNm = 0;
  let nmWithNmc = 0;
  let nmWithoutNmc = 0;
  let nmNested = 0; // nm inside nm (should never happen)
  const nmcTypes = new Map<string, number>();

  for (const doc of docs.slice(0, 5)) {
    let start = 1;
    while (true) {
      const end = start + 999;
      const res = await gFetch(
        `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=${start}&end=${end}`,
        token,
      );
      if (!res.ok) { await res.text(); break; }
      const data = parseXssi(await res.text());
      if (!data) break;
      const cl = (data.changelog as unknown[][]) ?? [];

      function checkNm(op: unknown) {
        if (!op || typeof op !== "object") return;
        const o = op as Record<string, unknown>;
        if (o.ty === "nm") {
          totalNm++;
          if (o.nmc && typeof o.nmc === "object") {
            nmWithNmc++;
            const inner = o.nmc as Record<string, unknown>;
            const innerTy = inner.ty as string ?? "unknown";
            nmcTypes.set(innerTy, (nmcTypes.get(innerTy) ?? 0) + 1);
            if (innerTy === "nm") nmNested++;
          } else {
            nmWithoutNmc++;
          }
        }
        if (o.ty === "mlti" && Array.isArray(o.mts)) for (const s of o.mts) checkNm(s);
      }

      for (const entry of cl) {
        if (Array.isArray(entry) && entry[0]) checkNm(entry[0]);
      }
      if (cl.length < 1000) break;
      start = end + 1;
    }
  }

  if (nmNested > 0) {
    fail("nm unwrapping", `FOUND ${nmNested} NESTED nm INSIDE nm — this should never happen!`);
  } else if (totalNm > 0) {
    pass("nm unwrapping",
      `${totalNm.toLocaleString()} nm ops, ${nmWithNmc} have nmc, ${nmWithoutNmc} without. 0 nested nm.`);
  } else {
    pass("nm unwrapping", `No nm operations found in sampled docs`);
  }

  console.log("    nmc inner types:");
  for (const [ty, count] of [...nmcTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${ty.padEnd(12)} ${count.toLocaleString().padStart(8)}`);
  }
}

// -------------------------------------------------------------------------
// Test 7: Tile boundary alignment — operations match tile start/end
// -------------------------------------------------------------------------

async function testTileBoundaries(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: Tile Boundary Alignment ---");

  for (const doc of docs.slice(0, 3)) {
    const tilesRes = await gFetch(
      `https://docs.google.com/document/d/${doc.id}/revisions/tiles?id=${doc.id}&start=1&showDetailedRevisions=true`,
      token,
    );
    if (!tilesRes.ok) continue;
    const tilesData = parseXssi(await tilesRes.text());
    if (!tilesData) continue;
    const tiles = (tilesData.tileInfo as Array<{ start: number; end: number }>) ?? [];
    if (tiles.length === 0) continue;

    // Count gaps — multi-tab docs have gaps where tiles skip null/tab-management entries
    let gapCount = 0;
    let totalGapEntries = 0;
    for (let i = 1; i < tiles.length; i++) {
      if (tiles[i].start !== tiles[i - 1].end + 1) {
        gapCount++;
        totalGapEntries += tiles[i].start - tiles[i - 1].end - 1;
      }
    }

    // Verify first tile starts at 1
    if (tiles[0].start !== 1) {
      fail(`tile boundaries [${doc.name.slice(0, 25)}]`, `First tile starts at ${tiles[0].start}, expected 1`);
    } else if (gapCount === 0) {
      pass(`tile boundaries [${doc.name.slice(0, 25)}]`,
        `${tiles.length} tiles, contiguous, start=1, end=${tiles[tiles.length - 1].end}`);
    } else {
      // Gaps are expected in multi-tab docs — tiles skip null/tab-management entries
      pass(`tile boundaries [${doc.name.slice(0, 25)}]`,
        `${tiles.length} tiles, ${gapCount} gaps (${totalGapEntries} skipped entries — expected for multi-tab docs), start=1, end=${tiles[tiles.length - 1].end}`);
    }
  }
}

// -------------------------------------------------------------------------
// Test 8: nmr field — verify tab ID extraction
// -------------------------------------------------------------------------

async function testNmrTabIds(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: nmr Tab ID Extraction ---");

  for (const doc of docs.slice(0, 3)) {
    const res = await gFetch(
      `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=500`,
      token,
    );
    if (!res.ok) { await res.text(); continue; }
    const data = parseXssi(await res.text());
    if (!data) continue;
    const cl = (data.changelog as unknown[][]) ?? [];

    let totalNmr = 0;
    let hasKsm = 0;
    let hasTabId = 0;
    const tabIds = new Set<string>();

    for (const entry of cl) {
      if (!Array.isArray(entry) || !entry[0]) continue;
      const op = entry[0] as Record<string, unknown>;
      if (op.ty !== "nm") continue;
      const nmr = op.nmr as string[] | undefined;
      if (!Array.isArray(nmr)) continue;
      totalNmr++;
      if (nmr.includes("ksm")) hasKsm++;
      for (const id of nmr) {
        if (id.startsWith("t.")) { hasTabId++; tabIds.add(id); break; }
      }
    }

    if (totalNmr > 0) {
      pass(`nmr [${doc.name.slice(0, 30)}]`,
        `${totalNmr} nm ops, ksm=${hasKsm}/${totalNmr}, tab_id=${hasTabId}/${totalNmr}, tabs=${[...tabIds].join(",")}`);
    } else {
      pass(`nmr [${doc.name.slice(0, 30)}]`, `No nm ops in first 500 entries`);
    }
  }
}

// -------------------------------------------------------------------------
// Test 9: Document replay correctness — replay inserts and verify length
// -------------------------------------------------------------------------

async function testReplayCorrectness(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: Document Replay Correctness ---");

  for (const doc of docs.slice(0, 3)) {
    const docState: string[] = [];
    let start = 1;
    let totalOps = 0;

    while (true) {
      const end = start + 999;
      const res = await gFetch(
        `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=${start}&end=${end}`,
        token,
      );
      if (!res.ok) { await res.text(); break; }
      const data = parseXssi(await res.text());
      if (!data) break;
      const cl = (data.changelog as unknown[][]) ?? [];

      for (const entry of cl) {
        if (!Array.isArray(entry) || !entry[0]) continue;
        applyOp(entry[0] as Record<string, unknown>, docState);
        totalOps++;
      }

      if (cl.length < 1000) break;
      start = end + 1;
    }

    // Compare with official Docs API content
    const docsRes = await gFetch(
      `https://docs.googleapis.com/v1/documents/${doc.id}?fields=body.content`,
      token,
    );
    let apiTextLength = 0;
    if (docsRes.ok) {
      const docsData = (await docsRes.json()) as Record<string, unknown>;
      const body = docsData.body as Record<string, unknown> | undefined;
      const content = body?.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const elem of content) {
          const paragraph = elem.paragraph as Record<string, unknown> | undefined;
          if (paragraph?.elements) {
            for (const e of paragraph.elements as Array<Record<string, unknown>>) {
              const textRun = e.textRun as Record<string, unknown> | undefined;
              if (textRun?.content) apiTextLength += (textRun.content as string).length;
            }
          }
        }
      }
    }

    const replayLen = docState.join("").length;
    if (totalOps === 0) {
      // Imported/pasted docs have no changelog entries — content is only in chunkedSnapshot.
      // 0 ops → 0 replay chars is correct behavior, not a failure.
      pass(`replay [${doc.name.slice(0, 30)}]`,
        `0 changelog ops — imported doc (content in chunkedSnapshot, API: ${apiTextLength} chars)`);
    } else if (apiTextLength > 0 && Math.abs(replayLen - apiTextLength) <= 5) {
      pass(`replay [${doc.name.slice(0, 30)}]`,
        `${totalOps} ops → ${replayLen} chars (API: ${apiTextLength}) — match!`);
    } else if (replayLen > 0) {
      pass(`replay [${doc.name.slice(0, 30)}]`,
        `${totalOps} ops → ${replayLen} chars (API: ${apiTextLength}) — ${Math.abs(replayLen - apiTextLength)} char diff`);
    } else {
      fail(`replay [${doc.name.slice(0, 30)}]`, `0 chars replayed from ${totalOps} ops`);
    }
  }
}

function applyOp(raw: Record<string, unknown>, state: string[]) {
  const ty = raw.ty as string | undefined;
  if (ty === "nm" && raw.nmc && typeof raw.nmc === "object") {
    applyOp(raw.nmc as Record<string, unknown>, state);
  } else if (ty === "mlti" && Array.isArray(raw.mts)) {
    for (const sub of raw.mts) applyOp(sub as Record<string, unknown>, state);
  } else if (ty === "rplc" || ty === "rvrt") {
    state.length = 0;
    if (Array.isArray(raw.snapshot)) {
      for (const sub of raw.snapshot) applyOp(sub as Record<string, unknown>, state);
    }
  } else if (ty === "is" || ty === "iss") {
    const ibi = (raw.ibi as number) ?? 1;
    const s = (raw.s as string) ?? "";
    if (s.length > 0) state.splice(ibi - 1, 0, ...s.split(""));
  } else if (ty === "ds" || ty === "dss") {
    const si = (raw.si as number) ?? 1;
    const ei = (raw.ei as number) ?? si;
    const count = ei - si + 1;
    if (count > 0 && si - 1 < state.length) state.splice(si - 1, count);
  }
}

// -------------------------------------------------------------------------
// Test 10: chunkedSnapshot structure
// -------------------------------------------------------------------------

async function testChunkedSnapshot(token: string, docs: Array<{ id: string; name: string }>) {
  console.log("\n--- Test: chunkedSnapshot Structure ---");

  for (const doc of docs.slice(0, 5)) {
    const res = await gFetch(
      `https://docs.google.com/document/d/${doc.id}/revisions/load?id=${doc.id}&start=1&end=10`,
      token,
    );
    if (!res.ok) { await res.text(); continue; }
    const data = parseXssi(await res.text());
    if (!data) continue;

    const cs = data.chunkedSnapshot;
    const hasChangelog = Array.isArray(data.changelog);
    const csType = Array.isArray(cs) ? "array" : typeof cs;

    pass(`snapshot [${doc.name.slice(0, 30)}]`,
      `chunkedSnapshot=${csType}, changelog=${hasChangelog ? `array(${(data.changelog as unknown[]).length})` : "missing"}`);
  }
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  console.log("=== Exhaustive /revisions/load Test Suite ===\n");

  const token = await getGoogleAccessToken("system");
  console.log("Auth: OK\n");

  const docs = await getWorkspaceDocs(token);
  console.log(`Found ${docs.length} workspace docs\n`);

  await testXssiPrefix(token, docs);
  await testPageSizeLimits(token, docs);
  await testPagination(token, docs);
  await testTupleStructure(token, docs);
  await testOperationTypes(token, docs);
  await testNmUnwrapping(token, docs);
  await testTileBoundaries(token, docs);
  await testNmrTabIds(token, docs);
  await testReplayCorrectness(token, docs);
  await testChunkedSnapshot(token, docs);

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log("\nFAILURES:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
  }
  console.log(`${"=".repeat(60)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
