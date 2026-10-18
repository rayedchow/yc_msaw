/**
 * Final CRM benchmark report from persisted batch results (no model calls):
 *   npx tsx scripts/crm-report.ts --batch crm2 [--aborted crm1]
 * Writes reports/crm-matrix-<batch>.json / .md / .html. Every predeclared cell is listed (completed, failed, infra,
 * invalid, unavailable arm, or MISSING). One sample per cell: exploratory, no statistical claims.
 */
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { matrixCells, trainingSessions, EVAL_TARGETS, type MatrixCell } from "../eval/crm/scenarios.js";
import { REPO, scrub, assertNoSecrets, loadEnvFile, registerSecret } from "../eval/crm/infra.js";

const { values } = parseArgs({ options: { batch: { type: "string" }, aborted: { type: "string", multiple: true } } });
const BATCH = values.batch!;
const BDIR = path.join(REPO, ".context/crm-batches", BATCH);
const RES = path.join(BDIR, "results");
await loadEnvFile(path.join(REPO, ".env"));
await loadEnvFile(path.join(REPO, ".context/manufact.env"));
for (const k of ["FIREWORKS_API_KEY", "MCP_USE_API_KEY", "EXA_API_KEY", "INTEGRATION_CHILD_SIGNING_JWK"]) registerSecret(process.env[k]);
const state = JSON.parse(await fs.readFile(path.join(BDIR, "batch.json"), "utf8")) as { seedBase: string; head: string; frozen?: Record<string, Record<string, unknown>>; keys: Record<string, { key: string }> };
for (const k of Object.values(state.keys)) registerSecret(k.key);
const manifest = JSON.parse(await fs.readFile(path.join(REPO, `reports/crm-matrix-manifest-${BATCH}.json`), "utf8")) as Record<string, unknown>;
const read = async (f: string) => (existsSync(path.join(RES, f)) ? JSON.parse(await fs.readFile(path.join(RES, f), "utf8")) : null);
type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ------------------------------------------------------------------ integrity
const files = await fs.readdir(RES);
const integrity = await Promise.all(files.filter((f) => f.startsWith("integrity-")).sort().map(async (f) => ({ file: f, ...(await read(f)) })));
const matrixPost = integrity.filter((i) => i.file.startsWith("integrity-matrix-post"));
const matrixPre = integrity.filter((i) => i.file.startsWith("integrity-matrix-") && !i.file.includes("post"));
const integrityFailed = integrity.some((i) => i.ok === false);
const matrixIntegrityOk = matrixPre.length > 0 && matrixPost.length > 0 && [...matrixPre, ...matrixPost].every((i) => i.ok === true);

