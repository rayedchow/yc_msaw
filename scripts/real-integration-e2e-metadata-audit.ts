/**
 * POST-RUN METADATA AUDIT for a finished real-integration-e2e run (read-only; no agent, no rerun).
 *
 *   npx tsx scripts/real-integration-e2e-metadata-audit.ts [--run e2e-20261018T003409-5fec]
 *
 * Corrects two narrative/metadata fields of the emitted report from ACTUAL stored observations:
 *  1. attempts[].conversationId: the producer read a nonexistent `trace.conversationId` (the SDK exposes
 *     `trace.correlation`), so the report says null. The truth is read from the hosted tenant's immutable trace
 *     session bindings (readSessionBinding) and the stored chunk events.
 *  2. labels.dailyCycle claimed a fresh-only cohort. The real daily manifest cohort (from the build receipt and
 *     the manifest itself) is reported as observed.
 * Verdict, checks, tool evidence, transcript and events are NOT changed. The as-emitted report bytes are
 * preserved in .context/real-demo-fresh/as-emitted-reports with their sha256.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { ModalObjectStore } from "../src/store/modal-objects.js";
import { readSessionBinding } from "../src/traces/ingest.js";
import { loadManifest } from "../src/traces/daily.js";
import { renderHtml, renderMarkdown } from "./real-integration-e2e-render.js";

const { values } = parseArgs({ options: { run: { type: "string", default: "e2e-20261018T003409-5fec" } } });
const RUN = values.run!;
const base = `reports/real-integration-e2e-${RUN}`;
const asEmittedDir = ".context/real-demo-fresh/as-emitted-reports";
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const emittedHashes: Record<string, string> = {};
for (const ext of ["json", "md", "html"]) emittedHashes[`${base}.${ext}`] = sha256(await fs.readFile(`${asEmittedDir}/real-integration-e2e-${RUN}.${ext}`));
const report = JSON.parse(await fs.readFile(`${asEmittedDir}/real-integration-e2e-${RUN}.json`, "utf8")) as Record<string, any>;
if (report.runId !== RUN) throw new Error("run id mismatch");
const ns = report.config.ns as string;
const attempts = report.phases.attempts as Array<Record<string, any>>;
const piSessionId = report.phases.sameSession.piSessionId as string;
const cycle = (report.phases.buildCycles as Array<Record<string, any>>)[0];
if (!cycle) throw new Error("report has no build cycle to audit");

const store = new ModalObjectStore();
const checks: Record<string, boolean> = {};
const observed: Record<string, unknown> = {};
try {
  // ---------------------------------------------------------------- trace correlation (immutable hosted bindings + stored events)
  const perAttempt: Array<Record<string, any>> = [];
  for (const a of attempts) {
    const sid = a.trace.sessionId as string;
    const binding = await readSessionBinding(store, ns, sid);
    const idxKeys = (await store.list(ns, `trace-index/${sid}/`)).sort();
    const events: Array<Record<string, any>> = [];
    const chunks: Array<Record<string, unknown>> = [];
    for (const k of idxKeys) {
      const rec = JSON.parse((await store.get(ns, [k])).get(k)!.toString("utf8")) as { key: string; sha256: string };
      const raw = (await store.get(ns, [rec.key])).get(rec.key)!;
      const jsonl = gunzipSync(raw);
      chunks.push({ key: rec.key, sha256Matches: sha256(jsonl) === rec.sha256 });
      for (const l of jsonl.toString("utf8").split("\n")) if (l) events.push(JSON.parse(l));
    }
    const corrInEvents = [...new Set(events.map((e) => JSON.stringify({ conversationId: e.conversationId ?? e.correlation?.conversationId ?? null, runId: e.runId ?? e.correlation?.runId ?? null })))];
    const start = events.find((e) => e.type === "session_start");
    perAttempt.push({
      attempt: a.attempt,
      sessionId: sid,
      binding,
      chunks,
      events: events.length,
      sessionStartCorrelation: start ? (start.correlation ?? start.data?.correlation ?? null) : null,
      correlationValuesInEvents: corrInEvents.map((x) => JSON.parse(x)),
      turnIds: [...new Set(events.map((e) => e.turnId ?? e.turn ?? e.data?.turn).filter((x) => x !== undefined && x !== null))].length,
      spanIds: [...new Set(events.map((e) => e.spanId ?? e.span?.id).filter(Boolean))].length,
      parentSpanRefs: events.filter((e) => e.parentSpanId).length,
    });
  }
  observed.traceCorrelation = perAttempt;
  const corr = perAttempt.map((p) => p.binding?.correlation ?? null);
  checks["bindings.presentAndNonLegacy"] = perAttempt.every((p) => !!p.binding && p.binding.legacy === false);
  checks["chunks.sha256VerifiedAgainstIndex"] = perAttempt.every((p) => (p.chunks as Array<{ sha256Matches: boolean }>).length > 0 && (p.chunks as Array<{ sha256Matches: boolean }>).every((c) => c.sha256Matches));
  checks["correlation.sameConversation"] = corr.length > 1 && corr.every((c) => !!c?.conversationId && c.conversationId === corr[0]!.conversationId);
  checks["correlation.conversationIsNativePiIdentity"] = corr[0]?.conversationId === `pi:${piSessionId}` && corr[0]?.conversationSource === "harness";
  checks["correlation.distinctRunIdsMatchingProducerRecords"] = new Set(corr.map((c) => c?.runId)).size === corr.length && corr.every((c, i) => c?.runId === attempts[i]!.runId);
  checks["correlation.previousRunIdLinksRetryToFirstRun"] = corr.slice(1).every((c, i) => c?.previousRunId === corr[i]!.runId) && !corr[0]?.previousRunId;
  checks["events.turnAndSpanStructurePresent"] = perAttempt.every((p) => p.turnIds > 0 && p.spanIds > 0);

  // ---------------------------------------------------------------- actual daily manifest cohort
  const manifest = await loadManifest(store, ns, cycle.receipt.manifestKey);
  observed.cohort = {
    buildId: cycle.receipt.buildId,
    manifestKey: manifest.key,
    day: manifest.day,
    sessionIds: manifest.sessionIds,
    chunks: manifest.chunks.length,
    receiptSessions: cycle.receipt.sessions,
    traceArchive: cycle.receipt.traceArchive ?? null,
    freshCustomerSession: attempts[0]!.trace.sessionId,
    otherSessions: manifest.sessionIds.filter((s: string) => s !== attempts[0]!.trace.sessionId),
    note: "The other current-day sessions are earlier synthetic hosted SDK wire-verification traces in the same tenant; the build input labelled their objectives synthetic. This is normal full-tenant daily catch-up, not a fresh-only cohort.",
  };
  checks["cohort.manifestMatchesReceipt"] = JSON.stringify([...manifest.sessionIds].sort()) === JSON.stringify([...cycle.receipt.sessions].sort());
  checks["cohort.includesFreshCustomerFailureTrace"] = manifest.sessionIds.includes(attempts[0]!.trace.sessionId);
} finally {
  store.close();
}

const auditOk = Object.values(checks).every(Boolean);
const tc = observed.traceCorrelation as Array<Record<string, any>>;
const clarified = structuredClone(report);
const cohort = observed.cohort as Record<string, any>;
clarified.labels.dailyCycle = `OPERATOR-TRIGGERED NOW: real DailyBuildService -> runMemoryBuild on the same Modal store/namespace as the hosted parent. Observed cohort (manifest ${cohort.manifestKey}): ${cohort.sessionIds.length} sessions = this run's fresh customer failure trace ${cohort.freshCustomerSession} + ${cohort.otherSessions.length} earlier synthetic hosted SDK wire-verification traces of the same day (${cohort.otherSessions.join(", ")}); the build also had read-only historical trace sources. [clarified post-run]`;
for (const [i, a] of clarified.phases.attempts.entries()) {
  const c = tc[i]?.binding?.correlation ?? null;
  a.conversationId = c?.conversationId ?? null;
  a.correlationObserved = c;
}
clarified.postRunClarification = {
  kind: "post-run metadata clarification (labels/correlation only)",
  at: new Date().toISOString(),
  auditOk,
  originalEmitted: { sha256: emittedHashes, preservedAt: asEmittedDir },
  clarifiedFields: ["labels.dailyCycle", "phases.attempts[].conversationId", "phases.attempts[].correlationObserved (new)", "postRunClarification (new)"],
  unchanged: "ok, verdict, checks, loopStop, tool calls/results and evidence, transcript, events, state and all other phases are byte-for-byte the emitted values",
  causes: [
    "producer read trace.conversationId (nonexistent); the SDK exposes trace.correlation.conversationId — the WIRE correlation was correct, only the report field was null",
    "labels.dailyCycle text claimed a fresh-only cohort; the real manifest had 4 sessions",
  ],
  checks,
  observed,
  auditReport: `${base}-metadata-audit.json`,
};
for (const k of ["ok", "verdict", "checks", "loopStop", "transcript", "events"]) if (JSON.stringify(clarified[k]) !== JSON.stringify(report[k])) throw new Error(`refusing: ${k} would change`);
const auditDoc = { kind: "real-integration-e2e metadata audit", runId: RUN, at: clarified.postRunClarification.at, auditOk, checks, observed, originalEmitted: clarified.postRunClarification.originalEmitted };
const auditOut = JSON.stringify(auditDoc, null, 2);
const out = JSON.stringify(clarified, null, 2);
if (JWT_RE.test(out) || JWT_RE.test(auditOut)) throw new Error("JWT-shaped value found; refusing to write");
await fs.writeFile(`${base}-metadata-audit.json`, `${auditOut}\n`);
await fs.writeFile(`${base}-metadata-audit.md`, [`# Metadata audit — ${RUN}`, "", `Audit: **${auditOk ? "VERIFIED" : "NOT VERIFIED"}** (read-only observations of the hosted tenant store).`, "", "| check | result |", "| --- | --- |", ...Object.entries(checks).map(([k, v]) => `| ${k} | ${v ? "PASS" : "FAIL"} |`), "", "```json", JSON.stringify(observed, null, 2), "```", ""].join("\n"));
if (!auditOk) {
  console.log(JSON.stringify({ auditOk, checks }, null, 1));
  process.exit(1);
}
const md = renderMarkdown(structuredClone(clarified));
const html = renderHtml(structuredClone(clarified));
for (const target of [base, "reports/real-integration-e2e"]) {
  await fs.writeFile(`${target}.json`, `${out}\n`);
  await fs.writeFile(`${target}.md`, md);
  await fs.writeFile(`${target}.html`, html);
}
console.log(JSON.stringify({ auditOk, checks, cohort: observed.cohort, correlation: tc.map((t) => t.binding?.correlation) }, null, 1));
