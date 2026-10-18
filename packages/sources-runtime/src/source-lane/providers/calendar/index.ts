import type { SourceProviderModule } from "../../core/types.js";
import { calendarCoverage } from "./coverage.js";
import { calendarExtraTables } from "./export.js";

/**
 * Google Calendar (DWD, direct OAuth or Composio per mailbox).
 *
 * Exported under sources/calendar/:
 *  * <yyyy>/<mm>/*.md            donor readable projection (mirror_files, default mapping, shared across mailboxes)
 *  * _raw/...                    donor raw ledger: new events and semantic changes (activity_events, default mapping)
 *  * accounts/<mailbox>/calendars/<calendarId>/{calendar.json, events/*.json, changes/**}
 *                                per-mailbox current snapshots and the append-only revision ledger (export.ts)
 *
 * Capture runs in sync.ts (reached through the donor calendar.poll / calendar.setup task
 * handlers via integrations/google/calendar/jobs.ts); coverage is computed from the lane's
 * cursors and per-mailbox status rows, never claimed statically.
 */
export const calendarProvider: SourceProviderModule = {
  id: "calendar",
  eventSources: ["calendar"],
  mirrorRoots: ["sources/calendar/"],
  extraTables: calendarExtraTables,
  coverage: calendarCoverage,
};