// ------------------------------------------------------------------ cells
function usageOf(r: Rec) {
  return { input: r?.attempt?.usage?.input ?? 0, output: r?.attempt?.usage?.output ?? 0, cacheRead: r?.attempt?.usage?.cacheRead ?? 0, piCost: r?.attempt?.usage?.piCostEstimateUsd ?? 0 };
}
function outcomeOf(r: Rec | null, matrix: boolean): string {
  if (!r) return "MISSING";
  if (r.unavailableArm) return "UNAVAILABLE-ARM";
  if (r.invalid) return "INVALID";
  if (matrix && !matrixIntegrityOk) return "INVALID-INTEGRITY";
  if (!r.attempt) return "INFRA";
  if (r.infraError && !r.score) return "INFRA";
  if (r.attempt.stoppedBy === "error" && !r.score?.correct) return /429|rate|timeout|ETIMEDOUT|ECONN|5\d\d/i.test(r.attempt.error ?? "") ? "INFRA-PROVIDER" : "ERROR";
  if (r.score?.success) return "SUCCESS";
  if ((r.score?.correct ?? 0) > 0) return "PARTIAL";
  return "FAIL";
}
function sumCounts(maps: Array<Record<string, number>>) {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + (typeof v === "number" ? v : 0);
  return out;
}
const penaltyCell = (r: { unintendedWrites: number | null; unintendedPenaltyComponents: Record<string, number | null> | null }) => (r.unintendedWrites === null ? "-" : `${r.unintendedWrites} (wr${r.unintendedPenaltyComponents?.wrongRecords ?? "?"}/fm${r.unintendedPenaltyComponents?.forbiddenMutations ?? "?"}/wc${r.unintendedPenaltyComponents?.wrongCrmMutations ?? "?"}/cd${r.unintendedPenaltyComponents?.createdOrDeleted ?? "?"})`);
function cellRow(id: string, r: Rec | null, matrix: boolean) {
  const s = r?.score;
  const st = r?.storedTrace;
  return {
    id,
    outcome: outcomeOf(r, matrix),
    correct: s ? `${s.correct}/${s.eligible}` : "-",
    unintendedWrites: s?.unintendedWrites ?? null,
    unintendedPenaltyComponents: s ? { wrongRecords: s.wrongRecords ?? null, forbiddenMutations: s.forbiddenMutations ?? null, wrongCrmMutations: s.wrongCrmMutations ?? null, createdOrDeleted: s.createdOrDeleted ?? null } : null,
    tagLoss: s?.tagLoss ?? null,
    wrongCrmMutations: s?.wrongCrmMutations ?? null,
    stoppedBy: r?.attempt?.stoppedBy ?? null,
    turns: r?.attempt?.turns ?? null,
    toolCalls: r?.attempt?.toolCalls ?? null,
    apiErrors: s ? s.instances.reduce((a: number, i: Rec) => a + (i.errorResponses ?? 0), 0) : null,
    foreignPatterns: s ? sumCounts(s.instances.map((i: Rec) => i.foreignPatterns ?? {})) : {},
    nonTargetRequests: s ? s.instances.filter((i: Rec) => !i.isTarget).reduce((a: number, i: Rec) => a + (i.requests ?? 0), 0) : null,
    memoryCalls: Object.entries(r?.attempt?.toolCallsByName ?? {}).filter(([k]) => k.startsWith("memory__")).reduce((a, [, v]) => a + (v as number), 0),
    memoryPagesRead: st?.memoryPagesRead ?? [],
    usage: usageOf(r ?? {}),
    latencyMs: r?.attempt?.latencyMs ?? null,
    traceOk: st ? st.correlationCheck?.ok === true && st.sequenceComplete === true : null,
    traceSha256: st?.contentSha256 ?? null,
    traceSessionId: r?.attempt?.traceSessionId ?? null,
    evidence: s?.evidence ? `${s.evidence.reportedExpected}/${s.evidence.expectedIds.length} expected IDs reported, ${s.evidence.reportedUnexpectedIds} other IDs` : null,
    error: (r?.infraError ?? r?.invalid ?? r?.unavailableArm ?? r?.attempt?.error ?? null)?.toString().slice(0, 300) ?? null,
    finalPreview: (r?.attempt?.finalText ?? "").slice(0, 400),
  };
}

const training = await Promise.all(trainingSessions(state.seedBase).map(async (t) => ({ curriculum: t.curriculum, model: t.model, family: t.task.family, target: t.task.targets.join("+"), org: t.task.org.name, ...cellRow(t.task.id, await read(`train-${t.task.id}.json`), false) })));
const cells: MatrixCell[] = matrixCells(state.seedBase);
const matrix = await Promise.all(cells.map(async (c) => ({ target: c.target, model: c.model, condition: c.condition, ...cellRow(c.cellId, await read(`cell-${c.cellId}.json`), true) })));
const builds: Record<string, Rec | null> = { H: await read("build-H.json"), M: await read("build-M.json"), "H.r2": await read("build-H.r2.json"), "M.r2": await read("build-M.r2.json"), "H.r3": await read("build-H.r3.json"), "M.r3": await read("build-M.r3.json") };
const frozen = await read("frozen.json");
const adapt: Record<string, Rec | null> = { far: await read("adapt-far.json"), cold: await read("adapt-cold.json") };
for (const f of files.filter((x) => /^adapt-(far|cold)\.r\d+\.json$/.test(x)).sort()) adapt[f.replace(/^adapt-|\.json$/g, "")] = await read(f);
const meterDir = path.join(BDIR, "meters");
const meters: Record<string, unknown> = {};
if (existsSync(meterDir)) for (const f of await fs.readdir(meterDir)) if (f.endsWith(".json") && !f.includes(".tmp-")) meters[f.replace(/\.json$/, "")] = JSON.parse(await fs.readFile(path.join(meterDir, f), "utf8"));

