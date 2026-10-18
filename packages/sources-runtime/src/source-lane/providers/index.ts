import type { SourceProviderModule } from "../core/types.js";
import { bitbucketProvider } from "./bitbucket/index.js";
import { calendarProvider } from "./calendar/index.js";
import { confluenceProvider } from "./confluence/index.js";
import { discordProvider } from "./discord/index.js";
import { githubProvider } from "./github/index.js";
import { gmailProvider } from "./gmail/index.js";
import { googleAuthProvider } from "./google-auth/index.js";
import { googleContactsProvider } from "./google-contacts/index.js";
import { googleDocsProvider } from "./google-docs/index.js";
import { granolaProvider } from "./granola/index.js";
import { imessageProvider } from "./imessage/index.js";
import { instagramPersonalProvider } from "./instagram-personal/index.js";
import { jiraProvider } from "./jira/index.js";
import { withNangoRecordsProviders } from "./nango-records/index.js";
import { notionProvider } from "./notion/index.js";
import { slackProvider } from "./slack/index.js";
import { stripeProvider } from "./stripe/index.js";
import { whatsappPersonalProvider } from "./whatsapp-personal/index.js";

/**
 * Enabled source providers. Append-only, one line per provider, alphabetical by id;
 * merge conflicts are resolved by the core lead (CONTRACT.md §5).
 */
const SPECIALIZED_PROVIDERS: readonly SourceProviderModule[] = [
  bitbucketProvider,
  calendarProvider,
  confluenceProvider,
  discordProvider,
  githubProvider,
  gmailProvider,
  googleAuthProvider,
  googleContactsProvider,
  googleDocsProvider,
  granolaProvider,
  imessageProvider,
  instagramPersonalProvider,
  jiraProvider,
  notionProvider,
  slackProvider,
  stripeProvider,
  whatsappPersonalProvider,
];

/**
 * Specialized modules plus the generic Nango records lane (control module `nango-records` and one
 * module per operator-configured source in NANGO_RECORDS_CONFIG). The lane refuses any source whose
 * directory, activity_events source or Nango integration a specialized module owns.
 */
export const SOURCE_PROVIDERS: readonly SourceProviderModule[] = withNangoRecordsProviders(SPECIALIZED_PROVIDERS);
