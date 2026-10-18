/** Mail: GurtAI's shared support inbox (Gmail-style API plus a mailbox export with label/assignment history). */
import path from "node:path";
import type { Decision } from "../../mine/data.js";
import { HELD_OUT_FROM } from "../../mine/backtest.js";
import type { Domain, ReplayCase } from "../types.js";
import { asReceived, fetchData, makeCtx, type MailData } from "./runtime.js";
import { WALTER_DIR } from "../../paths.js";

const month = (iso: string) => iso.slice(0, 7);
const QUEUES = new Set(["Support", "Billing", "Automated"]);

function recorded(d: MailData) {
  const label = new Map<string, string>(), assignee = new Map<string, string>();
  for (const e of d.events) {
    if (e.type === "label_added" && QUEUES.has(e.value) && !label.has(e.thread_id)) label.set(e.thread_id, e.value);
    if (e.type === "assigned" && !assignee.has(e.thread_id)) assignee.set(e.thread_id, e.value);
  }
  return { label, assignee };
}

export const mail: Domain<MailData> = {
  id: "mail",
  name: "GurtAI Support Inbox MCP",
  title: "GurtAI's shared support inbox support@gurtai.example (Gmail-style API) and its mailbox export: threads, labels, assignments, replies",
  description: "GurtAI's support inbox with the team's own triage rules built in. Use it to know how an incoming email is labelled, who owns it and whether anyone will reply.",
  systems: ["Gmail (support@)", "mailbox export"],
  integrations: [["gurtai-mail.md", "Gmail support@", "Gmail API · read only", "GURTAI_TOKEN"], ["gurtai-mail-export.md", "Mailbox export", "label & assignment history", "GURTAI_TOKEN"]],
  mdFile: "gurtai-mail.md",
  dir: path.join(WALTER_DIR, "domains", "mail"),
  fetchData, makeCtx,
  ctxHelp: 'ctx.domainOf(email) -> "kraftwerk.de", ctx.localOf(email) -> "noreply", ctx.users -> [{ email, name, team }]',

  kinds: {
    thread_label: {
      description: "When an email reached support@, which queue label did the team put on it (Support, Billing or Automated)?",
      signature: "(thread, ctx) where thread = { id, from, to, subject, snippet, received_at } as it arrived",
      returns: 'the label name as a string, e.g. "Support"', unit: "threads",
    },
    thread_assignee: {
      description: "Who was the thread assigned to (the person who answers it)? Threads nobody was assigned to count as \"none\".",
      signature: "(thread, ctx) where thread = { id, from, to, subject, snippet, received_at } as it arrived",
      returns: 'an email address, or "none"', unit: "threads",
    },
  },

  decisions(d): Decision[] {
    const { label, assignee } = recorded(d);
    const out: Decision[] = [];
    for (const t of d.threads) {
      const m = month(t.received_at);
      if (label.has(t.id)) out.push({ kind: "thread_label", month: m, key: t.id, args: [asReceived(t)], recorded: label.get(t.id) });
      out.push({ kind: "thread_assignee", month: m, key: t.id, args: [asReceived(t)], recorded: assignee.get(t.id) ?? "none" });
    }
    return out;
  },

  async describe(d, c) {
    return {
      endpoints: ["GET /mail/gmail/v1/users/me/threads?q&labelIds&maxResults&pageToken", "GET /mail/gmail/v1/users/me/threads/{id}", "GET /mail/gmail/v1/users/me/labels", "GET /mail/export/tables", "GET /mail/export/threads?limit&after", "GET /mail/export/events?type&thread_id&limit&after", "GET /mail/export/users"],
      counts: { threads: d.threads.length, events: d.events.length },
      labels: d.labels, users: d.users,
      tables: (await c.get("/mail/export/tables")).body,
      sample_thread: d.threads[5],
      analyze_data: "data = { threads, events, users, labels }",
    };
  },

  tools: [
    { name: "triage_email", sig: "triage_email(from, subject)", d: "Label, owner and whether anyone replies", kinds: ["thread_label", "thread_assignee"], task: "Inbox triage, as the team did it" },
  ],

  async replay(mcp, d) {
    const out: ReplayCase[] = [];
    if (!mcp.tools.some((t) => t.name === "triage_email")) return out;
    const { label, assignee } = recorded(d);
    const step = Math.max(1, Math.floor(d.threads.length / 110));
    for (let i = 0; i < d.threads.length; i += step) {
      const t = d.threads[i]!;
      const r = await mcp.call("triage_email", { from: t.from, subject: t.subject, snippet: t.snippet, received_at: t.received_at });
      const want = `${label.get(t.id)} → ${assignee.get(t.id) ?? "none"}`, got = r.data ? `${r.data.label} → ${r.data.assignee ?? "none"}` : r.text.slice(0, 120);
      out.push({ tool: "triage_email", month: month(t.received_at), heldOut: month(t.received_at) >= HELD_OUT_FROM, label: `${t.from}: ${t.subject}`, expected: want, got, ok: want === got });
    }
    return out;
  },
};