const sum = (rows: Array<{ usage: { input: number; output: number; piCost: number } }>) => rows.reduce((a, r) => ({ input: a.input + r.usage.input, output: a.output + r.usage.output, piCostEstimateUsd: Math.round((a.piCostEstimateUsd + r.usage.piCost) * 1e4) / 1e4 }), { input: 0, output: 0, piCostEstimateUsd: 0 });
const buildTokens = (b: Rec | null) => (b ? { promptTokens: b.usage?.promptTokens ?? 0, completionTokens: b.usage?.completionTokens ?? 0, wallMs: b.wallMs } : null);
const summary: Record<string, Record<string, string>> = {};
for (const t of ["A", "C", "D", "CD"]) {
  summary[t] = {};
  for (const cond of ["cold", "H", "M"]) {
    const rows = matrix.filter((r) => r.target === t && r.condition === cond);
    const scored = rows.filter((r) => ["SUCCESS", "PARTIAL", "FAIL", "ERROR"].includes(r.outcome));
    // Primary denominator = all predeclared cells in the group (missing/infra/invalid/unavailable count as non-success).
    const successes = rows.filter((r) => r.outcome === "SUCCESS").length;
    summary[t][cond] = `${successes}/${rows.length} exact (scored-only ${successes}/${scored.length}; non-scored: ${rows.filter((r) => !scored.includes(r)).map((r) => `${r.model}:${r.outcome}`).join(",") || "none"})`;
  }
}
const aborted = await Promise.all((values.aborted ?? []).map(async (b) => {
  const d = path.join(REPO, ".context/crm-batches", b, "results");
  const fs2 = existsSync(d) ? (await fs.readdir(d)).filter((f) => f.startsWith("train-") || f.startsWith("cell-")) : [];
  return { batch: b, reason: "aborted batch preserved (see .context/crm-eval-progress.md)", records: await Promise.all(fs2.map(async (f) => { const r = JSON.parse(await fs.readFile(path.join(d, f), "utf8")); return cellRow(f.replace(/\.json$/, ""), r, false); })) };
}));

// ------------------------------------------------------------------ facts DERIVED from records (no hard-coded outcomes)
const perCondition = Object.fromEntries(["cold", "H", "M"].map((c) => { const rows = matrix.filter((r) => r.condition === c); return [c, `${rows.filter((r) => r.outcome === "SUCCESS").length}/${rows.length}`]; }));
const nonSuccess = matrix.filter((r) => r.outcome !== "SUCCESS").map((r) => `${r.id} (${r.outcome}, stop=${r.stoppedBy ?? "-"})`);
const penaltyCells = matrix.filter((r) => (r.unintendedWrites ?? 0) > 0).length;
const wrongCrmCells = matrix.filter((r) => (r.wrongCrmMutations ?? 0) > 0).length;
// Empty `query` objects in raw stored tool-call args, per model (matrix + training cell records).
const emptyQuery: Record<string, { empty: number; total: number }> = {};
for (const f of files.filter((x) => /^(cell|train)-.*\.json$/.test(x))) {
  const r = await read(f);
  for (const c of (r?.storedTrace?.toolCalls ?? []) as Rec[]) {
    if (!String(c.name).endsWith("_request") || !c.args || typeof c.args !== "object" || !("query" in c.args)) continue;
    const e = (emptyQuery[r.model] ??= { empty: 0, total: 0 });
    e.total += 1;
    if (c.args.query == null || (typeof c.args.query === "object" && Object.keys(c.args.query).length === 0) || c.args.query === "") e.empty += 1;
  }
}
// Publication facts from durable adaptation records (seed receipts + post-build integration records).
const publication = Object.entries(adapt).map(([k, a]) => {
  const seededPublish = ((a?.seeded ?? []) as Rec[]).filter((x) => x.receipts?.integration_publish).map((x) => x.slug);
  const live = Object.entries((a?.integrations?.after ?? {}) as Record<string, Rec>).filter(([, v]) => v?.active).map(([sl, v]) => ({ slug: sl, deploymentId: v.active.deploymentId, mcpUrl: v.mcpUrl ?? null }));
  return { variant: k, seededPublish, liveAfterBuild: live, error: a?.error ? String(a.error).split("\n")[0]!.slice(0, 200) : null };
});
const anyPublished = publication.some((p) => p.seededPublish.length || p.liveAfterBuild.length);

