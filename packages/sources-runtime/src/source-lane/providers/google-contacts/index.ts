import type { SourceProviderModule } from "../../core/types.js";
import { contactsCoverage } from "./coverage.js";
import { contactsExtraTables } from "./export.js";

/**
 * Google Contacts (People API saved contacts + other contacts per mailbox; DWD, direct
 * OAuth or Composio). Capture: sync.ts, reached through the donor google.contacts_sync
 * task handler via integrations/google/contacts/jobs.ts. Export: export.ts (current
 * snapshots, readable cards, append-only revisions with raw diffs). No activity_events
 * or mirror_files rows are produced, so the module owns no event source or mirror root.
 */
export const googleContactsProvider: SourceProviderModule = {
  id: "google-contacts",
  eventSources: [],
  mirrorRoots: [],
  connectionProviders: ["google", "google-contacts"],
  extraTables: contactsExtraTables,
  coverage: contactsCoverage,
};
