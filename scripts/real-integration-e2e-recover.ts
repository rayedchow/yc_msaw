/**
 * POST-RUN VERIFICATION CORRECTION for a finished real-integration-e2e run (no agent, no rerun, no state changes).
 *
 *   npx tsx scripts/real-integration-e2e-recover.ts [--report reports/real-integration-e2e-failed-<run>.json]
 *
 * The original verifier failed two checks because it read a BOUNDED transcript copy (bounded() replaced the
 * ~41k structured tool result with {truncated, preview}), and a third because the unauthenticated independent
 * GitHub re-check hit the shared-IP rate limit (403). This script re-audits from primary evidence:
 *  - the FULL SDK trace of attempt 2, read from the same Modal tenant store; every chunk's sha256 is checked
 *    against its trace-index record, and blob-backed payloads are checked against their content address;
 *  - the exact tool call/result pair (callId) and the structured child metadata in the raw result;
 *  - a fresh AUTHENTICATED GitHub REST cross-check through the user's `gh` CLI (token never read or printed).
 * The original reports/events/state are only read and hashed, never modified.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { ModalObjectStore } from "../src/store/modal-objects.js";
import { chunkIndexKey } from "../src/traces/schema.js";
import { readBlob } from "../src/traces/ingest.js";
import { extractGithubFileEvidence, githubProofOk, renderHtml, renderMarkdown } from "./real-integration-e2e-render.js";

const { values } = parseArgs({ options: { report: { type: "string", default: "reports/real-integration-e2e-failed-e2e-20261017T232926-fe8d.json" } } });
const ORIGINAL = values.report!;
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const FACT = "create-mcp-use-app";

const base = ORIGINAL.replace(/\.json$/, "");
const originalHashes: Record<string, string> = {};
for (const f of [`${base}.json`, `${base}.md`, `${base}.html`, ".context/real-demo-events.jsonl", ".context/real-demo-state.json"]) {
  originalHashes[f] = sha256(await fs.readFile(f));
}
const original = JSON.parse(await fs.readFile(ORIGINAL, "utf8")) as Record<string, any>;
const p = original.phases;
const truth = p.githubTruth;
const REF = original.config.ref as string;
const ns = JSON.parse(await fs.readFile(".context/hosted-demo-client.json", "utf8")).tenantNs as string;
if (ns !== original.config.ns) throw new Error("namespace mismatch between client config and original report");

const store = new ModalObjectStore();
const checks: Record<string, boolean> = {};
const evidence: Record<string, unknown> = {};
try {
  // ---------------------------------------------------------------- full SDK trace of attempt 2 (and 1)
  const readSession = async (sessionId: string) => {
    const idxKeys = await store.list(ns, `trace-index/${sessionId}/`);
    const chunks: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, any>> = [];
    for (const k of idxKeys.sort()) {
      const rec = JSON.parse((await store.get(ns, [k])).get(k)!.toString("utf8")) as { key: string; sha256: string; chunkSeq: number; events: number; final?: boolean; receivedAt?: string };
      if (k !== chunkIndexKey(sessionId, rec.chunkSeq)) throw new Error(`unexpected index key ${k}`);
      const raw = (await store.get(ns, [rec.key])).get(rec.key);
      if (!raw) throw new Error(`chunk ${rec.key} missing`);
      const jsonl = gunzipSync(raw);
      const ok = sha256(jsonl) === rec.sha256;
      const evs = jsonl.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      chunks.push({ key: rec.key, indexKey: k, chunkSeq: rec.chunkSeq, indexSha256: rec.sha256, computedSha256: sha256(jsonl), sha256Matches: ok, storedObjectBytes: raw.length, events: evs.length, indexEvents: rec.events, final: rec.final ?? null, receivedAt: rec.receivedAt ?? null });
      if (!ok || evs.length !== rec.events) throw new Error(`chunk ${rec.key} failed its index check`);
      events.push(...evs);
    }
    return { sessionId, chunks, events: events.sort((a, b) => a.seq - b.seq) };
  };
  const resolveBlob = async (v: unknown): Promise<{ value: unknown; blob?: { sha256: string; bytes: number; computedSha256: string; matches: boolean } }> => {
    const o = v as { $blob?: string; bytes?: number; mediaType?: string } | null;
    if (!o || typeof o !== "object" || typeof o.$blob !== "string") return { value: v };
    const bytes = await readBlob(store, ns, o.$blob);
    if (!bytes) throw new Error(`blob ${o.$blob} missing`);
    const computed = sha256(bytes);
    const parsed = /json/.test(o.mediaType ?? "") ? JSON.parse(bytes.toString("utf8")) : bytes.toString("utf8");
    return { value: parsed, blob: { sha256: o.$blob, bytes: bytes.length, computedSha256: computed, matches: computed === o.$blob && bytes.length === o.bytes } };
  };

  const t2 = await readSession(p.attempt2.trace.sessionId);
  const t1 = await readSession(p.attempt1.trace.sessionId);
  checks["trace2.chunksVerifiedAgainstIndex"] = t2.chunks.length > 0 && t2.chunks.every((c) => c.sha256Matches === true);
  checks["trace2.eventCountMatchesOriginalFinish"] = t2.events.length === p.attempt2.trace.events;
  checks["trace1.chunksVerifiedAgainstIndex"] = t1.chunks.length > 0 && t1.chunks.every((c) => c.sha256Matches === true);

  const callId = (p.attempt2.readFileCalls as Array<{ callId: string }>)[0]?.callId;
  const call = t2.events.find((e) => e.type === "tool_call" && e.data?.callId === callId);
  const resultEv = t2.events.find((e) => e.type === "tool_result" && (e.data?.callId === callId || e.data?.$blob));
  const resolved = resultEv ? await resolveBlob(resultEv.data) : { value: null };
  const resultData = resolved.value as Record<string, any> | null;
  const resultMatchesCall = !!resultData && resultData.callId === callId;
  const meta = resultMatchesCall ? extractGithubFileEvidence(resultData, (s) => sha256(s)) : null;
  checks["trace2.toolCallFoundByCallId"] = !!call && call.data.name === "integration__github-read__read_file";
  checks["trace2.toolResultBlobVerified"] = resolved.blob?.matches === true && resultMatchesCall;
  checks["attempt2.calledRepairedToolWithRef"] = !!call && call.data.arguments?.ref === REF;
  checks["attempt2.resultNotError"] = resultMatchesCall && resultData!.isError !== true;
  checks["attempt2.realGithub200SameShaAsHostCheck"] = githubProofOk(meta, { ref: REF, sha: truth.sha }, call?.data.arguments);
  checks["attempt2.returnedTextSha256MatchesHostCheck"] = meta?.textSha256 === truth.textSha256;
  const finalOutput = [...t2.events].reverse().find((e) => e.type === "model_output");
  const finalText = ((finalOutput?.data?.message?.content as Array<{ type: string; text?: string }>) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  checks["attempt2.finalAnswerInTraceHasFact"] = finalText.includes(FACT);
  checks["attempt2.finalAnswerMatchesOriginalTranscript"] = finalText.trim() === String(p.attempt2.answer).trim();
  evidence.trace2 = {
    sessionId: t2.sessionId,
    chunks: t2.chunks,
    events: t2.events.length,
    toolCall: call ? { seq: call.seq, ts: call.ts, callId: call.data.callId, name: call.data.name, arguments: call.data.arguments } : null,
    toolResult: resultEv ? { seq: resultEv.seq, ts: resultEv.ts, storedAs: resolved.blob ? "content-addressed blob" : "inline", blob: resolved.blob ?? null, isError: resultData?.isError ?? null, rawResultChars: JSON.stringify(resultData).length } : null,
    githubEvidence: meta,
    finalAnswer: { seq: finalOutput?.seq, ts: finalOutput?.ts, text: finalText },
    eventIndex: t2.events.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type })),
  };
  evidence.trace1 = { sessionId: t1.sessionId, chunks: t1.chunks, events: t1.events.length };

  // ---------------------------------------------------------------- fresh AUTHENTICATED GitHub cross-check (gh CLI)
  const ghOut = execFileSync("gh", ["api", "--include", `repos/${original.config.owner}/${original.config.repo}/contents/${original.config.file}?ref=${REF}`, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const split = ghOut.indexOf("\r\n\r\n") >= 0 ? ghOut.indexOf("\r\n\r\n") : ghOut.indexOf("\n\n");
  const head = ghOut.slice(0, split);
  const body = JSON.parse(ghOut.slice(split).trim()) as { sha?: string; size?: number; content?: string };
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0);
  const requestId = /x-github-request-id:\s*(\S+)/i.exec(head)?.[1] ?? null;
  const text = body.content ? Buffer.from(body.content, "base64").toString("utf8") : "";
  evidence.githubAuthenticatedCrossCheck = { via: "gh api (user-authorized GitHub CLI; token handled by gh, never read/printed)", authenticated: true, at: new Date().toISOString(), status, requestId, sha: body.sha, size: body.size, textSha256: sha256(text), containsFact: text.includes(FACT) };
  checks["github.authenticatedCrossCheckSameSha"] = status === 200 && body.sha === truth.sha && sha256(text) === truth.textSha256;
  evidence.githubUnauthenticatedAfterOriginal = { ...p.githubAfter, note: "original unauthenticated re-check: rate limited on the shared local IP (kept as recorded)" };
} finally {
  store.close();
}

// The original verdict and its failed checks are preserved verbatim.
const originalFailed = Object.entries(original.checks as Record<string, boolean>).filter(([, v]) => !v).map(([k]) => k);
const originalPassed = Object.entries(original.checks as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k);
const revalidated = { "attempt2.calledRepairedToolWithRef": checks["attempt2.calledRepairedToolWithRef"], "attempt2.realGithub200SameShaAsHostCheck": checks["attempt2.realGithub200SameShaAsHostCheck"], "github.independentAfterSameSha (via authenticated cross-check)": checks["github.authenticatedCrossCheckSameSha"] };
const auditOk = Object.values(checks).every(Boolean);
const correction = {
  kind: "real-integration-e2e post-run verification correction",
  label: "POST-RUN VERIFICATION CORRECTION: the original verifier failed because it validated a bounded (clipped) transcript copy and its unauthenticated GitHub re-check was rate limited (403). No agent was rerun; no integration, memory, events or state were changed.",
  at: new Date().toISOString(),
  auditOk,
  originalReport: { path: ORIGINAL, runId: original.runId, finishedAt: original.finishedAt, ok: original.ok, failedChecks: originalFailed, passedChecks: originalPassed.length, sha256: originalHashes },
  causes: [
    "bounded(t.details, 30000) replaced the ~41k structured MCP result with {truncated, preview}; findMeta searched the bounded copy and lost github.status/requestId (and the call lookup depended on it)",
    "the unauthenticated independent re-check after attempt 2 returned 403 (x-ratelimit-remaining 0 on the shared local IP)",
  ],
  checks,
  revalidatedOriginalChecks: revalidated,
  evidence,
};
const out = JSON.stringify(correction, null, 2);
if (JWT_RE.test(out)) throw new Error("correction contains a JWT-shaped value; refusing to write");
await fs.writeFile("reports/real-integration-e2e-recovery.json", `${out}\n`);
const md = [
  `# ${correction.label}`,
  "",
  `Audit: **${auditOk ? "ALL REQUIRED PROOFS VERIFIED" : "NOT VERIFIED"}** at ${correction.at}.`,
  "",
  `Original report (unchanged, verdict ok=${String(original.ok)}): \`${ORIGINAL}\`, finished ${original.finishedAt}. sha256:`,
  ...Object.entries(originalHashes).map(([f, h]) => `- \`${f}\`: ${h}`),
  "",
  `Original failed checks (preserved): ${originalFailed.join(", ")}`,
  "",
  "## Re-audit checks (primary evidence)",
  "",
  "| check | result |",
  "| --- | --- |",
  ...Object.entries(checks).map(([k, v]) => `| ${k} | ${v ? "PASS" : "FAIL"} |`),
  "",
  "## Evidence",
  "",
  "```json",
  JSON.stringify({ trace2: { ...(evidence.trace2 as object), eventIndex: undefined }, githubAuthenticatedCrossCheck: evidence.githubAuthenticatedCrossCheck, githubUnauthenticatedAfterOriginal: evidence.githubUnauthenticatedAfterOriginal }, null, 2),
  "```",
  "",
].join("\n");
await fs.writeFile("reports/real-integration-e2e-recovery.md", md);

if (auditOk) {
  // Canonical reports: the correction plus the ORIGINAL report verbatim (its own ok/checks/events untouched).
  const canonical = { kind: "real-integration-e2e", verdict: "VERIFIED by post-run verification correction", correction, originalReport: original };
  const cOut = JSON.stringify(canonical, null, 2);
  if (JWT_RE.test(cOut)) throw new Error("canonical report contains a JWT-shaped value; refusing to write");
  await fs.writeFile("reports/real-integration-e2e.json", `${cOut}\n`);
  await fs.writeFile("reports/real-integration-e2e.md", `${md}\n---\n\n# Original run report (verbatim render; its verdict was FAILED for the reasons above)\n\n${renderMarkdown(original)}`);
  const banner = `<div style="background:#dafbe1;border-bottom:1px solid #1a7f37;padding:10px 24px;font:13px -apple-system,sans-serif"><b>POST-RUN VERIFICATION CORRECTION</b>: all required proofs verified from the full stored SDK trace (sha256-checked) and an authenticated GitHub cross-check. The original verifier failed due to transcript clipping and an unauthenticated rate limit. Original report: ${ORIGINAL} (sha256 ${originalHashes[`${base}.json`]}). See reports/real-integration-e2e-recovery.md.</div>`;
  await fs.writeFile("reports/real-integration-e2e.html", renderHtml(original).replace("<body>", `<body>${banner}`));
}
// Originals must be byte-identical after this script.
for (const [f, h] of Object.entries(originalHashes)) if (sha256(await fs.readFile(f)) !== h) throw new Error(`original evidence file changed: ${f}`);
console.log(JSON.stringify({ auditOk, checks, wrote: auditOk ? ["reports/real-integration-e2e-recovery.{json,md}", "reports/real-integration-e2e.{json,md,html}"] : ["reports/real-integration-e2e-recovery.{json,md}"] }, null, 1));
process.exitCode = auditOk ? 0 : 1;