const report = {
  kind: "crm-generalization-report",
  batch: BATCH,
  generatedAt: new Date().toISOString(),
  head: state.head,
  labels: {
    scope: "EXPLORATORY: one sample per cell; no statistical significance is claimed. Differences between single cells may be noise.",
    models: "REAL Fireworks models (kimi-k3, glm-5p3, minimax-m3) in Pi 1.3 sessions; real memory builds (runMemoryBuild, Kimi root, Modal workspaces).",
    crms: "SYNTHETIC CONTRACT FIXTURES of documented HubSpot/Pipedrive/Zoho CRM v8/Attio v2 API subsets. Not vendor accounts; passing is not an integration certification.",
    transport: `Matrix/training adapters: host-authored children over real MCP on loopback (LOCAL TEST PUBLISHER, not Manufact). Adaptation demos publish via Manufact; in the adaptation records of THIS batch, Manufact-published CRM children: ${anyPublished ? publication.flatMap((p) => [...p.seededPublish.map((s) => `${p.variant}:${s}(seed)`), ...p.liveAfterBuild.map((l) => `${p.variant}:${l.slug}`)]).join(", ") : "NONE"} (derived from seed receipts and post-build integration records).`,
    scoring: "Primary success = host fixture oracle on full initial/final state + mutation log (reverted forbidden writes count). Answer-text evidence is secondary.",
    successDenominator: "Exact-success counts use ALL predeclared cells per target x memory condition (3 models) as denominator; missing, INFRA*, INVALID*, UNAVAILABLE-ARM and ERROR cells count as non-success. 'scored-only' rate (SUCCESS/PARTIAL/FAIL/ERROR cells) is secondary.",
    unintendedWrites: "COMPOSITE PENALTY, not a count of distinct records or physical write requests: wrongRecords + forbiddenMutations + wrongCrmMutations + createdOrDeleted (oracle field unintendedWrites, kept raw). One wrong record can contribute several points (e.g. 1 wrong record + 2 forbidden field mutations on the same deal = 3). Components in unintendedPenaltyComponents; shown as 'N (wr/fm/wc/cd)'.",
    foreignPatterns: "Per-row foreign-API-pattern counts are summed by pattern key across all CRM instances in the cell (per-instance raw counts remain in cell result files).",
  },
  manifest: { file: `reports/crm-matrix-manifest-${BATCH}.json`, head: manifest.head, createdAt: manifest.createdAt },
  provenance: {
    preregisteredHead: manifest.head,
    reportGeneratedAtHead: (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })(),
    frozenSourceHashes: (manifest as Rec).sources?.adapterFingerprints ?? null,
    limits: (manifest as Rec).limits ?? null,
    builderBudgetPrereg: (manifest as Rec).builderBudget ?? null,
    budgetsPrereg: (manifest as Rec).budgets ?? null,
    amendments: existsSync(path.join(BDIR, "amendments.json")) ? JSON.parse(await fs.readFile(path.join(BDIR, "amendments.json"), "utf8")) : {},
    batchNotes:
      BATCH === "crm2"
        ? {
            scope: "Operator notes recorded for batch crm2 ONLY (written after its rounds ran); not claims about any other batch or later variant. Derived facts elsewhere in this report are authoritative.",
            amendment: "attio-deficient seed overlay amended AFTER the crm2 matrix post-integrity check passed (that check is preserved as-is); the overlay is used only by far demos, never by matrix cells.",
            deviations: [
              "Round-1 H/M builds failed under maxSessions 1 / 15 min (preserved). Round 2 (declared before execution): maxSessions 2, 30 min, builder ceiling 30M/1.5M. H published in r2; M r2 failed with 'model_error: fetch failed' (recorded as infra) and was rerun as r3 with the r2 budget.",
              "adapt-cold variants: original, r2, r3, each in a fresh tenant; all preserved.",
              "adapt-far original and r2 aborted during host seeding (see adaptation records); quota not raised and no existing Manufact project deleted or repurposed during these crm2 rounds.",
              "Matrix/training limits stayed at the preregistered caps; later 100x-limit steering applies only to runs after these rows.",
            ],
          }
        : null,
  },
  publication,
  observations: [
    `Exploratory, one sample per cell. Exact successes by memory condition (all targets): cold ${perCondition.cold}, H ${perCondition.H}, M ${perCondition.M}.`,
    `Non-success cells: ${nonSuccess.length ? nonSuccess.join("; ") : "none"}.`,
    `Cells with any unintended-write penalty: ${penaltyCells}; cells with wrong-CRM writes: ${wrongCrmCells}.`,
    `Observed (raw stored tool-call args): adapter \`query\` objects sent empty per model: ${Object.entries(emptyQuery).map(([m, v]) => `${m} ${v.empty}/${v.total}`).join(", ") || "n/a"}. OBSERVATIONAL ONLY: correlated with the model/transport path (MiniMax uses Pi's Anthropic-messages path, Kimi/GLM openai-completions) and the open-record \`query\` schema, but the cause (model behavior vs. schema handling vs. provider) is NOT established. Where it occurs it is a potential confound shared by every condition of that model; it is not a memory effect by itself.`,
    `Adaptation variants recorded: ${publication.map((p) => `${p.variant}: ${p.error ? `aborted (${p.error.slice(0, 90)})` : "ran"}`).join("; ")}. Task success and mechanism gates are reported per variant below.`,
  ],
  integrity: { matrixIntegrityOk, anyIntegrityFailure: integrityFailed, checks: integrity.map((i) => ({ file: i.file, ok: i.ok, problems: (i.problems ?? []).slice(0, 10) })) },
  training,
  builds: Object.fromEntries(Object.entries(builds).map(([k, b]) => [k, b && { status: b.status, budget: b.budget ?? "round-1 declared budget", revisionBefore: b.revisionBefore, revisionAfter: b.revisionAfter, failure: (b.receipts ?? []).map((r: Rec) => r.error ?? null), agents: b.agents?.map((a: Rec) => ({ agentId: a.agentId, model: a.model, depth: a.depth, status: a.status, turns: a.turns, toolCalls: a.toolCalls })), tokens: buildTokens(b), traceArchive: b.traceArchive }])),
  frozen,
  matrix,
  matrixSummary: summary,
  targets: Object.fromEntries(Object.entries(EVAL_TARGETS).map(([k, v]) => [k, v.role])),
  cost: {
    note: "Tokens from provider usage reported to Pi / the builder client. Pi cost = Pi catalog price ESTIMATE; builder calls have no cost field (UNAVAILABLE, not $0).",
    trainingCustomers: sum(training),
    heldoutMatrixCustomers: sum(matrix),
    builds: { ...Object.fromEntries(Object.entries(builds).map(([k, b]) => [k, buildTokens(b)])), ...Object.fromEntries(Object.entries(adapt).map(([k, a]) => [k, buildTokens(a?.build ?? null)])) },
    meters,
  },
  adaptation: Object.fromEntries(
    Object.entries(adapt).map(([k, a]) => [
      k,
      a
        ? a.unavailable
          ? { unavailable: a.unavailable }
          : {
              labels: a.labels,
              error: a.error ?? null,
              task: a.task,
              taskSuccessAttempt1: a.attempts?.[0]?.scoreCumulative?.success ?? null,
              taskSuccessAttempt2Cumulative: a.attempts?.[1]?.scoreCumulative?.success ?? null,
              attempt2DeltaSuccess: a.attempts?.[1]?.scoreDelta?.success ?? null,
              attempts: (a.attempts ?? []).map((x: Rec) => ({ runId: x.result?.runId, stoppedBy: x.result?.stoppedBy, toolCallsByName: x.result?.toolCallsByName, correct: `${x.scoreCumulative?.correct}/${x.scoreCumulative?.eligible}`, unintendedWrites: x.scoreCumulative?.unintendedWrites, unintendedPenaltyComponents: x.scoreCumulative ? { wrongRecords: x.scoreCumulative.wrongRecords ?? null, forbiddenMutations: x.scoreCumulative.forbiddenMutations ?? null, wrongCrmMutations: x.scoreCumulative.wrongCrmMutations ?? null, createdOrDeleted: x.scoreCumulative.createdOrDeleted ?? null } : null, tagLoss: x.scoreCumulative?.tagLoss, usage: x.result?.usage, traceOk: x.storedTrace ? x.storedTrace.correlationCheck?.ok && x.storedTrace.sequenceComplete : false, finalPreview: String(x.result?.finalText ?? "").slice(0, 500) })),
              mechanismSuccess: a.mechanismSuccess ?? false,
              proofGates: a.proofGates ?? null,
              readiness: a.readiness,
              sessionProof: a.sessionProof && { piSessionId: a.sessionProof.piSessionId, conversationId: a.sessionProof.conversationId, sameObject: a.sessionProof.sameObject, prefix: a.sessionProof.prefixAfterAttempt1, prefixAfterAttempt2: a.sessionProof.samePrefixAfterAttempt2, detectedBy: a.sessionProof.detectedBy, toolsChanged: a.sessionProof.toolsChanged },
              memory: { before: a.memory?.before, afterAttempt1: a.memory?.afterAttempt1, afterBuild: a.memory?.afterBuild, changedFiles: a.memory?.changedFiles },
              integrations: { before: a.integrations?.before, after: a.integrations?.after, changedSources: Object.fromEntries(Object.entries(a.integrations?.sourceDiffs ?? {}).map(([s, d]) => [s, (d as Rec).changed])) },
              build: a.build && { status: a.build.status, agents: a.build.agents?.map((x: Rec) => ({ agentId: x.agentId, model: x.model, status: x.status, turns: x.turns, toolCalls: x.toolCalls })), traceArchive: a.build.traceArchive },
              regressions: a.regressions,
              freshness: a.freshness,
              fixtures: a.fixtures,
            }
        : { missing: true },
    ]),
  ),
  abortedBatches: aborted,
};

