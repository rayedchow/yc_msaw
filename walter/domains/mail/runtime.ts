// Support inbox data and rule context. Shipped inside the compiled MCP as src/domain.ts.
import type { SystemClient } from "../../mine/data.js";

export async function fetchData(c: SystemClient) {
  const [threads, events, users, labels] = await Promise.all([
    c.all("/mail/export/threads", 1000), c.all("/mail/export/events", 10_000), c.get("/mail/export/users"), c.get("/mail/gmail/v1/users/me/labels"),
  ]);
  return { threads: threads as { id: string; from: string; to: string; subject: string; snippet: string; received_at: string; labels: string[]; assignee: string | null; replied_at: string | null }[],
    events: events as { thread_id: string; type: string; value: string; at: string; by: string }[], users: users.body.results as { email: string; name: string; team: string }[], labels: labels.body.labels as { id: string; name: string; type: string }[] };
}
export type MailData = Awaited<ReturnType<typeof fetchData>>;

export function makeCtx(d: MailData) {
  return {
    /** "kraftwerk.de" for "anna@kraftwerk.de" */
    domainOf: (email: string) => String(email ?? "").toLowerCase().split("@").pop() ?? "",
    /** local part: "noreply" for "noreply@stripe.com" */
    localOf: (email: string) => String(email ?? "").toLowerCase().split("@")[0] ?? "",
    users: d.users,
  };
}

/** What a rule sees about a thread: the message as it arrived, not what people later did with it. */
export const asReceived = (t: MailData["threads"][number]) => ({ id: t.id, from: t.from, to: t.to, subject: t.subject, snippet: t.snippet, received_at: t.received_at });
