import type { SourceProviderModule } from "../core/types.js";
import { bitbucketProvider } from "./bitbucket/index.js";
import { calendarProvider } from "./calendar/index.js";
import { confluenceProvider } from "./confluence/index.js";
import { githubProvider } from "./github/index.js";
import { gmailProvider } from "./gmail/index.js";
import { googleAuthProvider } from "./google-auth/index.js";
import { googleContactsProvider } from "./google-contacts/index.js";
import { googleDocsProvider } from "./google-docs/index.js";
import { granolaProvider } from "./granola/index.js";
import { imessageProvider } from "./imessage/index.js";
import { jiraProvider } from "./jira/index.js";
import { notionProvider } from "./notion/index.js";
import { slackProvider } from "./slack/index.js";

/**
 * Enabled source providers. Append-only, one line per provider, alphabetical by id;
 * merge conflicts are resolved by the core lead (CONTRACT.md §5).
 */
export const SOURCE_PROVIDERS: readonly SourceProviderModule[] = [
  bitbucketProvider,
  calendarProvider,
  confluenceProvider,
  githubProvider,
  gmailProvider,
  googleAuthProvider,
  googleContactsProvider,
  googleDocsProvider,
  granolaProvider,
  imessageProvider,
  jiraProvider,
  notionProvider,
  slackProvider,
];
