// @ts-nocheck
// Finance MCP AP actions (writes): submit the proposed payment run and ask the CFO for sign-offs. Spliced after
// tools.fragment.ts; uses computeRun, readRunDate and billView from it. In scope: server, z, sys, load, cache, ok, tracked, brief, caveatsFor, META.

if (META.tools.includes("submit_payment_run")) server.tool({
  name: "submit_payment_run",
  description: "Submit the proposed AP payment run (exactly what payment_run shows for that date) to the ERP for the controller to release. Nothing is paid until it is released. Safe to retry: one proposal per run date.",
  inputSchema: z.object({ run_date: z.string().optional().describe("ISO date of the run; defaults to the next unpaid run (same as payment_run)") }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, tracked("submit_payment_run", async ({ run_date }) => {
  const d = await load();
  const r = computeRun(d, readRunDate(d, run_date));
  const res = await sys.post("/erp/payment_runs/proposals", { run_date: new Date(r.runAt).toISOString(), bill_ids: r.pay.map((b) => b.id), total_usd: r.total, prepared_by: "walter-finance-mcp",
    held: [...r.held.map((b) => ({ bill_id: b.id, reason: `held by ${b.held_by.join(", ")}` })), ...r.unpaid.map((b) => ({ bill_id: b.id, reason: "no payment rule covers it yet" }))] });
  if (res.status >= 300) throw new Error(`the ERP refused the proposal: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return ok({ proposal: { id: res.body.id, run_date: res.body.run_date.slice(0, 10), status: res.body.status, bills: res.body.bill_ids.length }, currency: "USD", total_usd: r.total, bill_count: r.pay.length, held_back: r.held.length, due_but_not_covered: r.unpaid.length,
    next: r.unpaid.length ? `${r.unpaid.length} due bills are not covered yet; if they need CFO sign-off, call request_cfo_approval with run_date ${new Date(r.runAt).toISOString().slice(0, 10)}.` : "Submitted. The controller releases it." });
}));

if (META.tools.includes("request_cfo_approval")) server.tool({
  name: "request_cfo_approval",
  description: "Ask GurtAI's CFO (Ana Torres) to sign off vendor bills that cannot be paid without a CFO sign-off (custbody_22). Pass run_date to request it for every due bill in that run that needs it (what payment_run lists under due_but_not_covered), or bills for specific ones. One request per bill; asking twice does not duplicate.",
  inputSchema: z.object({ run_date: z.string().optional().describe("ISO date of a payment run: request sign-off for every due bill in it that needs CFO sign-off"), bills: z.array(z.string()).optional().describe("bill ids or tranids (e.g. BILL-9123)"), reason: z.string().optional().describe("one line the CFO sees") }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, tracked("request_cfo_approval", async ({ run_date, bills, reason }) => {
  let ids = bills ?? [];
  if (!ids.length) {
    if (!run_date) throw new Error("pass run_date (every bill in that run that needs CFO sign-off) or bills");
    const d = await load();
    const r = computeRun(d, readRunDate(d, run_date));
    ids = r.unpaid.filter((b) => b.unlocks.some((u) => u.field === "custbody_22")).map((b) => b.id);
    if (!ids.length) return ok({ requested: 0, note: "no bill in that run needs CFO sign-off" });
  }
  const out = [];
  for (const id of ids) {
    const r = await sys.post("/erp/approval_requests", { bill_id: id, approver: "e-1", reason: reason ?? "needs CFO sign-off before the next payment run", requested_by: "walter-finance-mcp" });
    out.push(r.status < 300 ? { bill: id, request: r.body.id, status: r.body.status } : { bill: id, error: r.body?.["o:errorDetails"]?.[0]?.detail ?? `ERP returned ${r.status}` });
  }
  return ok({ requested: out.filter((x) => x.request).length, results: out });
}));
