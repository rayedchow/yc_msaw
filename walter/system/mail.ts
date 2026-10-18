/**
 * GurtAI's support inbox: a deterministic, simulated Gmail-style shared mailbox (support@gurtai.example) with
 * ~22 months of history.
 *
 * Rules the support team follows (only visible in what people did):
 *   label      automated senders (noreply@, no-reply@, notifications@, alerts@, mailer-daemon@) → "Automated", even if
 *              the subject says receipt or invoice; otherwise a subject about invoice/refund/receipt/charge/billing →
 *              "Billing"; everything else → "Support"
 *   assignee   Automated → nobody (archived, never answered); Billing → dana@ (Finance); Support → lena@ when the
 *              sender's domain is European (.de .fr .nl .es .it .se .co.uk .ie), otherwise sam@.
 *              From 2026-08-01 Billing goes to omar@ (new AR hire) instead of dana@.
 */
import { DAY, exportPage, iso, mulberry32, NOW, START, type Res } from "./common.js";

export const MAIL_USERS = [
  { email: "sam@gurtai.example", name: "Sam Rivera", team: "Support (Americas/APAC)" },
  { email: "lena@gurtai.example", name: "Lena Vogel", team: "Support (EMEA)" },
  { email: "dana@gurtai.example", name: "Dana Kim", team: "Finance" },
  { email: "omar@gurtai.example", name: "Omar Haddad", team: "Finance (AR)" },
];
export const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" }, { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "Label_11", name: "Support", type: "user" }, { id: "Label_12", name: "Billing", type: "user" }, { id: "Label_13", name: "Automated", type: "user" },
  { id: "Label_14", name: "Escalated", type: "user" },
];
export const MAIL_TRUTH = { omarFrom: "2026-08-01", eu: [".de", ".fr", ".nl", ".es", ".it", ".se", ".co.uk", ".ie"] };

export interface Thread { id: string; from: string; to: string; subject: string; snippet: string; received_at: string; labels: string[]; assignee: string | null; replied_at: string | null }
export interface MailEvent { thread_id: string; type: "label_added" | "assigned" | "replied" | "archived"; value: string; at: string; by: string }
export interface MailWorld { threads: Thread[]; events: MailEvent[] }

const PEOPLE = ["alex", "jordan", "mika", "sofia", "noah", "emma", "liam", "yuki", "aarav", "chloe", "lucas", "mia", "felix", "ines", "omar.k", "zoe"];
const DOMAINS = ["initech.com", "hooli.io", "globex.com", "acmeanalytics.io", "pied.io", "vandelay.com", "umbrella.co", "soylent.app",
  "siemensdata.de", "kraftwerk.de", "baguette.fr", "lumiere.fr", "dutchbyte.nl", "tulpen.nl", "sevilla.es", "milano.it", "nordisk.se", "brexit.co.uk", "harbour.co.uk", "emerald.ie",
  "kangaroo.com.au", "sakura.jp", "merlion.sg", "bollywood.in", "maple.ca", "samba.com.br"];
const AUTOMATED = ["noreply@stripe.com", "notifications@github.com", "no-reply@zoom.us", "mailer-daemon@googlemail.com", "alerts@datadoghq.com", "noreply@docusign.net"];
const SUPPORT_SUBJECTS = ["Can't log in after SSO change", "API rate limit questions", "Export to CSV failing", "How do I add a teammate?", "Webhook not firing", "Dashboard loads slowly",
  "Feature request: dark mode", "Error 500 on reports page", "Password reset email not arriving", "Integration with Salesforce", "Data retention policy?", "Bulk import stuck at 90%"];
const BILLING_SUBJECTS = ["Invoice #INV-%n has the wrong VAT number", "Refund request for duplicate seat", "We were charged twice this month", "Need a receipt for %m", "Billing contact change",
  "Question about invoice INV-%n", "Card charge declined, please retry", "Update our billing address"];