const md: string[] = [];
md.push(`# CRM generalization benchmark — batch ${BATCH}`, "", `> ${report.labels.scope}`, `> ${report.labels.crms}`, `> ${report.labels.models}`, `> ${report.labels.transport}`, "");
md.push(`HEAD \`${state.head}\`; manifest \`${report.manifest.file}\`. Matrix integrity (pre+post frozen adapters/fixtures/docs): **${matrixIntegrityOk ? "OK" : "FAILED/INCOMPLETE — matrix cells INVALID"}**.`, "");
md.push("## Provenance", "", `- Preregistered HEAD \`${report.provenance.preregisteredHead}\`; report generated at HEAD \`${report.provenance.reportGeneratedAtHead}\`.`, `- Limits: ${JSON.stringify(report.provenance.limits)}; builder budget prereg ${JSON.stringify(report.provenance.builderBudgetPrereg)}.`, `- Amendments: ${JSON.stringify(Object.keys(report.provenance.amendments))}`, ...(report.provenance.batchNotes ? [`- ${report.provenance.batchNotes.scope}`, `- ${report.provenance.batchNotes.amendment}`, ...report.provenance.batchNotes.deviations.map((d) => `- DEVIATION (crm2): ${d}`)] : []), "", "## Observations and confounds (read before the tables)", "", ...report.observations.map((o) => `- ${o}`), "");
md.push("## Training (8 sessions; traces only into crmtr-h / crmtr-m)", "", "| id | curriculum | model | family | target | outcome | correct | unintended penalty (wr/fm/wc/cd) | stop | tools | tokens in/out |", "|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of training) md.push(`| ${r.id} | ${r.curriculum} | ${r.model} | ${r.family} | ${r.target} | ${r.outcome} | ${r.correct} | ${penaltyCell(r)} | ${r.stoppedBy ?? "-"} | ${r.toolCalls ?? "-"} | ${r.usage.input}/${r.usage.output} |`);
md.push("", "## Memory builds (real runMemoryBuild, integrations OFF)", "");
for (const [k, b] of Object.entries(report.builds)) md.push(`- **${k}**: ${b ? `${b.status}; ${b.revisionBefore} → ${b.revisionAfter}; agents ${b.agents?.length}; tokens ${JSON.stringify(b.tokens)}` : "MISSING"}`);
md.push("", `Frozen arms: ${JSON.stringify(frozen)}`, "");
md.push("## Scored transfer matrix (36 cells, one sample each)", "", `> Unintended penalty: ${report.labels.unintendedWrites}`, "", "| target | model | memory | outcome | correct | unintended penalty (wr/fm/wc/cd) | tag loss | wrong-CRM writes | stop | tools | API errors | foreign patterns | memory calls | tokens in/out | trace |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of matrix) md.push(`| ${r.target} | ${r.model} | ${r.condition} | ${r.outcome} | ${r.correct} | ${penaltyCell(r)} | ${r.tagLoss ?? "-"} | ${r.wrongCrmMutations ?? "-"} | ${r.stoppedBy ?? "-"} | ${r.toolCalls ?? "-"} | ${r.apiErrors ?? "-"} | ${Object.entries(r.foreignPatterns).map(([k, v]) => `${k}×${v}`).join(" ") || "-"} | ${r.memoryCalls} | ${r.usage.input}/${r.usage.output} | ${r.traceOk === null ? "-" : r.traceOk ? "ok" : "BAD"} |`);
md.push("", "### Exact-success counts per target × memory condition (exploratory, n=3 predeclared cells each)", "", `> ${report.labels.successDenominator}`, "", "| target | cold | H | M |", "|---|---|---|---|");
for (const [t, row] of Object.entries(summary)) md.push(`| ${t} (${EVAL_TARGETS[t as keyof typeof EVAL_TARGETS].role}) | ${row.cold} | ${row.H} | ${row.M} |`);
md.push("", "## Cost (training vs held-out separately)", "", "```json", JSON.stringify(report.cost, null, 1), "```", "");
md.push("## Same-session adaptation demonstrations", "");
for (const [k, a] of Object.entries(report.adaptation) as Array<[string, Rec]>) {
  md.push(`### ${k}`, "");
  if (a.missing || a.unavailable) {
    md.push(a.missing ? "MISSING (not run)" : `UNAVAILABLE: ${a.unavailable}`, "");
    continue;
  }
  if (a.error && !(a.attempts ?? []).length) md.push(`**Outcome: INFRA-SETUP (no customer model call, no builder).** ${a.error.split("\n")[0]!.slice(0, 400)}`, "");
  else if (a.error) md.push(`**ERROR:** ${a.error.slice(0, 600)}`, "");
  md.push(`- Task success (host oracle): attempt 1 = **${a.taskSuccessAttempt1}**, attempt 2 cumulative = **${a.taskSuccessAttempt2Cumulative}** (delta-only ${a.attempt2DeltaSuccess}).`, `- Mechanism (all proof gates): **${a.mechanismSuccess}** — reported separately from task success.`, `- Readiness: ${a.readiness?.detectedBy}; ready ${JSON.stringify(a.readiness?.readySlugs)}`, `- Memory: ${a.memory.afterAttempt1} → ${a.memory.afterBuild} (${a.memory.changedFiles?.length ?? 0} files)`, `- Integration source changes: ${JSON.stringify(a.integrations.changedSources)}`, "");
  md.push("| gate | ok | detail |", "|---|---|---|");
  for (const [g, v] of Object.entries(a.proofGates ?? {}) as Array<[string, Rec]>) md.push(`| ${g} | ${v.ok ? "yes" : "**NO**"} | ${JSON.stringify(v.detail ?? "").replace(/\|/g, "/").slice(0, 220)} |`);
  md.push("", "| attempt | stop | correct | unintended penalty (wr/fm/wc/cd) | tag loss | trace ok | tool calls |", "|---|---|---|---|---|---|---|");
  a.attempts.forEach((x: Rec, i: number) => md.push(`| ${i + 1} | ${x.stoppedBy} | ${x.correct} | ${penaltyCell({ unintendedWrites: x.unintendedWrites ?? null, unintendedPenaltyComponents: x.unintendedPenaltyComponents ?? null })} | ${x.tagLoss} | ${x.traceOk} | ${JSON.stringify(x.toolCallsByName).replace(/\|/g, "/").slice(0, 300)} |`));
  md.push("");
}
if (aborted.length) {
  md.push("## Aborted batches (preserved, not merged into results)", "");
  for (const b of aborted) md.push(`- ${b.batch}: ${b.reason}; records: ${b.records.map((r) => `${r.id}=${r.outcome}`).join(", ")}`);
}
const json = scrub(JSON.stringify(report, null, 1));
const mdText = scrub(md.join("\n"));
assertNoSecrets(json, "report json");
assertNoSecrets(mdText, "report md");
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const cls: Record<string, string> = { SUCCESS: "#c8f7c5", PARTIAL: "#fff3b0", FAIL: "#ffc9c9", ERROR: "#ffc9c9" };
const grid = ["A", "C", "D", "CD"].map((t) => `<tr><th>${t}<br><small>${esc(EVAL_TARGETS[t as keyof typeof EVAL_TARGETS].role)}</small></th>${["kimi", "glm", "minimax"].map((m) => ["cold", "H", "M"].map((c) => { const r = matrix.find((x) => x.target === t && x.model === m && x.condition === c)!; return `<td style="background:${cls[r.outcome] ?? "#ddd"}" title="${esc(JSON.stringify({ correct: r.correct, unintendedPenalty: r.unintendedWrites, penaltyComponents: r.unintendedPenaltyComponents, stop: r.stoppedBy, error: r.error }))}">${r.outcome}<br><small>${r.correct} · pen${r.unintendedWrites ?? "-"}</small></td>`; }).join("")).join("")}</tr>`).join("");
const html = `<!doctype html><meta charset="utf-8"><title>CRM benchmark ${BATCH}</title><style>body{font:14px system-ui;margin:24px;max-width:1400px}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 6px;font-size:12px;text-align:center}pre{white-space:pre-wrap;background:#f6f6f6;padding:8px}</style>
<h1>CRM generalization benchmark — ${BATCH}</h1><p><b>${esc(report.labels.scope)}</b><br>${esc(report.labels.crms)}<br>${esc(report.labels.models)}<br>${esc(report.labels.transport)}</p>
<p>Matrix integrity: <b>${matrixIntegrityOk ? "OK" : "FAILED/INCOMPLETE (cells invalid)"}</b></p><p><small>Cell: outcome, correct/eligible · pen = ${esc(report.labels.unintendedWrites)}</small></p>
<table><tr><th rowspan=2>target</th><th colspan=3>kimi</th><th colspan=3>glm</th><th colspan=3>minimax</th></tr><tr>${"<th>cold</th><th>H</th><th>M</th>".repeat(3)}</tr>${grid}</table>
<h2>Full report (markdown)</h2><pre>${esc(mdText)}</pre>`;
await fs.writeFile(path.join(REPO, `reports/crm-matrix-${BATCH}.json`), `${json}\n`);
await fs.writeFile(path.join(REPO, `reports/crm-matrix-${BATCH}.md`), `${mdText}\n`);
await fs.writeFile(path.join(REPO, `reports/crm-matrix-${BATCH}.html`), html);
console.log(`wrote reports/crm-matrix-${BATCH}.{json,md,html}; matrix outcomes: ${JSON.stringify(Object.fromEntries([...new Set(matrix.map((r) => r.outcome))].map((o) => [o, matrix.filter((r) => r.outcome === o).length])))}`);
