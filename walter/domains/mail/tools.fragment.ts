// @ts-nocheck
// Support inbox MCP tools, spliced into compile/server.template.ts. In scope: server, z, load, rulesOf, cases, brief, caveatsFor, ok, tracked, META.

if (META.tools.includes("triage_email")) server.tool({
  name: "triage_email",
  description: "How GurtAI's support team handles an incoming email to support@: which queue label it gets, who owns it, and whether anyone will reply. Applies the team's actual triage rules.",
  inputSchema: z.object({ from: z.string().describe("sender email address"), subject: z.string(), snippet: z.string().optional(), received_at: z.string().optional().describe("ISO datetime; defaults to now") }),
  annotations: { readOnlyHint: true },
}, tracked("triage_email", async ({ from, subject, snippet, received_at }) => {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from.trim())) throw new Error(`"${from}" is not an email address; pass the sender's full address`);
  const d = await load();
  const thread = { id: "new", from: from.trim().toLowerCase(), to: "support@gurtai.example", subject, snippet: snippet ?? "", received_at: received_at ?? new Date().toISOString() };
  const lr = cases("thread_label"), ar = cases("thread_assignee");
  const lv = lr ? lr.fn(thread, d.ctx) : null, label = lv == null ? null : String(lv);
  const who = ar ? ar.fn(thread, d.ctx) : null;
  const assignee = who != null && who !== "none" ? String(who) : null;
  const person = assignee ? d.users.find((u) => u.email === assignee) : null;
  return ok({ label, assignee, assignee_name: person?.name ?? null, team: person?.team ?? null, reply_expected: !!assignee,
    rules: [lr, ar].filter(Boolean).map(brief), caveats: caveatsFor(["thread_label", "thread_assignee"]) });
}));