const AUTO_SUBJECTS = ["Your receipt from GurtAI #%n", "Invoice INV-%n payment succeeded", "[GitHub] A new SSH key was added", "Zoom meeting recording available", "Delivery Status Notification (Failure)",
  "[Datadog] Monitor alert: API latency", "Envelope completed: MSA renewal", "Your refund has been processed"];

export function generateMail(seed = 4242): MailWorld {
  const r = mulberry32(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const threads: Thread[] = [];
  const events: MailEvent[] = [];
  const omarFrom = Date.parse(MAIL_TRUTH.omarFrom);
  let n = 0;
  for (let day = START; day < NOW - DAY; day += DAY) {
    const count = Math.floor(r() * 4) + (new Date(day).getUTCDay() % 6 === 0 ? 0 : 1);
    for (let k = 0; k < count; k++) {
      const t = day + Math.floor(r() * DAY);
      const kind = r();
      const auto = kind < 0.2, billing = !auto && kind < 0.45;
      const from = auto ? pick(AUTOMATED) : `${pick(PEOPLE)}@${pick(DOMAINS)}`;
      const subj = (auto ? pick(AUTO_SUBJECTS) : billing ? pick(BILLING_SUBJECTS) : pick(SUPPORT_SUBJECTS))
        .replace("%n", String(4000 + Math.floor(r() * 6000))).replace("%m", new Date(t).toLocaleString("en", { month: "long", timeZone: "UTC" }));
      const id = (0x18a000000 + n++ * 7919).toString(16);
      const label = auto ? "Automated" : billing ? "Billing" : "Support";
      const eu = MAIL_TRUTH.eu.some((tld) => from.endsWith(tld));
      const assignee = auto ? null : billing ? (t >= omarFrom ? "omar@gurtai.example" : "dana@gurtai.example") : eu ? "lena@gurtai.example" : "sam@gurtai.example";
      const triager = new Date(t).getUTCHours() < 12 ? "lena@gurtai.example" : "sam@gurtai.example";
      const th: Thread = { id, from, to: "support@gurtai.example", subject: subj, snippet: snippetFor(subj, r), received_at: iso(t), labels: ["INBOX"], assignee, replied_at: null };
      const lt = t + Math.floor((5 + r() * 90) * 60_000);
      events.push({ thread_id: id, type: "label_added", value: label, at: iso(lt), by: triager });
      th.labels.push(label);
      if (auto) {
        events.push({ thread_id: id, type: "archived", value: "INBOX", at: iso(lt + 60_000), by: triager });
        th.labels = th.labels.filter((x) => x !== "INBOX");
      } else {
        events.push({ thread_id: id, type: "assigned", value: assignee!, at: iso(lt + 60_000), by: triager });
        const rt = lt + Math.floor((0.5 + r() * 20) * 3_600_000);
        if (rt < NOW) { events.push({ thread_id: id, type: "replied", value: assignee!, at: iso(rt), by: assignee! }); th.replied_at = iso(rt); }
      }
      if (!auto && r() < 0.03) { events.push({ thread_id: id, type: "label_added", value: "Escalated", at: iso(lt + 2 * DAY), by: assignee! }); th.labels.push("Escalated"); }
      threads.push(th);
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { threads, events };
}

function snippetFor(subject: string, r: () => number): string {
  const opener = ["Hi team,", "Hello,", "Hey GurtAI,", "Good morning,", "Hi there,"][Math.floor(r() * 5)];
  return `${opener} ${subject.toLowerCase().replace(/^\[[^\]]+\]\s*/, "")} — could you take a look? Thanks`;
}

const labelId = (name: string) => LABELS.find((l) => l.name === name)?.id ?? name;
const headers = (t: Thread) => [{ name: "From", value: t.from }, { name: "To", value: t.to }, { name: "Subject", value: t.subject }, { name: "Date", value: new Date(t.received_at).toUTCString() }];

export class MailSystem {
  readonly world = generateMail();
  handle(method: string, p: string, q: Record<string, string>): Res {
    if (method !== "GET") return { status: 405, body: { error: { code: 405, message: "Method not allowed" } } };
    const base = "/mail/gmail/v1/users/me";
    let m: RegExpMatchArray | null;
    if (p === `${base}/labels`) return { status: 200, body: { labels: LABELS } };
    if (p === `${base}/threads`) {
      let rows = this.world.threads;
      if (q.labelIds) rows = rows.filter((t) => q.labelIds!.split(",").every((l) => t.labels.map(labelId).includes(l)));
      if (q.q) for (const term of q.q.match(/(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) ?? []) {
        const [k, v0] = term.includes(":") ? [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)] : ["", term];
        const v = v0!.replace(/"/g, "").toLowerCase();
        rows = rows.filter((t) => k === "from" ? t.from.includes(v) : k === "subject" ? t.subject.toLowerCase().includes(v) : k === "after" ? t.received_at.slice(0, 10).replace(/-/g, "/") >= v : k === "before" ? t.received_at.slice(0, 10).replace(/-/g, "/") < v : `${t.subject} ${t.snippet}`.toLowerCase().includes(v));
      }
      const max = Math.max(1, Math.min(Number(q.maxResults ?? 100), 500));
      const off = Number(q.pageToken ?? 0);
      const pg = rows.slice(off, off + max);
      return { status: 200, body: { threads: pg.map((t) => ({ id: t.id, snippet: t.snippet, historyId: String(1000 + this.world.threads.indexOf(t)) })), resultSizeEstimate: rows.length, ...(off + pg.length < rows.length ? { nextPageToken: String(off + pg.length) } : {}) } };
    }
    if ((m = p.match(new RegExp(`^${base}/threads/([0-9a-f]+)$`)))) {
      const t = this.world.threads.find((x) => x.id === m![1]);
      if (!t) return { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } };
      const msgs = [{ id: t.id, threadId: t.id, labelIds: t.labels.map(labelId), snippet: t.snippet, internalDate: String(Date.parse(t.received_at)), payload: { headers: headers(t) } }];
      if (t.replied_at) msgs.push({ id: t.id + "r", threadId: t.id, labelIds: ["SENT"], snippet: "Thanks for reaching out — ", internalDate: String(Date.parse(t.replied_at)), payload: { headers: [{ name: "From", value: t.assignee! }, { name: "To", value: t.from }, { name: "Subject", value: "Re: " + t.subject }, { name: "Date", value: new Date(t.replied_at).toUTCString() }] } });
      return { status: 200, body: { id: t.id, historyId: "1", messages: msgs } };
    }
    // BigQuery-style export of the mailbox, used for history
    if (p === "/mail/export/threads") return { status: 200, body: exportPage(this.world.threads, q) };
    if (p === "/mail/export/events") {
      let rows = this.world.events;
      if (q.type) rows = rows.filter((e) => e.type === q.type);
      if (q.thread_id) rows = rows.filter((e) => e.thread_id === q.thread_id);
      return { status: 200, body: exportPage(rows, q, 10_000) };
    }
    if (p === "/mail/export/users") return { status: 200, body: { results: MAIL_USERS } };
    if (p === "/mail/export/tables") return { status: 200, body: { tables: [
      { name: "threads", columns: ["id", "from", "to", "subject", "snippet", "received_at", "labels", "assignee", "replied_at"], description: "Every thread in support@ with its current labels and assignee" },
      { name: "events", columns: ["thread_id", "type", "value", "at", "by"], description: "Label, assignment, reply and archive events, with who did them" },
      { name: "users", columns: ["email", "name", "team"], description: "People who work the shared inbox" },
    ] } };
    return { status: 404, body: { error: { code: 404, message: `No route ${p}` } } };
  }
}
