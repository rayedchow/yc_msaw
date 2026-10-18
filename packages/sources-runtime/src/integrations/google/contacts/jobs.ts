import { runContactsLane, type ContactsLaneResult } from "../../../source-lane/providers/google-contacts/sync.js";

// SOURCE-LANE PATCH (calendar-contacts): google.contacts_sync runs the contacts source
// lane (People API sync tokens per mailbox and endpoint, current snapshots, deletion
// and merge tombstones, append-only revisions). The donor names table is still derived
// with the donor's candidate/merge/upsert functions from sync.ts.

export function runGoogleContactsSync(
  userId: string,
  opts: { delegatedEmails?: string[] | null; forceFull?: boolean | null } = {},
): Promise<ContactsLaneResult> {
  return runContactsLane(userId, opts);
}
