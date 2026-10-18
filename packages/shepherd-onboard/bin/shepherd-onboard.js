#!/usr/bin/env node
import { execFile, execFileSync, spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocketClient from "ws";
import sourceSelectionHelpers from "../source-selection.cjs";
import wikiReadinessHelpers from "../wiki-readiness.cjs";

const { sourceSelectionFromSession } = sourceSelectionHelpers;
const { renderWikiReadinessSummary, wikiReadinessPayloadFromStatus } = wikiReadinessHelpers;

const CUSTOMER_DEPLOY_API_URL = trimTrailingSlash(
  process.env.SHEPHERD_CUSTOMER_DEPLOY_API_URL || "https://brain-api-deploy.up.railway.app",
);
const MCP_ENVIRONMENT_TARGETS = {
  deploy: {
    label: "Customer deploy",
    apiUrl: CUSTOMER_DEPLOY_API_URL,
  },
  canary: {
    label: "Canary",
    apiUrl: trimTrailingSlash(process.env.SHEPHERD_CANARY_API_URL || "https://brain-api-canary.up.railway.app"),
  },
  "customer-facing": {
    label: "Internal customer-facing",
    apiUrl: trimTrailingSlash(
      process.env.SHEPHERD_CUSTOMER_FACING_API_URL || "https://brain-api-customer-facing.up.railway.app",
    ),
  },
};
const DEFAULT_API_URL = CUSTOMER_DEPLOY_API_URL;
const PACKAGE_NAME = "askshepherd";
const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;
const PACKAGE_VERSION = "0.1.45";
const DEFAULT_OFFICE_AUDIO_TRANSCRIPTION_BACKEND = "pyannote_full";
const OFFICE_AUDIO_TRANSCRIPTION_BACKENDS = new Set([
  "pyannote_full",
  "elevenlabs_pyannote",
  "external_provider_command",
]);
const DEFAULT_OFFICE_AUDIO_TRANSCRIPT_MERGE_MODEL = "accounts/fireworks/models/gpt-oss-120b";
const MCP_SERVER_NAME = "shepherd";
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_AGENT_STATE_PATH = join(homedir(), ".shepherd", "raw-onboarding-agent.json");
const STABLE_CHANNEL = "stable";
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DEFAULT_MCP_STATE_PATH = join(homedir(), ".shepherd", "mcp.json");
const MCP_REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;
const MCP_INSTALL_TARGETS = ["codex", "claude"];
const MAX_BATCH_SIZE = 50;
const DEFAULT_MESSAGES_BACKFILL_DAYS = 60;
const DEFAULT_MESSAGES_UPLOAD_BATCH_SIZE = 500;
const MAX_MESSAGES_UPLOAD_BATCH_SIZE = 500;
const DEFAULT_MESSAGES_UPLOAD_SPLIT_MIN_BATCH_SIZE = 50;
const MESSAGES_UPLOAD_ENV_HELP = `  SHEPHERD_MESSAGES_BATCH_SIZE          Upload batch size, capped at 500. Defaults to 500.
  SHEPHERD_MESSAGES_UPLOAD_CONCURRENCY  Concurrent upload batches, capped at 32. Defaults to 16.
  SHEPHERD_MESSAGES_SPLIT_MIN_BATCH_SIZE Smallest adaptive retry chunk. Defaults to 50.
  SHEPHERD_MESSAGES_HTTP_TIMEOUT_MS     Upload HTTP timeout. Defaults to 180000.`;
const MESSAGES_UPLOAD_BATCH_SIZE = boundedIntFromEnv(
  "SHEPHERD_MESSAGES_BATCH_SIZE",
  boundedIntFromEnv(
    "SHEPHERD_IMESSAGE_BATCH_SIZE",
    DEFAULT_MESSAGES_UPLOAD_BATCH_SIZE,
    1,
    MAX_MESSAGES_UPLOAD_BATCH_SIZE,
  ),
  1,
  MAX_MESSAGES_UPLOAD_BATCH_SIZE,
);
// 16 concurrent 500-message batches drains a 175k-message first fill in
// ~10-18 minutes. This hits our own brain-api (no external rate limit);
// the per-(user, source) drain lanes keep server-side processing in
// lockstep with upload.
const MESSAGES_UPLOAD_CONCURRENCY = boundedIntFromEnv(
  "SHEPHERD_MESSAGES_UPLOAD_CONCURRENCY",
  boundedIntFromEnv("SHEPHERD_MESSAGES_POST_CONCURRENCY", boundedIntFromEnv("SHEPHERD_IMESSAGE_POST_CONCURRENCY", 16, 1, 32), 1, 32),
  1,
  32,
);
const MESSAGES_UPLOAD_SPLIT_MIN_BATCH_SIZE = boundedIntFromEnv(
  "SHEPHERD_MESSAGES_SPLIT_MIN_BATCH_SIZE",
  DEFAULT_MESSAGES_UPLOAD_SPLIT_MIN_BATCH_SIZE,
  1,
  MAX_MESSAGES_UPLOAD_BATCH_SIZE,
);
const MESSAGES_MAX_QUEUE_MESSAGES = positiveIntFromEnv("SHEPHERD_MESSAGES_MAX_QUEUE_MESSAGES", positiveIntFromEnv("SHEPHERD_IMESSAGE_MAX_QUEUE_MESSAGES", 250_000));
const MAX_QUEUE_MESSAGES = 10_000;
const DEFAULT_MESSAGE_CHAT_SEARCH_LIMIT = 200;
const MESSAGE_CHAT_ENRICH_CONCURRENCY = 8;
const INITIAL_MESSAGE_CHAT_ROWS = 20;
const ALL_MESSAGES_CHATS = "__shepherd_all_messages_chats__";
const AGENT_MODALITY_ORDER = ["google", "notion", "slack", "github", "granola", "messages", "codingSessions", "officeAudio"];
const SHEPHERD_LOGO_PATH = join(PACKAGE_DIR, "assets", "shepherd_G_vector_136033.png");
const GRANOLA_API_KEYS_PATH = "/settings/integrations/api-keys";
const GOOGLE_WORKSPACE_DELEGATION_ADMIN_URL = "https://admin.google.com/ac/owl/domainwidedelegation";
const MAC_FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";
const LEGACY_MAC_FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const MAC_CONTACTS_ACCESS_URL = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Contacts";
const LEGACY_MAC_CONTACTS_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts";
const MESSAGES_CHAT_DB_PATH = join(homedir(), "Library", "Messages", "chat.db");
const MESSAGES_ATTACHMENTS_DIR = join(homedir(), "Library", "Messages", "Attachments");
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const CODEX_ARCHIVED_SESSIONS_DIR = join(homedir(), ".codex", "archived_sessions");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CODING_SESSIONS_HTTP_TIMEOUT_MS = positiveIntFromEnv("SHEPHERD_CODING_SESSIONS_HTTP_TIMEOUT_MS", 60_000);
const CODING_SESSION_MESSAGE_TEXT_MAX_CHARS = 20_000;
const CODING_SESSION_PARSER_VERSION = "visible-transcript-v2";
const DEFAULT_CODING_SESSION_FILES_PER_PROVIDER = 1_000;
const CONTACTS_WAL_PATH = join(homedir(), "Library", "Application Support", "AddressBook", "AddressBook-v22.abcddb-wal");
const CONTACT_SYNC_DEBOUNCE_MS = 5_000;
const CONTACT_SYNC_FALLBACK_MS = 30 * 60_000;
const MESSAGES_EDIT_SCAN_INTERVAL_MS = positiveIntFromEnv("SHEPHERD_MESSAGES_EDIT_SCAN_INTERVAL_MS", 60_000);
const MESSAGES_EDIT_SCAN_WINDOW_MS = positiveIntFromEnv("SHEPHERD_MESSAGES_EDIT_SCAN_WINDOW_MS", 30 * 60_000);
const MESSAGES_EDIT_SCAN_LIMIT = positiveIntFromEnv("SHEPHERD_MESSAGES_EDIT_SCAN_LIMIT", 500);
const MESSAGES_MUTATION_RECONCILE_INTERVAL_MS = positiveIntFromEnv("SHEPHERD_MESSAGES_MUTATION_RECONCILE_INTERVAL_MS", 15 * 60_000);
const MESSAGES_QUEUE_DRAIN_INTERVAL_MS = positiveIntFromEnv("SHEPHERD_MESSAGES_QUEUE_DRAIN_INTERVAL_MS", 15_000);
const MESSAGES_BACKFILL_RETRY_INTERVAL_MS = positiveIntFromEnv("SHEPHERD_MESSAGES_BACKFILL_RETRY_INTERVAL_MS", 30_000);
const MESSAGES_HTTP_TIMEOUT_MS = positiveIntFromEnv("SHEPHERD_MESSAGES_HTTP_TIMEOUT_MS", 180_000);
const MESSAGES_WATCH_RESTART_DELAY_MS = positiveIntFromEnv("SHEPHERD_MESSAGES_WATCH_RESTART_DELAY_MS", 5_000);
const MESSAGES_STATE_CACHE_MAX = positiveIntFromEnv("SHEPHERD_MESSAGES_STATE_CACHE_MAX", 5_000);
const LEGACY_SHEPHERD_OWNED_MESSAGE_HANDLES = [
  "+17282355781",
  "+13054098546",
  "+12054012556",
];
const SHEPHERD_OWNED_MESSAGE_HANDLES = parseMessageHandleList(
  [
    ...LEGACY_SHEPHERD_OWNED_MESSAGE_HANDLES,
    process.env.SENDBLUE_NUMBER,
    process.env.SHEPHERD_OWNED_MESSAGE_HANDLES,
    process.env.SHEPHERD_OWNED_IMESSAGE_HANDLES,
  ].filter(Boolean).join(","),
);
const GOOGLE_WORKSPACE_DELEGATION_APP_NAME = "Shepherd";
const GOOGLE_WORKSPACE_DELEGATION_SERVICE_ACCOUNT_EMAIL =
  "gigabrain-delegation@shepherd-gigabrain.iam.gserviceaccount.com";
const GOOGLE_WORKSPACE_DELEGATION_CLIENT_ID = "118363960386741325727";
const GOOGLE_WORKSPACE_DELEGATION_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.addons.current.action.compose",
  "https://www.googleapis.com/auth/gmail.addons.current.message.action",
  "https://www.googleapis.com/auth/gmail.addons.current.message.metadata",
  "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.acls",
  "https://www.googleapis.com/auth/calendar.acls.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.calendarlist",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.calendars",
  "https://www.googleapis.com/auth/calendar.calendars.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.events.owned.readonly",
  "https://www.googleapis.com/auth/calendar.events.public.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.settings.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/drive.apps.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.install",
  "https://www.googleapis.com/auth/drive.meet.readonly",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.photos.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.scripts",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/drive.activity.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
];

const rawArgv = process.argv.slice(2);
const command = rawArgv[0] && !rawArgv[0].startsWith("--") ? rawArgv[0] : "onboard";
const args = parseArgs(command === "onboard" ? rawArgv : rawArgv.slice(1));
let messagesPermissionNoticePrinted = false;
// Background-agent entrypoints set this from their config before calling any
// helper that defaults to cliChannel(); one-shot commands use flags/env/input.
let runtimeLaunchAgentChannel = null;

if (isCliEntrypoint()) {
  if (command === "help" || args.help) {
    printHelp(command === "help" ? "onboard" : command);
    process.exit(0);
  }

  void dispatch().catch((err) => {
    console.error(`\nShepherd onboarding failed: ${safeError(err)}`);
    if (args.debug === true) {
      console.error(rawErrorDetails(err));
    }
    process.exit(1);
  });
}

function isCliEntrypoint() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(modulePath) === realpathSync(process.argv[1]);
  } catch {
    return modulePath === process.argv[1];
  }
}

async function dispatch() {
  if (command === "onboard") {
    await runOnboarding();
  } else if (command === "agent") {
    await runAgentOnboarding();
  } else if (command === "granola-api-keys") {
    await openGranolaApiKeys({ noOpen: Boolean(args["no-open"]) });
  } else if (command === "mcp-login") {
    await runMcpLogin();
  } else if (command === "mcp-install") {
    await runMcpInstall();
  } else if (command === "mcp") {
    await runMcpProxy();
  } else if (command === "status" || command === "sync-status" || command === "check") {
    await runStatusCommand();
  } else if (command === "messages-chats") {
    await runMessagesChatsCommand();
  } else if (command === "messages-agent") {
    await runMessagesAgent();
  } else if (command === "write-agent-state") {
    await runWriteAgentState();
  } else if (command === "write-messages-config") {
    await runWriteMessagesConfig();
  } else if (command === "install-messages-agent") {
    await runInstallMessagesAgent();
  } else if (command === "reset-messages-backfill") {
    await runResetMessagesBackfill();
  } else if (command === "write-coding-sessions-config") {
    await runWriteCodingSessionsConfig();
  } else if (command === "install-coding-sessions-agent") {
    await runInstallCodingSessionsAgent();
  } else if (command === "coding-sessions-agent") {
    await runCodingSessionsAgent();
  } else if (command === "coding-sessions-status") {
    await runCodingSessionsStatus();
  } else if (command === "write-office-audio-config") {
    await runWriteOfficeAudioConfig();
  } else if (command === "install-office-audio-agent") {
    await runInstallOfficeAudioAgent();
  } else if (command === "office-audio-agent") {
    await runOfficeAudioAgent();
  } else if (command === "office-audio-enroll-voice") {
    await runOfficeAudioEnrollVoice();
  } else if (command === "office-audio-provider-speechmatics") {
    await runOfficeAudioSpeechmaticsProvider();
  } else if (command === "office-audio-provider-elevenlabs") {
    await runOfficeAudioElevenLabsProvider();
  } else if (command === "office-audio-provider-soniox") {
    await runOfficeAudioSonioxProvider();
  } else if (command === "office-audio-provider-deepgram") {
    await runOfficeAudioDeepgramProvider();
  } else if (command === "office-audio-provider-pyannoteai") {
    await runOfficeAudioPyannoteAiProvider();
  } else if (command === "office-audio-process-chunks") {
    await runOfficeAudioProcessChunks();
  } else if (command === "office-audio-status") {
    await runOfficeAudioStatus();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

async function runOnboarding() {
  if (!process.stdin.isTTY && !hasIdentityArgs()) {
    printAgentContract();
    return;
  }

  let apiUrl = trimTrailingSlash(args.api ?? DEFAULT_API_URL);
  const noOpen = Boolean(args["no-open"]);

  console.log("\nShepherd Raw Sync Onboarding\n");

  const workosLogin = await runWorkosLogin(apiUrl, noOpen);
  apiUrl = workosLogin.apiUrl;
  const email = authenticatedEmail(workosLogin.authenticated);
  if (!email) throw new Error("Shepherd WorkOS auth did not return an email address.");

  const name = stringArg("name") ?? authenticatedName(workosLogin.authenticated) ?? await valueOrPrompt("name", "Full name");
  const organizationName = await valueOrPrompt("org", "Organization name");

  const sources = selectedSources();

  const session = await postJson(`${apiUrl}/onboarding/raw/session`, {
    email,
    name,
    organizationName,
    authSessionId: workosLogin.started.authSessionId,
    authSessionToken: workosLogin.started.authSessionToken,
    sources,
  });

  console.log(`Linked account: ${session.account.email}`);
  console.log(`Organization: ${session.account.organizationName} (${session.account.organizationSlug})`);
  if (session.account.organizationMatch?.type && session.account.organizationMatch.type !== "created") {
    console.log(`Matched existing organization by ${session.account.organizationMatch.type}.`);
  }

  if (sources.google) {
    console.log("\nGoogle Workspace domain-wide delegation");
    printGoogleWorkspaceDelegationSetup(session.googleWorkspaceDelegation);
    await openGoogleWorkspaceDelegationAdmin({ noOpen });
    await waitForEnter("After the Google Workspace super admin authorizes Shepherd in Admin Console, press Enter.");
  }

  if (session.authUrls?.notion) {
    console.log("\nNotion authorization");
    await openOrPrint(session.authUrls.notion, { noOpen });
    await waitForEnter("Complete Notion authorization in the browser, then press Enter.");
  }

  if (session.authUrls?.slack) {
    console.log("\nSlack authorization");
    await openOrPrint(session.authUrls.slack, { noOpen });
    await waitForEnter("Complete Slack authorization in the browser, then press Enter.");
  }

  const finalizeBody = { sessionToken: session.sessionToken };
  let selectedMessageChats = [];

  if (sources.github) {
    console.log("\nGitHub repository sync");
    const githubToken = await valueOrPrompt("github-token", "GitHub fine-grained or classic PAT with repository webhook/API access", { secret: true, optional: true });
    const githubRepoFullName = await valueOrPrompt("github-repo", "GitHub repository owner/name", { optional: true });
    if (githubToken || githubRepoFullName) {
      finalizeBody.githubToken = githubToken;
      finalizeBody.githubRepoFullName = githubRepoFullName;
    }
  }

  if (sources.granola) {
    if (session.authUrls?.granola) {
      console.log("\nGranola authorization");
      await openOrPrint(session.authUrls.granola, { noOpen });
      await waitForEnter("Complete Granola authorization in the browser, then press Enter.");
    } else {
      await openGranolaApiKeys({ noOpen });
      const granolaApiKey = await valueOrPrompt("granola-api-key", "Legacy Granola API key", { secret: true, optional: true });
      if (granolaApiKey) finalizeBody.granolaApiKey = granolaApiKey;
    }
  }

  if (sources.messages) {
    const handle = await valueOrPrompt("messages-handle", "Messages phone number or Apple ID email (comma-separated if both)", { optional: true });
    const handles = parseMessageHandleList(handle);
    if (handles.length > 0) {
      finalizeBody.imessage = { handle: handles[0], handles };
      await ensureMessagesReadPermission({ noOpen });
      selectedMessageChats = await selectRecentMessageChats();
    }
  }

  const finalized = await postJson(
    `${apiUrl}/onboarding/raw/session/${encodeURIComponent(session.sessionId)}/finalize`,
    finalizeBody,
    { token: session.sessionToken, allowConflict: true },
  );

  if (finalized.errors && Object.keys(finalized.errors).length > 0) {
    console.log("\nSome sources are not connected yet:");
    for (const [source, message] of Object.entries(finalized.errors)) {
      console.log(`- ${source}: ${safeError(message)}`);
    }
    console.log("\nRe-run this command to retry after fixing authorization.");
    process.exit(1);
  }

  if (finalized.connected?.messages?.agentToken) {
    const configPath = await writeMessagesConfig({
      apiUrl,
      userId: session.sessionId,
      agentToken: finalized.connected.messages.agentToken,
      handle: finalizeBody.imessage?.handle,
      handles: finalizeBody.imessage?.handles,
      backfillDays: parseMessagesInitialBackfillDays(args["messages-backfill-days"]),
      allowedChatIds: selectedMessageChats.map((chat) => chat.chatId),
      selectedChats: selectedMessageChats,
    });

    if (!args["no-install-messages-agent"]) {
      await explainMessagesBackgroundPermissions({ noOpen, waitForUser: true });
      const install = await installMessagesAgent(configPath, session.sessionId).catch((err) => ({
        error: safeError(err),
      }));
      if ("error" in install) {
        console.log(`\nLocal Messages credentials saved: ${configPath}`);
        console.log(`Messages background sync was not started: ${install.error}`);
      } else {
        console.log(`\nLocal Messages sync started: ${install.label}`);
      }
    } else {
      console.log(`\nLocal Messages credentials saved: ${configPath}`);
    }
  }

  if (finalized.connected?.codingSessions?.agentToken) {
    const configPath = await writeCodingSessionsConfig({
      apiUrl,
      userId: session.sessionId,
      agentToken: finalized.connected.codingSessions.agentToken,
      intervalSeconds: Number(args["coding-sessions-interval-seconds"] ?? 60),
    });

    if (!args["no-install-coding-sessions-agent"]) {
      const install = await installCodingSessionsAgent(configPath, session.sessionId).catch((err) => ({
        error: safeError(err),
      }));
      if ("error" in install) {
        console.log(`\nLocal coding-session credentials saved: ${configPath}`);
        console.log(`Coding-session background sync was not started: ${install.error}`);
      } else {
        console.log(`\nLocal coding-session sync started: ${install.label}`);
      }
    } else {
      console.log(`\nLocal coding-session credentials saved: ${configPath}`);
    }
  }

  const connected = Object.keys(finalized.connected ?? {});
  console.log(`\nConnected sources: ${connected.length ? connected.join(", ") : "none"}`);

  const status = await getJson(
    `${apiUrl}/onboarding/raw/session/${encodeURIComponent(session.sessionId)}/status`,
    { token: session.sessionToken },
  );
  console.log(`Onboarding status: ${status.status}`);
  printProcessingSummary(status);
  console.log("\nShepherd raw sync setup is ready.\n");
}

async function runAgentOnboarding() {
  if (args.status) {
    await printAgentStatus();
    return;
  }

  if (args.login) {
    await loginAgentWithWorkos();
    return;
  }

  if (args.continue || args.resume) {
    await continueAgentOnboarding();
    return;
  }

  const noOpen = Boolean(args["no-open"]);
  const sources = selectedSources();
  const existingState = await readOptionalAgentState();
  const apiUrl = trimTrailingSlash(args.api ?? existingState?.apiUrl ?? DEFAULT_API_URL);
  const workosAuth = existingState?.workosAuth?.status === "authenticated"
    ? existingState.workosAuth
    : null;
  const wantsStart = Boolean(
    stringArg("name")
    || stringArg("org")
    || stringArg("email")
    || args["no-google"]
    || args["no-slack"]
    || args["no-granola"]
    || args["no-messages"]
    || args["no-coding-sessions"]
    || args["coding-sessions"]
    || stringArg("sources")
    || stringArg("add-sources")
  );

  if (!wantsStart) {
    if (shouldPrintAgentContract()) {
      printAgentContract();
    } else {
      printAgentTerminalHandoff();
    }
    return;
  }
  if (!workosAuth) {
    throw new Error(`Run ${agentCommand()} agent --login first so Shepherd can create or relink the WorkOS account.`);
  }

  const email = stringArg("email") ?? workosAuth.workosUser?.email ?? workosAuth.account?.email;
  const name = stringArg("name") ?? workosAuth.workosUser?.name ?? workosAuth.account?.name;
  const organizationName = stringArg("org") ?? workosAuth.account?.organizationName;
  if (!email) throw new Error("WorkOS login did not return an email. Re-run agent --login.");
  if (!name) throw new Error("Full name is required. Pass --name \"<full_name>\".");
  if (!organizationName) throw new Error("Organization name is required. Pass --org \"<organization>\".");

  const session = await postJson(`${apiUrl}/onboarding/raw/session`, {
    email,
    name,
    organizationName,
    authSessionId: workosAuth.authSessionId,
    authSessionToken: workosAuth.authSessionToken,
    sources,
  });
  const sessionSources = sourceSelectionFromSession(session, sources);

  const statePath = await writeAgentState({
    apiUrl,
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    account: session.account,
    sources: sessionSources,
    authUrls: session.authUrls ?? {},
    googleWorkspaceDelegation: sessionSources.google && session.googleWorkspaceDelegation
      ? googleWorkspaceDelegationSetup(session.googleWorkspaceDelegation)
      : undefined,
    workosAuth,
    createdAt: new Date().toISOString(),
  });

  const currentAction = await openNextAgentModality({
    sources,
    authUrls: session.authUrls ?? {},
    noOpen,
  });

  if (args.json) {
    console.log(JSON.stringify({
      status: "auth_required",
      account: publicAgentAccount(session.account),
      opened: currentAction?.opened ? [currentAction.source] : [],
      sources: sessionSources,
      googleWorkspaceDelegation: sessionSources.google && session.googleWorkspaceDelegation ? googleWorkspaceDelegationSetup(session.googleWorkspaceDelegation) : undefined,
      currentAction,
      statePath,
      messagesChatsCommand: sources.messages ? `${agentCommand()} messages-chats` : undefined,
      nextCommand: `${agentCommand()} agent --continue --github-token "<github_pat>" --github-repo "<owner/repo>" --messages-handle "<phone_or_apple_id[,apple_id]>" --messages-chat-ids "<comma_separated_chat_ids_or_all>" --granola-api-key "<legacy_granola_key>"`,
      needsUserAction: agentNeedsUserAction(sources, currentAction),
    }, null, 2));
    return;
  }

  console.log("\nShepherd raw onboarding session started.");
  console.log(`Account: ${session.account.email}`);
  console.log(`Organization: ${session.account.organizationName} (${session.account.organizationSlug})`);
  if (session.account.organizationMatch?.type && session.account.organizationMatch.type !== "created") {
    console.log(`Matched existing organization by ${session.account.organizationMatch.type}.`);
  }
  console.log(`State saved: ${statePath}`);

  printAgentCurrentAction(currentAction, {
    googleWorkspaceDelegation: session.googleWorkspaceDelegation,
  });

  console.log("\nAfter that modality is complete, run:");
  console.log(`   ${agentCommand()} agent --continue --github-token "<github_pat>" --github-repo "<owner/repo>" --messages-handle "<phone_or_apple_id[,apple_id]>" --messages-chat-ids "<comma_separated_chat_ids_or_all>" --granola-api-key "<legacy_granola_key>"`);
  console.log("   Omit either optional flag if that source is not being connected.");
}

async function loginAgentWithWorkos() {
  let apiUrl = trimTrailingSlash(args.api ?? DEFAULT_API_URL);
  const noOpen = Boolean(args["no-open"]);
  const { apiUrl: authenticatedApiUrl, started, authenticated } = await runWorkosLogin(apiUrl, noOpen);
  apiUrl = authenticatedApiUrl;
  const previous = await readOptionalAgentState();
  const statePath = await writeAgentState({
    ...(previous ?? {}),
    apiUrl,
    workosAuth: {
      status: "authenticated",
      authSessionId: started.authSessionId,
      authSessionToken: started.authSessionToken,
      workosUser: authenticated.workosUser,
      accountStatus: authenticated.accountStatus,
      account: authenticated.account,
      authenticatedAt: new Date().toISOString(),
    },
  });

  if (args.json) {
    console.log(JSON.stringify({
      status: "authenticated",
      accountStatus: authenticated.accountStatus,
      account: authenticated.account,
      workosUser: authenticated.workosUser,
      statePath,
    }, null, 2));
    return;
  }

  console.log("Shepherd account login complete.");
  if (authenticated.account) {
    console.log(`Linked account: ${authenticated.account.email}`);
    console.log(`Organization: ${authenticated.account.organizationName} (${authenticated.account.organizationSlug})`);
  } else {
    console.log(`Authenticated email: ${authenticated.workosUser?.email ?? "unknown"}`);
    console.log("No existing Shepherd customer account was found; continue onboarding to create one.");
  }
  console.log(`State saved: ${statePath}`);
}

async function runWorkosLogin(apiUrl, noOpen, options = {}) {
  const resolvedApiUrl = trimTrailingSlash(apiUrl);
  const startBody = options.authMethod ? { authMethod: options.authMethod } : {};
  const started = await postJson(`${resolvedApiUrl}/onboarding/raw/auth/start`, startBody);

  console.log("\nShepherd account login");
  console.log("Opening Shepherd WorkOS auth. Complete login/signup in the browser.");
  console.log("Terms: https://askshepherd.ai/terms");
  console.log("Privacy: https://askshepherd.ai/privacy");
  await openOrPrint(started.verificationUriComplete ?? started.verificationUri, { noOpen });
  if (noOpen && started.userCode) console.log(`User code: ${started.userCode}`);

  const authenticated = await pollWorkosLogin(resolvedApiUrl, started);
  const routingError = routingErrorMessage(authenticated);
  if (routingError) throw new Error(routingError);
  return { apiUrl: resolvedApiUrl, started, authenticated };
}

async function pollWorkosLogin(apiUrl, started) {
  const intervalMs = Math.max(1000, Number(started.intervalSeconds ?? 5) * 1000);
  const expiresAt = Date.parse(started.expiresAt ?? "") || Date.now() + 600_000;
  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const response = await fetch(
      `${apiUrl}/onboarding/raw/auth/${encodeURIComponent(started.authSessionId)}/poll`,
      {
        method: "POST",
        headers: headers(started.authSessionToken),
        body: JSON.stringify({ authSessionToken: started.authSessionToken }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) continue;
    if (!response.ok) throw new Error(safeError(body?.error ?? `WorkOS login poll failed (${response.status})`));
    if (body.status === "authenticated") return body;
  }
  throw new Error("Shepherd WorkOS login expired before it completed.");
}

function routingErrorMessage(authenticated) {
  const routing = authenticated?.routing && typeof authenticated.routing === "object" ? authenticated.routing : null;
  if (!routing) return null;
  if (routing.targetLabel === "Production Internal") {
    return "This Shepherd account belongs in Production Internal. Open Shepherd Internal and sign in there.";
  }
  if (routing.targetLabel === "Production Customer") {
    return "This Shepherd account belongs in Production Customer. Open the customer Shepherd app and sign in there.";
  }
  return "This Shepherd account belongs in a different production app. Open the correct Shepherd app and sign in there.";
}

async function runMcpLogin() {
  const requestedEnvironment = mcpEnvironmentArg();
  const apiUrl = trimTrailingSlash(
    requestedEnvironment ? MCP_ENVIRONMENT_TARGETS[requestedEnvironment].apiUrl : args.api ?? DEFAULT_API_URL,
  );
  const noOpen = Boolean(args["no-open"]);
  const login = await loginMcp({ apiUrl, noOpen, allowBrowser: true, quiet: false });
  const environment = mcpEnvironmentForUrl(login.mcpUrl ?? login.apiUrl);
  if (environment && environment !== "deploy" && !isAskShepherdSsoMcpAccount(login.authenticated.account)) {
    throw new Error(`${mcpEnvironmentLabel(environment, login.mcpUrl)} MCP login is only available to authenticated askshepherd.ai accounts.`);
  }
  const statePath = await writeMcpStateFromLogin(login);
  const installTargets = await selectMcpInstallTargets();
  const installResults = installTargets.length > 0
    ? await installMcpClients({ statePath, targets: installTargets, proxyProgram: parseJsonArrayArg("mcp-program") })
    : [];

  if (args.json) {
    console.log(JSON.stringify({
      status: "authenticated",
      authSource: login.authSource,
      account: login.authenticated.account,
      onboarding: login.authenticated.onboarding,
      mcp: publicMcpLogin(login),
      statePath,
      installed: installResults,
    }, null, 2));
    return;
  }

  console.log("\nShepherd MCP login complete.");
  console.log(`Endpoint: ${login.mcpUrl}`);
  console.log(`Account: ${login.authenticated.account?.email ?? "unknown"}`);
  if (login.authSource === "local_onboarding") {
    console.log("Auth source: local Shepherd onboarding session");
  } else {
    console.log("Auth source: WorkOS browser login");
  }
  if (login.authenticated.onboarding?.processingEnabled === true) {
    console.log(`Production sync status: ${login.authenticated.onboarding.status ?? "active"}`);
  }
  console.log(`Token saved: ${statePath}`);
  if (installResults.length) printMcpInstallResults(installResults);
  else console.log("MCP client install skipped. Run mcp-install later to add Shepherd to Codex or Claude Code.");
}

async function loginMcp({ apiUrl, noOpen, allowBrowser, quiet }) {
  if (!args["no-local"]) {
    try {
      return await loginMcpWithLocalOnboarding(apiUrl);
    } catch (err) {
      if (!quiet) {
        console.error(`Local Shepherd onboarding auth was not usable: ${safeError(err)}`);
      }
    }
  }

  if (!allowBrowser) {
    throw new Error("No valid local Shepherd onboarding session or MCP token was found. Run mcp-login after onboarding.");
  }

  const started = await postJson(`${apiUrl}/mcp/auth/start`, {});

  if (!quiet) {
    console.log("\nShepherd MCP login");
    console.log("Opening Shepherd WorkOS auth. Complete login/signup in the browser.");
  }
  await openOrPrint(started.verificationUriComplete ?? started.verificationUri, { noOpen });
  if (noOpen && started.userCode && !quiet) console.log(`User code: ${started.userCode}`);

  const authenticated = await pollMcpLogin(apiUrl, started);
  return mcpLoginFromAuthenticated(apiUrl, authenticated, "workos");
}

async function loginMcpWithLocalOnboarding(apiUrl) {
  const onboardingPath = mcpOnboardingStatePath();
  const onboarding = await readOptionalAgentStateAt(onboardingPath);
  if (!onboarding?.sessionId || !onboarding?.sessionToken) {
    throw new Error(`No Shepherd raw onboarding state found at ${onboardingPath}`);
  }

  const resolvedApiUrl = trimTrailingSlash(apiUrl ?? onboarding.apiUrl ?? DEFAULT_API_URL);
  const authenticated = await postJson(
    `${resolvedApiUrl}/mcp/auth/local`,
    {
      sessionId: onboarding.sessionId,
      sessionToken: onboarding.sessionToken,
    },
    { token: onboarding.sessionToken },
  );
  const login = mcpLoginFromAuthenticated(resolvedApiUrl, authenticated, "local_onboarding");
  login.localAuth = {
    source: "raw_onboarding",
    statePath: onboardingPath,
    sessionId: onboarding.sessionId,
    apiUrl: resolvedApiUrl,
  };
  return login;
}

function mcpLoginFromAuthenticated(apiUrl, authenticated, authSource) {
  const mcpUrl = new URL(authenticated.mcp?.url ?? "/mcp", `${apiUrl}/`).toString();
  return {
    apiUrl,
    mcpUrl,
    authSource,
    authenticated,
  };
}

async function writeMcpStateFromLogin(login) {
  const environment = mcpEnvironmentForUrl(login.mcpUrl ?? login.apiUrl);
  const existing = await readOptionalMcpState();
  const environmentState = environment
    ? {
        ...(existing?.environments ?? {}),
        [environment]: mcpEnvironmentStateFromLogin(login),
      }
    : existing?.environments;
  const preserveExistingDefault = Boolean(
    args["no-install"]
    && environment
    && environment !== "deploy"
    && existing?.token
    && mcpEnvironmentForUrl(existing.mcpUrl ?? existing.apiUrl) === "deploy",
  );
  if (preserveExistingDefault) {
    return writeMcpState({
      ...existing,
      environments: environmentState,
      updatedAt: new Date().toISOString(),
    });
  }
  return writeMcpState({
    apiUrl: login.apiUrl,
    mcpUrl: login.mcpUrl,
    token: login.authenticated.mcp.token,
    expiresAt: login.authenticated.mcp.expiresAt,
    account: login.authenticated.account,
    authSource: login.authSource,
    onboarding: login.authenticated.onboarding,
    localAuth: login.localAuth,
    ...(environment ? { environment } : {}),
    ...(environmentState ? { environments: environmentState } : {}),
    createdAt: new Date().toISOString(),
  });
}

function mcpEnvironmentStateFromLogin(login) {
  return {
    apiUrl: login.apiUrl,
    mcpUrl: login.mcpUrl,
    token: login.authenticated.mcp.token,
    expiresAt: login.authenticated.mcp.expiresAt,
    account: login.authenticated.account,
    authSource: login.authSource,
    localAuth: login.localAuth,
    updatedAt: new Date().toISOString(),
  };
}

function publicMcpLogin(login) {
  return {
    url: login.mcpUrl,
    authorization: "Bearer",
    token: login.authenticated.mcp.token,
    expiresAt: login.authenticated.mcp.expiresAt,
    headers: {
      Authorization: `Bearer ${login.authenticated.mcp.token}`,
    },
  };
}

async function ensureMcpState({ allowBrowser = false, quiet = false } = {}) {
  const existing = await readOptionalMcpState();
  if (existing && mcpStateHasFreshToken(existing)) {
    return { state: existing, statePath: mcpStatePath(), refreshed: false, authSource: existing.authSource ?? "saved_mcp" };
  }

  const apiUrl = trimTrailingSlash(args.api ?? existing?.apiUrl ?? DEFAULT_API_URL);
  const login = await loginMcp({
    apiUrl,
    noOpen: Boolean(args["no-open"]),
    allowBrowser,
    quiet,
  });
  const statePath = await writeMcpStateFromLogin(login);
  return {
    state: {
      apiUrl: login.apiUrl,
      mcpUrl: login.mcpUrl,
      token: login.authenticated.mcp.token,
      expiresAt: login.authenticated.mcp.expiresAt,
      account: login.authenticated.account,
      authSource: login.authSource,
      onboarding: login.authenticated.onboarding,
      localAuth: login.localAuth,
      environment: mcpEnvironmentForUrl(login.mcpUrl ?? login.apiUrl) ?? undefined,
    },
    statePath,
    refreshed: true,
    authSource: login.authSource,
  };
}

function mcpStateHasFreshToken(state) {
  if (!state?.token) return false;
  const expiresAt = Date.parse(state.expiresAt ?? "");
  return !Number.isFinite(expiresAt) || expiresAt - MCP_REFRESH_SKEW_MS > Date.now();
}

async function readOptionalMcpState() {
  try {
    const state = JSON.parse(await readFile(mcpStatePath(), "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    return state;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    return null;
  }
}

async function readOptionalAgentStateAt(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

function mcpOnboardingStatePath() {
  return expandHomePath(stringArg("onboarding-state") ?? DEFAULT_AGENT_STATE_PATH);
}

async function runMcpInstall() {
  const ensured = await ensureMcpState({ allowBrowser: process.stdin.isTTY, quiet: args.json === true });
  const targets = await selectMcpInstallTargets({ defaultTargets: MCP_INSTALL_TARGETS });
  const installResults = targets.length > 0
    ? await installMcpClients({ statePath: ensured.statePath, targets, proxyProgram: parseJsonArrayArg("mcp-program") })
    : [];

  if (args.json) {
    console.log(JSON.stringify({
      statePath: ensured.statePath,
      authSource: ensured.authSource,
      refreshed: ensured.refreshed,
      account: ensured.state.account,
      installed: installResults,
    }, null, 2));
    return;
  }

  if (ensured.refreshed) {
    console.log(`Shepherd MCP auth refreshed from ${ensured.authSource}.`);
  }
  if (installResults.length) printMcpInstallResults(installResults);
  else console.log("MCP client install skipped.");
}

async function runMcpProxy() {
  const requestedEnvironmentArg = mcpEnvironmentArg();
  const ensured = await ensureMcpState({ allowBrowser: false, quiet: true });
  const state = ensured.state;
  const requestedEnvironment = requestedEnvironmentArg ?? mcpEnvironmentForUrl(state.mcpUrl ?? state.apiUrl);
  const selectedEnvironmentState = mcpStateForEnvironment(state, requestedEnvironment);
  const mcpUrl = stringArg("url")
    ?? (requestedEnvironment ? mcpUrlForEnvironment(requestedEnvironment) : undefined)
    ?? selectedEnvironmentState?.mcpUrl
    ?? state.mcpUrl
    ?? new URL("/mcp", `${selectedEnvironmentState?.apiUrl ?? state.apiUrl}/`).toString();
  const token = stringArg("token") ?? selectedEnvironmentState?.token ?? (requestedEnvironment ? undefined : state.token);
  if (!mcpUrl) throw new Error("Shepherd MCP state is missing mcpUrl.");
  if (!token) {
    const loginCommand = requestedEnvironment
      ? `${agentCommand()} mcp-login --api ${MCP_ENVIRONMENT_TARGETS[requestedEnvironment].apiUrl} --no-install`
      : `${agentCommand()} mcp-login`;
    throw new Error(`Shepherd MCP state is missing a token for ${requestedEnvironment ?? "the saved environment"}. Run: ${loginCommand}`);
  }

  const [
    { Client },
    { StreamableHTTPClientTransport },
    { Server },
    { StdioServerTransport },
    { CallToolRequestSchema, ListToolsRequestSchema, ResultSchema },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const proxyRequestOptions = { timeout: 240_000, resetTimeoutOnProgress: true };

  const passthroughResultSchema = typeof ResultSchema.passthrough === "function"
    ? ResultSchema.passthrough()
    : ResultSchema;

  let remoteSession = await connectMcpProxyRemote({
    Client,
    StreamableHTTPClientTransport,
    environment: requestedEnvironment,
    mcpUrl,
    token,
  });
  if (
    requestedEnvironment
    && requestedEnvironment !== "deploy"
    && remoteSession.connected
    && !isAskShepherdSsoMcpAccount(remoteSession.account)
  ) {
    await remoteSession.client.close().catch(() => undefined);
    throw new Error(`${remoteSession.environmentLabel} MCP proxy startup is only available to authenticated askshepherd.ai accounts.`);
  }
  const internalControlsEnabled = () => isAskShepherdSsoMcpAccount(remoteSession.account);
  const currentLocalTools = () => localMcpTools({ environmentControls: internalControlsEnabled() });
  const currentLocalToolNames = () => new Set(currentLocalTools().map((tool) => tool.name));
  const remoteCapabilities = remoteSession.connected ? remoteSession.client.getServerCapabilities() ?? {} : {};
  const remoteInstructions = remoteSession.connected ? remoteSession.client.getInstructions() ?? "" : "";
  const local = new Server(
    { name: "askshepherd", version: PACKAGE_VERSION },
    {
      capabilities: { ...remoteCapabilities, tools: { listChanged: false } },
      instructions: localMcpInstructions(remoteInstructions, remoteSession.error, {
        environmentControls: internalControlsEnabled(),
        environment: remoteSession.environment,
        mcpUrl: remoteSession.mcpUrl,
      }),
      fallbackRequestHandler: async (request, extra) => {
        if (!remoteSession.connected) {
          throw new Error(`Shepherd MCP ${remoteSession.environmentLabel} is unavailable (${remoteSession.error ?? "not connected"}).`);
        }
        return remoteSession.client.request(
          request,
          passthroughResultSchema,
          { ...proxyRequestOptions, signal: extra.signal },
        );
      },
      fallbackNotificationHandler: async (notification) => {
        if (remoteSession.connected) await remoteSession.client.notification(notification);
      },
    },
  );
  local.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const localTools = currentLocalTools();
    const localToolNames = currentLocalToolNames();
    if (!remoteSession.connected) return { tools: localTools };
    const remoteTools = await remoteSession.client
      .listTools(request.params, { ...proxyRequestOptions, signal: extra.signal });
    return {
      ...remoteTools,
      tools: [
        ...localTools,
        ...(remoteTools.tools ?? []).filter((tool) => !localToolNames.has(tool.name)),
      ],
    };
  });
  local.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const localToolNames = currentLocalToolNames();
    if (localToolNames.has(request.params.name)) {
      return callLocalMcpTool(request.params.name, {
        args: recordValue(request.params.arguments) ?? {},
        proxy: {
          get session() {
            return remoteSession;
          },
          async switchEnvironment(environment) {
            const nextMcpUrl = mcpUrlForEnvironment(environment);
            const nextToken = stringArg("token") ?? mcpStateForEnvironment(state, environment)?.token;
            if (!nextToken) {
              return {
                client: null,
                connected: false,
                environment,
                environmentLabel: mcpEnvironmentLabel(environment, nextMcpUrl),
                mcpUrl: nextMcpUrl,
                account: null,
                authError: null,
                error: `No saved MCP token for ${mcpEnvironmentLabel(environment, nextMcpUrl)}. Run: ${agentCommand()} mcp-login --api ${MCP_ENVIRONMENT_TARGETS[environment].apiUrl} --no-install`,
              };
            }
            const nextSession = await connectMcpProxyRemote({
              Client,
              StreamableHTTPClientTransport,
              environment,
              mcpUrl: nextMcpUrl,
              token: nextToken,
            });
            if (!nextSession.connected) return nextSession;
            if (!isAskShepherdSsoMcpAccount(nextSession.account)) {
              await nextSession.client.close().catch(() => undefined);
              return nextSession;
            }
            const previous = remoteSession;
            remoteSession = nextSession;
            if (previous.connected && previous.client !== nextSession.client) {
              await previous.client.close().catch(() => undefined);
            }
            return nextSession;
          },
        },
      });
    }
    if (!remoteSession.connected) {
      return localMcpTextResult(`Shepherd MCP ${remoteSession.environmentLabel} is unavailable (${remoteSession.error ?? "not connected"}). For local setup/sync status, use shepherd_status or run ${agentCommand()} status.`, true);
    }
    return remoteSession.client.callTool(request.params, passthroughResultSchema, { ...proxyRequestOptions, signal: extra.signal });
  });
  await local.connect(new StdioServerTransport());
}

async function connectMcpProxyRemote({ Client, StreamableHTTPClientTransport, environment, mcpUrl, token }) {
  const resolvedEnvironment = environment ?? mcpEnvironmentForUrl(mcpUrl);
  const environmentLabel = mcpEnvironmentLabel(resolvedEnvironment, mcpUrl);
  const client = new Client(
    { name: "askshepherd-mcp-proxy", version: PACKAGE_VERSION },
    { capabilities: {} },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    }));
    const auth = await fetchMcpAuthStatus(mcpUrl, token);
    return {
      client,
      connected: true,
      environment: resolvedEnvironment,
      environmentLabel,
      mcpUrl,
      account: auth.account,
      authError: auth.error,
      error: null,
    };
  } catch (err) {
    await client.close().catch(() => undefined);
    return {
      client,
      connected: false,
      environment: resolvedEnvironment,
      environmentLabel,
      mcpUrl,
      account: null,
      authError: null,
      error: safeError(err),
    };
  }
}

async function fetchMcpAuthStatus(mcpUrl, token) {
  try {
    const response = await fetch(mcpAuthStatusUrl(mcpUrl), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { account: null, error: safeError(body?.error ?? `MCP auth status failed (${response.status})`) };
    }
    return { account: recordValue(body.account), error: null };
  } catch (err) {
    return { account: null, error: safeError(err) };
  }
}

function mcpAuthStatusUrl(mcpUrl) {
  const base = String(mcpUrl).replace(/\/+$/, "/");
  return new URL("auth/status", base).toString();
}

function mcpEnvironmentArg() {
  const raw = args.env ?? args.environment;
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Unknown Shepherd MCP environment. Use deploy, canary, or customer-facing.");
  }
  const environment = mcpEnvironmentFromValue(raw);
  if (!environment) {
    throw new Error(`Unknown Shepherd MCP environment: ${raw}. Use deploy, canary, or customer-facing.`);
  }
  return environment;
}

function mcpStateForEnvironment(state, environment) {
  if (!environment) return state;
  const fromMap = recordValue(state?.environments)?.[environment];
  if (recordValue(fromMap)) return fromMap;
  const topLevelEnvironment = mcpEnvironmentForUrl(state?.mcpUrl ?? state?.apiUrl);
  return topLevelEnvironment === environment ? state : null;
}

function mcpEnvironmentFromValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^\/+/, "");
  if (normalized === "customer" || normalized === "prod" || normalized === "production") return "deploy";
  if (normalized === "internal") return "customer-facing";
  return Object.prototype.hasOwnProperty.call(MCP_ENVIRONMENT_TARGETS, normalized) ? normalized : null;
}

function mcpUrlForEnvironment(environment) {
  const target = MCP_ENVIRONMENT_TARGETS[environment];
  if (!target) throw new Error(`Unknown Shepherd MCP environment: ${environment}`);
  return new URL("/mcp", `${target.apiUrl}/`).toString();
}

function mcpEnvironmentForUrl(value) {
  if (!value) return null;
  const normalized = trimTrailingSlash(String(value)).replace(/\/mcp$/, "");
  for (const [environment, target] of Object.entries(MCP_ENVIRONMENT_TARGETS)) {
    if (trimTrailingSlash(target.apiUrl) === normalized) return environment;
  }
  return null;
}

function mcpEnvironmentLabel(environment, mcpUrl) {
  if (environment && MCP_ENVIRONMENT_TARGETS[environment]) return MCP_ENVIRONMENT_TARGETS[environment].label;
  return `custom endpoint ${mcpUrl}`;
}

function isAskShepherdSsoMcpAccount(account) {
  const email = typeof account?.email === "string" ? account.email.trim().toLowerCase() : "";
  return email === "askshepherd.ai" || email.endsWith("@askshepherd.ai");
}

function localMcpTools(opts = {}) {
  const emptyInputSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };

  const tools = [
    {
      name: "shepherd_onboarding_guide",
      description: "LOCAL agent-facing Shepherd onboarding workflow. Use when setting up Shepherd, choosing sources, deciding usage-skill/MCP install targets, or recovering the next onboarding step.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
      _meta: { provider: "local_npm", command: `${agentCommand()} guide` },
    },
    {
      name: "shepherd_troubleshoot",
      description: "LOCAL state-aware Shepherd onboarding/setup help. Use when confused, blocked, auth expired, source setup is pending, local sync is unhealthy, or the wiki is still building.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
      _meta: { provider: "local_npm", command: `${agentCommand()} troubleshoot` },
    },
    {
      name: "shepherd_status",
      description: "LOCAL Shepherd setup and sync status. Use this first when the user asks what they have enabled, what is connected, whether Shepherd is syncing, or why local Messages/Coding Sessions are not running. This is backed by the local Shepherd CLI; do not use production memory/wiki tools or shell/file exploration for local setup status.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
      _meta: { provider: "local_npm", command: `${agentCommand()} status` },
    },
    {
      name: "shepherd_local_status",
      description: "Explicit local alias for shepherd_status. Returns the authoritative local Shepherd CLI status path and current local setup/sync state. Do not inspect user folders or repositories yourself.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
      _meta: { provider: "local_npm", command: `${agentCommand()} status` },
    },
    {
      name: "shepherd_wiki_status",
      description: "LOCAL Shepherd wiki readiness status backed by the onboarding status API. Use this before memory/wiki questions immediately after onboarding or whenever readiness is uncertain. Returns status: \"wiki_not_ready\" while initial wiki processing is incomplete.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
      _meta: { provider: "local_npm", command: `${agentCommand()} shepherd_wiki_status` },
    },
    {
      name: "shepherd_setup_coding_sessions",
      description: "LOCAL setup guide for Codex and Claude Code coding-session sync. Use when the user asks to set up coding agent sessions. Ask for consent, then guide the local Shepherd CLI login/onboard/continue/status commands. Do not search, list, or read the user's folders or repos to discover setup.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
      _meta: { provider: "local_npm", command: `${agentCommand()} onboard --add-sources coding-sessions` },
    },
    {
      name: "shepherd_enable_coding_sessions",
      description: "Alias for shepherd_setup_coding_sessions. Use when the user asks to enable coding agent sessions locally for Shepherd. Return the local Shepherd CLI setup commands; do not search, list, or read the user's folders or repos.",
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations,
      _meta: { provider: "local_npm", command: `${agentCommand()} onboard --add-sources coding-sessions` },
    },
  ];

  if (opts.environmentControls) {
    tools.push(
      {
        name: "shepherd_environment_status",
        description: "INTERNAL askshepherd.ai accounts only. Show which deployed Shepherd MCP environment this local proxy process is currently using and which environments can be selected for testing.",
        inputSchema: emptyInputSchema,
        annotations: readOnlyAnnotations,
        _meta: { provider: "local_npm", internalOnly: "askshepherd_sso" },
      },
      {
        name: "shepherd_switch_environment",
        description: "INTERNAL askshepherd.ai accounts only. Switch this local MCP proxy process to another deployed Shepherd MCP environment. Accepts deploy, canary, customer-facing, or slash aliases /customer, /canary, /internal. The selected environment supplies both the remote tool catalog and the data read by those tools. The switch is not saved; restarting the MCP process returns to the saved/default endpoint.",
        inputSchema: {
          type: "object",
          properties: {
            environment: {
              type: "string",
              enum: [...Object.keys(MCP_ENVIRONMENT_TARGETS), "/customer", "/canary", "/internal"],
              description: "Deployed Shepherd MCP environment to use for tools/list, instructions, schemas, tools/call, and data.",
            },
          },
          required: ["environment"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
        _meta: { provider: "local_npm", internalOnly: "askshepherd_sso", scope: "local_mcp_process" },
      },
    );
  }

  return tools;
}

function localMcpInstructions(remoteInstructions, remoteConnectError, opts = {}) {
  const environmentLabel = opts.environment ? mcpEnvironmentLabel(opts.environment, opts.mcpUrl) : "saved Shepherd MCP endpoint";
  return [
    "This MCP server is the local Shepherd CLI wrapper plus deployed Shepherd memory/wiki tools.",
    `For agent-led onboarding, source choice, usage-skill install targets, MCP install targets, or "what step is next", use shepherd_onboarding_guide first. If setup is blocked or confusing, use shepherd_troubleshoot. For local setup/sync questions like "what do I have set up on Shepherd", "what have I enabled", "is Shepherd syncing", "help me set up coding agent sessions", "enable coding sessions", or "enable coding agent sessions locally for Shepherd", use shepherd_status, shepherd_setup_coding_sessions, or shepherd_enable_coding_sessions first. These local tools route to the local Shepherd CLI status/setup flow. The Shepherd CLI is the only component that may perform bounded local checks of Shepherd state, LaunchAgents, and known Codex/Claude session locations.`,
    "Hard boundary: do not use shell or filesystem tools such as ls, find, rg, grep, cat, Read, Glob, or Explore to inspect the user's home directory, repositories, ~/.codex, ~/.claude, or ~/.shepherd for Shepherd setup. If local status is needed, call shepherd_status or run the exact Shepherd CLI status command.",
    `If the user asks for raw local status outside MCP, tell them to run ${agentCommand()} status. For setup of coding agent sessions, ask consent, then use ${agentCommand()} login if needed, ${agentCommand()} onboard --add-sources coding-sessions --name "<full_name>" --org "<organization>", ${agentCommand()} continue, then ${agentCommand()} status.`,
    "For memory/wiki questions when readiness is uncertain, call shepherd_wiki_status first. If it or any deployed Shepherd tool returns status: \"wiki_not_ready\", do not answer the underlying memory/wiki question yet; report the readiness progress/ETA and ask the user to retry when the initial build is ready.",
    "Use deployed Shepherd memory/wiki tools only for company-memory questions, source recall, wiki lookup, messages/meetings retrieval, or coding-session work history that has already synced to Shepherd.",
    "Important override: any deployed Shepherd instruction saying not to use local shell commands applies only to remote memory/wiki answers. It does not apply to local Shepherd setup, source enablement, or sync health.",
    opts.environmentControls
      ? `Internal askshepherd.ai environment controls are available in this local process. Use shepherd_environment_status to inspect the selected deployed MCP environment and shepherd_switch_environment to switch tools/list, schemas, tools/call, and data reads to canary, customer-facing, or deploy. The switch is process-local and resets when this MCP process restarts. A fresh process started with --env <environment> gets that environment's server instructions at initialization.`
      : "",
    remoteConnectError ? `Shepherd MCP ${environmentLabel} connection failed at startup: ${remoteConnectError}. Local setup/status tools are still available.` : "",
    remoteInstructions ? `Deployed Shepherd memory/wiki instructions from ${environmentLabel}: ${remoteInstructions}` : "",
  ].filter(Boolean).join(" ");
}

async function callLocalMcpTool(name, context = {}) {
  if (name === "shepherd_onboarding_guide") {
    const status = await collectShepherdStatus();
    return localMcpTextResult(renderOnboardingGuideMcpResult(status));
  }

  if (name === "shepherd_troubleshoot") {
    const status = await collectShepherdStatus();
    return localMcpTextResult(renderTroubleshootMcpResult(status));
  }

  if (name === "shepherd_status" || name === "shepherd_local_status") {
    const status = await collectShepherdStatus();
    return localMcpTextResult([
      `Authoritative local status path: ${agentCommand()} status`,
      "Use this result for setup/source/sync-health questions. Do not use production memory/wiki tools to answer what is enabled locally.",
      "Do not inspect the user's folders or repositories yourself. Do not run ls/find/rg/grep/cat/Read/Glob/Explore against the user's home directory, repos, ~/.codex, ~/.claude, or ~/.shepherd for Shepherd setup.",
      renderShepherdStatus(status),
    ].join("\n\n"));
  }

  if (name === "shepherd_wiki_status") {
    const status = await collectShepherdStatus();
    return localMcpTextResult(JSON.stringify(wikiReadinessPayloadFromStatus(status), null, 2));
  }

  if (name === "shepherd_setup_coding_sessions" || name === "shepherd_enable_coding_sessions") {
    const status = await collectShepherdStatus();
    return localMcpTextResult(renderCodingSessionsSetupMcpResult(status));
  }

  if (name === "shepherd_environment_status") {
    return localMcpTextResult(renderMcpEnvironmentStatus(context.proxy?.session));
  }

  if (name === "shepherd_switch_environment") {
    const targetEnvironment = mcpEnvironmentFromValue(context.args?.environment ?? context.args?.env);
    if (!targetEnvironment) {
      return localMcpTextResult("Unknown Shepherd MCP environment. Use deploy, canary, or customer-facing.", true);
    }
    if (!isAskShepherdSsoMcpAccount(context.proxy?.session?.account)) {
      return localMcpTextResult("Shepherd MCP environment switching is only available to authenticated askshepherd.ai accounts.", true);
    }
    const nextSession = await context.proxy.switchEnvironment(targetEnvironment);
    if (!nextSession.connected) {
      return localMcpTextResult([
        `Could not switch Shepherd MCP to ${nextSession.environmentLabel}.`,
        `Error: ${nextSession.error ?? "not connected"}`,
        "No fallback environment was used. Run the normal MCP login for that deployed environment if authentication has expired, then retry.",
      ].join("\n"), true);
    }
    if (!isAskShepherdSsoMcpAccount(nextSession.account)) {
      return localMcpTextResult("The selected Shepherd MCP environment authenticated successfully, but the account is not an askshepherd.ai account. Environment switching was not enabled.", true);
    }
    return localMcpTextResult([
      `Switched this local Shepherd MCP process to ${nextSession.environmentLabel}.`,
      "",
      "The next tools/list resolves from that deployed environment, including its tool schemas. Tool calls now execute there and read that environment's data.",
      "For a fresh selected-environment server instruction prelude, start the proxy process with the matching --env flag or reconnect after switching.",
      "This is not saved. Restarting the MCP process returns to the saved/default endpoint.",
      "",
      renderMcpEnvironmentStatus(nextSession),
    ].join("\n"));
  }

  return localMcpTextResult(`Unknown local Shepherd MCP tool: ${name}`, true);
}

function renderMcpEnvironmentStatus(session) {
  const environment = session?.environment ?? "custom";
  const label = session?.environmentLabel ?? "unknown";
  const accountEmail = typeof session?.account?.email === "string" ? session.account.email : "unknown";
  const connected = session?.connected === true;
  const selectedLine = session?.mcpUrl
    ? `${environment} (${label}) -> ${session.mcpUrl}`
    : `${environment} (${label})`;
  return [
    "Shepherd MCP environment status",
    "",
    `Selected environment: ${selectedLine}`,
    `Connected: ${connected ? "yes" : "no"}`,
    `Authenticated account: ${accountEmail}`,
    `askshepherd.ai environment controls: ${isAskShepherdSsoMcpAccount(session?.account) ? "available" : "not available"}`,
    "Scope: this local MCP process only; it is not saved to ~/.shepherd/mcp.json.",
    "Behavior: the selected deployed environment supplies tools/list, tool schemas, tool execution, and the data read by those tools.",
    "Switch aliases: /customer -> deploy, /canary -> canary, /internal -> customer-facing.",
    session?.error ? `Last connection error: ${session.error}` : "",
    session?.authError ? `Auth status warning: ${session.authError}` : "",
  ].filter(Boolean).join("\n");
}

function renderCodingSessionsSetupMcpResult(status) {
  const command = status.commands.addCodingSessions;
  const alreadyConfigured = Boolean(status.local.codingSessions.configPath);
  return [
    "Local Shepherd coding-session setup",
    "",
    "Use this when the user asks to set up coding agent sessions. Ask for explicit consent before enabling this source: Shepherd will read local Codex and Claude Code session logs, redact sensitive strings locally, and sync repo/title metadata plus structured user messages and agent responses, not raw JSONL lines, tool results, command output, or local summaries.",
    "Do not inspect the user's folders or repositories to set this up. Do not run ls/find/rg/grep/cat/Read/Glob/Explore against the user's home directory, repos, ~/.codex, ~/.claude, or ~/.shepherd. Use only the Shepherd CLI commands below and the status result they print.",
    "",
    alreadyConfigured
      ? "Current state: Coding Sessions already has a local config. Check whether the LaunchAgent is running and whether the last sync is healthy below."
      : "Current state: Coding Sessions is not configured locally yet.",
    "",
    "Commands to run locally:",
    `1. If there is no saved Shepherd login, run: ${status.commands.login}`,
    `2. Add only this source: ${command}`,
    `3. Finish/install the local agent: ${status.commands.continueSetup}`,
    `4. Verify: ${status.commands.checkStatus}`,
    "",
    "Current local status:",
    renderLocalCodingSessionsStatus(status.local.codingSessions).join("\n"),
  ].join("\n");
}

function renderOnboardingGuideMcpResult(status) {
  return [
    "Shepherd onboarding workflow",
    "",
    "Use the wrapper workflow as the source of truth for agent-led onboarding:",
    `  ${agentCommand()} guide`,
    "",
    "High-level flow:",
    "1. Ask where to install the Shepherd usage skill: Codex, Claude Code, both, or skip.",
    `   Command: ${agentCommand()} skill --install <codex|claude|all>`,
    "2. Ask source choices with a native multi-select UI/control when available.",
    "   Offer only sources the guide says are available. Ask explicit consent before Messages or Coding Sessions.",
    `3. Authenticate the Shepherd account with WorkOS: ${agentCommand()} login`,
    `4. Start onboarding with confirmed full name, org, and selected sources: ${agentCommand()} onboard --name "<full_name>" --org "<organization>" --sources "<sources>"`,
    `5. After each browser/admin/PAT/local permission step, run: ${agentCommand()} continue`,
    `6. Verify local setup and readiness: ${agentCommand()} status, ${agentCommand()} shepherd_wiki_status, ${agentCommand()} tools --json`,
    `7. Ask where to install Shepherd MCP for querying: ${agentCommand()} mcp-login --install <codex|claude|all>`,
    "",
    "Messages guardrails: require explicit consent, Full Disk Access, and selected chats from messages-chats; never sync all chats by default.",
    "Coding Sessions guardrails: require explicit consent; Shepherd syncs bounded redacted Codex/Claude Code session metadata, not raw logs.",
    "Wiki readiness guardrail: if shepherd_wiki_status returns wiki_not_ready, say Shepherd is still learning and include progress/ETA instead of answering the memory question.",
    "",
    "Current local status:",
    renderShepherdStatus(status),
  ].join("\n");
}

function renderTroubleshootMcpResult(status) {
  const diagnostics = [];
  if (!status.configured || !status.account) {
    diagnostics.push([
      "No saved Shepherd onboarding session.",
      `Run ${agentCommand()} login, then ${agentCommand()} guide.`,
    ]);
  }
  if (status.productionError) {
    diagnostics.push([
      `Backend status is unavailable: ${status.productionError}`,
      `Run ${agentCommand()} login, then ${agentCommand()} continue.`,
    ]);
  }
  for (const source of statusSourceRows(status.providers, status.savedSources).filter((row) => row.selected && !row.connected)) {
    diagnostics.push([
      `${source.label} is selected but not connected.`,
      `Run ${agentCommand()} continue and complete the current modality it prints.`,
    ]);
  }
  if (status.local.messages.configPath && status.local.messages.storage?.readable === false) {
    diagnostics.push([
      "Messages database is not readable.",
      `Grant Full Disk Access to the onboarding app and Node.js, then run ${agentCommand()} messages-chats.`,
    ]);
  }
  if (status.local.messages.configPath && status.local.messages.launch?.running === false) {
    diagnostics.push([
      "Messages LaunchAgent is installed but not running.",
      `Run ${agentCommand()} status after fixing Full Disk Access; rerun continue if status asks for it.`,
    ]);
  }
  if (status.local.codingSessions.configPath && status.local.codingSessions.launch?.running === false) {
    diagnostics.push([
      "Coding Sessions LaunchAgent is installed but not running.",
      `Run ${agentCommand()} coding-sessions-status, then ${agentCommand()} continue if status asks for setup repair.`,
    ]);
  }
  const readiness = wikiReadinessPayloadFromStatus(status);
  if (readiness.status === "wiki_not_ready") {
    diagnostics.push([
      "Wiki is still building.",
      "This is not a setup failure. Tell the user Shepherd is still learning and include progress/ETA from shepherd_wiki_status.",
    ]);
  }
  if (diagnostics.length === 0) {
    diagnostics.push([
      "No obvious local onboarding blocker found.",
      `Run ${agentCommand()} tools --json and use exact listed tool names.`,
    ]);
  }
  return [
    "Shepherd troubleshooting",
    "",
    ...diagnostics.flatMap(([symptom, fix], index) => [
      `${index + 1}. ${symptom}`,
      `   Fix: ${fix}`,
    ]),
    "",
    "Current local status:",
    renderShepherdStatus(status),
    "",
    `Full workflow: ${agentCommand()} guide`,
  ].join("\n");
}

function localMcpTextResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

async function pollMcpLogin(apiUrl, started) {
  const intervalMs = Math.max(1000, Number(started.intervalSeconds ?? 5) * 1000);
  const expiresAt = Date.parse(started.expiresAt ?? "") || Date.now() + 600_000;
  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    const response = await fetch(
      `${apiUrl}/mcp/auth/${encodeURIComponent(started.authSessionId)}/poll`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-shepherd-mcp-token": started.authSessionToken,
        },
        body: JSON.stringify({ authSessionToken: started.authSessionToken }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (response.status === 202) continue;
    if (!response.ok) throw new Error(safeError(body?.error ?? `Shepherd MCP login poll failed (${response.status})`));
    if (body.status === "authenticated" && body.mcp?.token) return body;
  }
  throw new Error("Shepherd MCP login expired before it completed.");
}

async function writeMcpState(state) {
  const path = mcpStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function sanitizeUserFileId(userId) {
  const safeId = String(userId ?? "").replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safeId || safeId === "." || safeId === ".." || /^\.+$/.test(safeId)) {
    throw new Error("Onboarding returned an invalid user ID for local Messages config.");
  }
  return safeId;
}

function mcpStatePath() {
  return expandHomePath(stringArg("state") ?? DEFAULT_MCP_STATE_PATH);
}

async function selectMcpInstallTargets(opts = {}) {
  if (args["no-install"]) return [];
  const explicit = stringArg("install") ?? (args.install === true ? "all" : undefined);
  if (explicit) return parseMcpInstallTargets(explicit);
  if (args.json) return [];
  if (!process.stdin.isTTY) return opts.defaultTargets ?? MCP_INSTALL_TARGETS;

  const answer = await prompt(
    "Install Shepherd MCP for Codex and Claude Code? [all/codex,claude/none] (default: all): ",
  );
  return parseMcpInstallTargets(answer || "all");
}

function parseMcpInstallTargets(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "all" || raw === "yes" || raw === "true") return [...MCP_INSTALL_TARGETS];
  if (raw === "none" || raw === "no" || raw === "false" || raw === "skip") return [];
  const aliases = new Map([
    ["codex-cli", "codex"],
    ["claude-code", "claude"],
    ["claude", "claude"],
  ]);
  const targets = raw
    .split(/[,\s]+/)
    .map((target) => aliases.get(target) ?? target)
    .filter(Boolean);
  for (const target of targets) {
    if (!MCP_INSTALL_TARGETS.includes(target)) {
      throw new Error(`Unknown MCP install target "${target}". Use all, none, codex, or claude.`);
    }
  }
  return [...new Set(targets)];
}

async function installMcpClients({ statePath, targets, proxyProgram }) {
  const results = [];
  const proxy = mcpProxyCommand(statePath, proxyProgram);
  for (const target of targets) {
    try {
      if (target === "codex") {
        await installCodexMcp(proxy);
      } else if (target === "claude") {
        await installClaudeMcp(proxy);
      }
      results.push({ target, status: "installed" });
    } catch (err) {
      results.push({ target, status: "failed", error: safeError(err) });
    }
  }
  return results;
}

async function installCodexMcp(proxy) {
  await execFileQuiet("codex", ["mcp", "remove", MCP_SERVER_NAME], { ignoreError: true });
  await execFileQuiet("codex", ["mcp", "add", MCP_SERVER_NAME, "--", proxy.command, ...proxy.args]);
}

async function installClaudeMcp(proxy) {
  await execFileQuiet("claude", ["mcp", "remove", MCP_SERVER_NAME], { ignoreError: true });
  await execFileQuiet("claude", ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", proxy.command, ...proxy.args]);
}

function mcpProxyCommand(statePath, proxyProgram) {
  const prefix = Array.isArray(proxyProgram) && proxyProgram.length > 0
    ? proxyProgram
    : ["npx", "-y", PACKAGE_SPEC];
  return {
    command: prefix[0],
    args: [...prefix.slice(1), "mcp", "--state", statePath],
  };
}

function mcpProxyArgs(statePath) {
  return mcpProxyCommand(statePath).args;
}

async function readJsonObject(path) {
  try {
    const text = await readFile(path, "utf8");
    if (!text.trim()) return {};
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON root must be an object");
    }
    return value;
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

function printMcpInstallResults(results) {
  console.log("\nMCP client install:");
  for (const result of results) {
    if (result.status === "installed") console.log(`- ${result.target}: installed`);
    else console.log(`- ${result.target}: failed (${result.error})`);
  }
}

async function continueAgentOnboarding() {
  let state = await readAgentState();
  const body = { sessionToken: state.sessionToken };
  const githubToken = stringArg("github-token");
  const githubRepoFullName = stringArg("github-repo");
  const granolaApiKey = stringArg("granola-api-key");
  const messagesHandles = parseMessageHandleList(stringArg("messages-handle"));
  const messagesHandle = messagesHandles[0] ?? null;
  const selectedMessageChatIds = parseMessageChatIdsArg();
  if (githubToken) body.githubToken = githubToken;
  if (githubRepoFullName) body.githubRepoFullName = githubRepoFullName;
  if (granolaApiKey) body.granolaApiKey = granolaApiKey;
  if (messagesHandle) body.imessage = { handle: messagesHandle, handles: messagesHandles };
  if (state.sources.messages && messagesHandle && selectedMessageChatIds.length === 0) {
    throw new Error(`Messages sync requires selected chat IDs. Run ${agentCommand()} messages-chats, have the user select chats in the browser page, then rerun --continue with --messages-chat-ids "<id1>,<id2>" or --messages-chat-ids all.`);
  }

  const finalized = await postJson(
    `${state.apiUrl}/onboarding/raw/session/${encodeURIComponent(state.sessionId)}/finalize`,
    body,
    { token: state.sessionToken, allowConflict: true },
  );
  state = await updateAgentStateFromOnboardingResponse(state, finalized);

  if (finalized.connected?.messages?.agentToken) {
    const selectedChats = selectedChatIdsIncludeAll(selectedMessageChatIds)
      ? [allMessagesChatsSelection()]
      : await loadSelectedMessageChatsForConfig(selectedMessageChatIds).catch((err) => {
          console.warn(`Could not load selected Messages chat metadata for contact hydration: ${safeError(err)}`);
          return [];
        });
    const configPath = await writeMessagesConfig({
      apiUrl: state.apiUrl,
      userId: state.sessionId,
      agentToken: finalized.connected.messages.agentToken,
      handle: messagesHandle,
      handles: messagesHandles,
      backfillDays: parseMessagesInitialBackfillDays(args["messages-backfill-days"]),
      allowedChatIds: selectedMessageChatIds,
      selectedChats,
    });

    if (!args["no-install-messages-agent"]) {
      await explainMessagesBackgroundPermissions({ noOpen: Boolean(args["no-open"]), waitForUser: false });
      const install = await installMessagesAgent(configPath, state.sessionId).catch((err) => ({ error: safeError(err) }));
      if ("error" in install) {
        console.log(`Messages credentials saved: ${configPath}`);
        console.log(`Messages background sync was not started: ${install.error}`);
      } else {
        console.log(`Messages background sync started: ${install.label}`);
      }
    } else {
      console.log(`Messages credentials saved: ${configPath}`);
    }
  }

  if (finalized.connected?.codingSessions?.agentToken) {
    const configPath = await writeCodingSessionsConfig({
      apiUrl: state.apiUrl,
      userId: state.sessionId,
      agentToken: finalized.connected.codingSessions.agentToken,
      intervalSeconds: Number(args["coding-sessions-interval-seconds"] ?? 60),
    });

    if (!args["no-install-coding-sessions-agent"]) {
      const install = await installCodingSessionsAgent(configPath, state.sessionId).catch((err) => ({
        error: safeError(err),
      }));
      if ("error" in install) {
        console.log(`Coding-session credentials saved: ${configPath}`);
        console.log(`Coding-session background sync was not started: ${install.error}`);
      } else {
        console.log(`Coding-session background sync started: ${install.label}`);
      }
    } else {
      console.log(`Coding-session credentials saved: ${configPath}`);
    }
  }

  const errors = finalized.errors && Object.keys(finalized.errors).length ? finalized.errors : null;
  const currentAction = errors
    ? await openNextAgentModality({
        sources: state.sources,
        authUrls: state.authUrls ?? {},
        noOpen: Boolean(args["no-open"]),
        pendingSources: pendingAgentSources(state.sources, errors),
      })
    : null;
  if (args.json) {
    console.log(JSON.stringify({
      status: errors ? "waiting" : "completed",
      connected: Object.keys(finalized.connected ?? {}),
      alreadyConnected: Object.keys(finalized.alreadyConnected ?? {}),
      processingEnabled: finalized.processingEnabled === true,
      processing: finalized.processing,
      errors: errors ? safeErrorRecord(errors) : undefined,
      currentAction,
      nextCommand: errors ? `${agentCommand()} agent --continue --github-token "<github_pat>" --github-repo "<owner/repo>" --messages-handle "<phone_or_apple_id[,apple_id]>" --messages-chat-ids "<comma_separated_chat_ids_or_all>" --granola-api-key "<legacy_granola_key>"` : undefined,
      mcpInstall: errors ? undefined : {
        prompt: "Ask where to install Shepherd MCP for this customer: Codex, Claude Code, both, or none.",
        targets: MCP_INSTALL_TARGETS,
        command: `${agentCommand()} mcp-login --install "<targets>"`,
      },
    }, null, 2));
    return;
  }

  if (errors) {
    console.log("\nShepherd raw onboarding is not finished yet.");
    for (const [source, message] of Object.entries(errors)) {
      console.log(`- ${source}: ${safeError(message)}`);
    }

    printAgentCurrentAction(currentAction, {
      googleWorkspaceDelegation: state.googleWorkspaceDelegation,
    });

    console.log("\nAfter that modality is complete, rerun:");
    console.log(`   ${agentCommand()} agent --continue --github-token "<github_pat>" --github-repo "<owner/repo>" --messages-handle "<phone_or_apple_id[,apple_id]>" --messages-chat-ids "<comma_separated_chat_ids_or_all>" --granola-api-key "<legacy_granola_key>"`);
    console.log("   Omit either optional flag if that source is not being connected.");
    return;
  }

  console.log("\nShepherd raw onboarding completed.");
  console.log(`Connected sources: ${Object.keys(finalized.connected ?? {}).join(", ") || "none"}`);
  printProcessingSummary(finalized);
  console.log("\nAsk the user where to install Shepherd MCP for this customer: Codex, Claude Code, both, or none.");
  console.log(`If they choose any targets, run: ${agentCommand()} mcp-login --install <codex,claude>`);
}

async function printAgentStatus() {
  await runStatusCommand();
}

async function runStatusCommand() {
  const status = await collectShepherdStatus();
  if (args.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  printShepherdStatus(status);
}

async function collectShepherdStatus() {
  const statePath = agentStatePath();
  let state = await readOptionalAgentState();
  let production = null;
  let productionError = null;

  if (state?.apiUrl && state?.sessionId && state?.sessionToken) {
    try {
      production = await getJson(
        `${trimTrailingSlash(state.apiUrl)}/onboarding/raw/session/${encodeURIComponent(state.sessionId)}/status`,
        { token: state.sessionToken },
      );
      state = await updateAgentStateFromOnboardingResponse(state, production);
    } catch (err) {
      productionError = safeError(err);
    }
  }

  const userId = production?.sessionId ?? state?.sessionId ?? null;
  const providers = production?.providers ?? state?.providers ?? {};
  const messagesLocal = await collectMessagesLocalStatus(userId);
  const codingSessionsLocal = await collectCodingSessionsLocalStatus(userId);

  return {
    statePath,
    configured: Boolean(state),
    account: production?.account ?? state?.account ?? null,
    savedSources: state?.sources ?? {},
    providers,
    production: production
      ? {
          status: production.status,
          providers,
          rawOnly: production.rawOnly === true,
          processingEnabled: production.processingEnabled === true,
          processing: production.processing,
          wiki: production.wiki ?? null,
        }
      : null,
    productionError,
    local: {
      messages: messagesLocal,
      codingSessions: codingSessionsLocal,
    },
    commands: {
      login: `${agentCommand()} login`,
      checkStatus: `${agentCommand()} status`,
      addCodingSessions: `${agentCommand()} onboard --add-sources coding-sessions --name "<full_name>" --org "<organization>"`,
      continueSetup: `${agentCommand()} continue`,
      codingSessionsStatus: `${agentCommand()} coding-sessions-status`,
      messagesChats: `${agentCommand()} messages-chats`,
    },
  };
}

function printShepherdStatus(status) {
  console.log(renderShepherdStatus(status));
}

function renderShepherdStatus(status) {
  const lines = ["", "Shepherd sync status", ""];

  if (status.account) {
    const email = status.account.email ? ` <${status.account.email}>` : "";
    const org = status.account.organizationName ? ` / ${status.account.organizationName}` : "";
    lines.push(`Account: ${status.account.name ?? "unknown"}${email}${org}`);
  } else {
    lines.push("Account: no saved Shepherd onboarding session found");
  }

  if (status.productionError) {
    lines.push(`Production status: unavailable (${status.productionError})`);
  } else if (status.production) {
    lines.push(`Production status: ${status.production.status ?? "unknown"}`);
    lines.push(`Downstream processing: ${status.production.processingEnabled ? "enabled" : "not enabled"}`);
    lines.push(renderWikiReadinessSummary(wikiReadinessPayloadFromStatus(status)));
  } else {
    lines.push("Production status: not checked");
  }

  lines.push("", "Sources:");
  for (const source of statusSourceRows(status.providers, status.savedSources)) {
    const label = source.connected
      ? "connected"
      : source.seen
        ? "not connected"
        : source.selected
          ? "selected in saved setup; connection unknown"
          : "not enabled in saved setup";
    lines.push(`- ${source.label}: ${label}`);
  }

  lines.push("", "Local sync:");
  lines.push(...renderLocalMessagesStatus(status.local.messages));
  lines.push(...renderLocalCodingSessionsStatus(status.local.codingSessions));

  lines.push("", "Useful commands:");
  if (!status.configured) lines.push(`- Sign in: ${status.commands.login}`);
  lines.push(`- Check again: ${status.commands.checkStatus}`);
  lines.push(`- Add coding sessions: ${status.commands.addCodingSessions}`);
  lines.push(`- Continue pending setup: ${status.commands.continueSetup}`);
  return lines.join("\n");
}

function statusSourceRows(providers, savedSources = {}) {
  const definitions = [
    ["google", "Google Workspace", "google"],
    ["notion", "Notion", "notion"],
    ["slack", "Slack", "slack"],
    ["github", "GitHub", "github"],
    ["granola", "Granola", "granola"],
    ["messages", "Messages", "messages"],
    ["discord", "Discord", "discord"],
    ["instagram", "Instagram", "instagram"],
    ["codingSessions", "Coding Sessions", "codingSessions"],
  ];
  return definitions.map(([key, label, sourceKey]) => ({
    key,
    label,
    seen: Boolean(providers?.[key]),
    selected: savedSources?.[sourceKey] === true,
    connected: providers?.[key]?.connected === true,
  }));
}

function printLocalMessagesStatus(status) {
  console.log(renderLocalMessagesStatus(status).join("\n"));
}

function renderLocalMessagesStatus(status) {
  const lines = [];
  const prefix = "- Messages local agent";
  if (!status.configPath) {
    lines.push(`${prefix}: not configured`);
  } else {
    lines.push(`${prefix}: configured at ${status.configPath}`);
  }
  if (status.launch) {
    lines.push(`  LaunchAgent: ${status.launch.label} ${status.launch.running ? "running" : "not running or unknown"}`);
  } else {
    lines.push("  LaunchAgent: not installed or unavailable");
  }
  lines.push(`  Messages database: ${status.storage.readable ? "readable" : `not readable (${status.storage.reason})`}`);
  if (status.contacts) {
    lines.push(`  Contacts: ${status.contacts.ok ? "resolved from AddressBook DB" : `degraded (${status.contacts.error ?? "unsupported local Contacts database schema"}; contact founders@askshepherd.ai)`}`);
  }
  if (status.backfillProgress) {
    lines.push(`  Backfill: ${formatLocalMessagesBackfillStatus(status.backfillProgress)}`);
  }
  lines.push(`  Queued unsent messages: ${status.queueDepth}`);
  return lines;
}

function formatLocalMessagesBackfillStatus(progress) {
  const status = progress.status ?? "unknown";
  const total = progress.estimatedTotalMessages == null ? "" : `/${progress.estimatedTotalMessages}`;
  const eta = progress.etaSeconds == null ? "ETA unknown" : `ETA ${formatDuration(progress.etaSeconds)}`;
  return `${status}, scanned ${progress.scannedMessages ?? 0}${total}, sent ${progress.sentMessages ?? 0}, queued ${progress.queuedMessages ?? 0}, ${progress.ratePerMinute ?? 0}/min, ${eta}`;
}

function printLocalCodingSessionsStatus(status) {
  console.log(renderLocalCodingSessionsStatus(status).join("\n"));
}

function renderLocalCodingSessionsStatus(status) {
  const lines = [];
  const prefix = "- Coding Sessions local agent";
  if (!status.configPath) {
    lines.push(`${prefix}: not configured`);
  } else {
    lines.push(`${prefix}: configured at ${status.configPath}`);
  }
  if (status.launch) {
    lines.push(`  LaunchAgent: ${status.launch.label} ${status.launch.running ? "running" : "not running or unknown"}`);
  } else {
    lines.push("  LaunchAgent: not installed or unavailable");
  }
  for (const probe of status.localFolders) {
    lines.push(`  ${probe.provider}: ${probe.path} ${probe.readable ? "readable" : `not readable (${probe.reason})`}`);
  }
  if (status.lastSync) {
    const uploadable = status.lastSync.uploadable ?? status.lastSync.scanned ?? 0;
    const ignored = status.lastSync.filesIgnored ?? null;
    const ignoredText = ignored == null ? "" : `, ${ignored} ignored`;
    lines.push(`  Last sync: ${status.lastSync.finishedAt ?? "unknown"} (${uploadable} uploadable, ${status.lastSync.changed ?? 0} changed${ignoredText})`);
    const providerStatus = status.lastSync.providerStatus && typeof status.lastSync.providerStatus === "object" && !Array.isArray(status.lastSync.providerStatus)
      ? status.lastSync.providerStatus
      : {};
    for (const provider of ["codex", "claude"]) {
      const info = providerStatus[provider];
      if (!info || typeof info !== "object" || Array.isArray(info)) continue;
      lines.push(`    ${provider}: ${info.uploadable ?? info.scanned ?? 0} uploadable${info.filesIgnored == null ? "" : `, ${info.filesIgnored} ignored`}`);
    }
  } else {
    lines.push("  Last sync: none recorded");
  }
  lines.push(`  Queued unsent sessions: ${status.queueDepth}`);
  return lines;
}

async function runWriteAgentState() {
  const input = await readJsonInput();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("write-agent-state expects a JSON object on stdin.");
  }
  const channel = cliChannel(input.channel);
  const previous = await readOptionalAgentState();
  const statePath = await writeAgentState({ ...(previous ?? {}), ...input, ...channelRecord(channel) });
  console.log(JSON.stringify({ statePath }, null, 2));
}

async function runWriteMessagesConfig() {
  const input = await readJsonInput();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("write-messages-config expects a JSON object on stdin.");
  }
  const configPath = await writeMessagesConfig({
    apiUrl: trimTrailingSlash(requiredConfigString(input.apiUrl, "apiUrl")),
    userId: requiredConfigString(input.userId, "userId"),
    agentToken: requiredConfigString(input.agentToken, "agentToken"),
    handle: optionalString(input.handle),
    handles: input.handles,
    backfillDays: parseMessagesInitialBackfillDays(
      Object.prototype.hasOwnProperty.call(input, "backfillDays") ? input.backfillDays : undefined,
    ),
    allowedChatIds: input.allowedChatIds,
    selectedChats: Array.isArray(input.selectedChats) ? input.selectedChats : [],
    channel: cliChannel(input.channel),
  });
  console.log(JSON.stringify({ configPath }, null, 2));
}

async function runWriteCodingSessionsConfig() {
  const input = await readJsonInput();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("write-coding-sessions-config expects a JSON object on stdin.");
  }
  const configPath = await writeCodingSessionsConfig({
    apiUrl: trimTrailingSlash(requiredConfigString(input.apiUrl, "apiUrl")),
    userId: requiredConfigString(input.userId, "userId"),
    agentToken: requiredConfigString(input.agentToken, "agentToken"),
    intervalSeconds: Number(input.intervalSeconds ?? args["coding-sessions-interval-seconds"] ?? 60),
    providers: input.providers,
    channel: cliChannel(input.channel),
  });
  console.log(JSON.stringify({ configPath }, null, 2));
}

async function runWriteOfficeAudioConfig() {
  const input = await readJsonInput();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("write-office-audio-config expects a JSON object on stdin.");
  }
  const configPath = await writeOfficeAudioConfig({
    apiUrl: trimTrailingSlash(requiredConfigString(input.apiUrl, "apiUrl")),
    userId: requiredConfigString(input.userId, "userId"),
    agentToken: requiredConfigString(input.agentToken, "agentToken"),
    roomProfileId: optionalString(input.roomProfileId),
    sourceSessionId: optionalString(input.sourceSessionId),
    roomOwnerUserId: optionalString(input.roomOwnerUserId),
    roomCode: optionalString(input.roomCode),
    space: input.space,
    deviceId: optionalString(input.deviceId),
    inputDeviceUid: optionalString(input.inputDeviceUid),
    spoolDir: optionalString(input.spoolDir),
    chunkDir: optionalString(input.chunkDir),
    speakerProfilesDir: optionalString(input.speakerProfilesDir),
    captureMode: optionalString(input.captureMode),
    chunkSeconds: input.chunkSeconds,
    localAudioKey: optionalString(input.localAudioKey),
    localAudioKeyId: optionalString(input.localAudioKeyId),
    collectorCommand: input.collectorCommand,
    processorCommand: input.processorCommand,
    enrollmentProviderCommand: input.enrollmentProviderCommand,
    speakerDisplayName: optionalString(input.speakerDisplayName),
    syncSpeakerProfiles: input.syncSpeakerProfiles,
    intervalSeconds: Number(input.intervalSeconds ?? args["interval-seconds"] ?? 30),
    channel: cliChannel(input.channel),
  });
  console.log(JSON.stringify({ configPath }, null, 2));
}

async function runInstallMessagesAgent() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("install-messages-agent requires --config <path>");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    throw new Error(`install-messages-agent: config file at ${configPath} does not contain valid JSON.`);
  }
  const userId = stringArg("user-id") ?? requiredConfigString(config.userId, "userId");
  const channel = cliChannel(config.channel);
  const overrides = {
    programArguments: parseJsonArrayArg("program"),
    environment: parseJsonObjectArg("env"),
    channel,
  };

  if (args["dry-run"]) {
    console.log(JSON.stringify(buildMessagesAgentInstall(configPath, userId, overrides), null, 2));
    return;
  }

  const install = await installMessagesAgent(configPath, userId, overrides);
  console.log(JSON.stringify(install, null, 2));
}

async function runResetMessagesBackfill() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("reset-messages-backfill requires --config <path>");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    throw new Error(`reset-messages-backfill: config file at ${configPath} does not contain valid JSON.`);
  }

  const userId = stringArg("user-id") ?? requiredConfigString(config.userId, "userId");
  const resetBackfillOverride = args["backfill-days"];
  const backfillDays = resetBackfillOverride !== undefined && resetBackfillOverride !== null && resetBackfillOverride !== ""
    ? parseBackfillDays(resetBackfillOverride, DEFAULT_MESSAGES_BACKFILL_DAYS)
    : messagesBackfillDaysFromConfig(config);
  const allowedChatIds = parseAllowedChatIds(config.allowedChatIds);
  const allChats = config.allChats === true || selectedChatIdsIncludeAll(allowedChatIds);
  if (!allChats && allowedChatIds.length === 0) {
    throw new Error("Messages config must include selected chat IDs or allChats=true before resetting backfill.");
  }

  const scope = messagesBackfillScope({ backfillDays, allChats, allowedChatIds });
  const completeCleared = clearMessagesBackfillComplete(userId, scope);
  const progressCleared = clearMessagesBackfillProgress(userId, scope);
  console.log(JSON.stringify({
    userId,
    scope,
    cleared: {
      complete: completeCleared,
      progress: progressCleared,
    },
  }, null, 2));
}

async function runInstallCodingSessionsAgent() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("install-coding-sessions-agent requires --config <path>");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    throw new Error(`install-coding-sessions-agent: config file at ${configPath} does not contain valid JSON.`);
  }
  const userId = stringArg("user-id") ?? requiredConfigString(config.userId, "userId");
  const channel = cliChannel(config.channel);
  const overrides = {
    programArguments: parseJsonArrayArg("program"),
    environment: parseJsonObjectArg("env"),
    channel,
  };

  if (args["dry-run"]) {
    console.log(JSON.stringify(buildCodingSessionsAgentInstall(configPath, userId, overrides), null, 2));
    return;
  }

  const install = await installCodingSessionsAgent(configPath, userId, overrides);
  console.log(JSON.stringify(install, null, 2));
}

async function runInstallOfficeAudioAgent() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("install-office-audio-agent requires --config <path>");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    throw new Error(`install-office-audio-agent: config file at ${configPath} does not contain valid JSON.`);
  }
  const userId = stringArg("user-id") ?? requiredConfigString(config.userId, "userId");
  const channel = cliChannel(config.channel);
  const overrides = {
    programArguments: parseJsonArrayArg("program"),
    environment: parseJsonObjectArg("env"),
    channel,
  };

  if (args["dry-run"]) {
    console.log(JSON.stringify(buildOfficeAudioAgentInstall(configPath, userId, overrides), null, 2));
    return;
  }

  const install = await installOfficeAudioAgent(configPath, userId, overrides);
  console.log(JSON.stringify(install, null, 2));
}

async function readJsonInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Expected JSON input on stdin.");
  return JSON.parse(text);
}

function parseJsonArrayArg(name) {
  const raw = stringArg(name);
  if (!raw) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--${name} must be a JSON array of strings.`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`--${name} must be a JSON array of strings.`);
  }
  return parsed;
}

function parseJsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObjectArg(name) {
  const raw = stringArg(name);
  if (!raw) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--${name} must be a JSON object of string values.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error(`--${name} must be a JSON object of string values.`);
  }
  return parsed;
}

async function runMessagesChatsCommand() {
  await ensureMessagesReadPermission({ noOpen: Boolean(args["no-open"]) });
  const contactLookup = buildContactLookup({ warn: false });
  const contacts = contactLookup.contactsStatus();
  if (!contacts.ok && !args.json) await openContactsPrivacySettings({ noOpen: Boolean(args["no-open"]) });
  const explicitChatIds = parseAllowedChatIds(args["chat-ids"] ?? args["messages-chat-ids"] ?? args["message-chat-ids"]);
  if (explicitChatIds.length > 0) {
    const chats = selectedChatIdsIncludeAll(explicitChatIds)
      ? []
      : await loadSelectedMessageChatsForConfig(explicitChatIds, contactLookup);
    if (args.json) {
      console.log(JSON.stringify({ chats, contacts }, null, 2));
      return;
    }
    printMessagesContactsStatus(contacts);
    if (chats.length === 0) {
      console.log("No matching local Messages chats were found.");
      return;
    }
    for (const chat of chats) console.log(formatMessageChatOption(chat));
    return;
  }

  const chats = await listRecentMessageChats({
    limit: clampInt(Number(args.limit ?? DEFAULT_MESSAGE_CHAT_SEARCH_LIMIT), 1, 500),
    search: stringArg("search") ?? stringArg("query"),
    contactLookup,
  });

  if (args.json) {
    console.log(JSON.stringify({ chats, contacts }, null, 2));
    return;
  }
  printMessagesContactsStatus(contacts);

  if (!args.text && !args.list) {
    const selected = await selectChatsInBrowser(chats, { noOpen: Boolean(args["no-open"]) });
    const selectedIds = selectedIncludesAllChats(selected) ? "all" : selected.map((chat) => chat.chatId).join(",");
    console.log(selectedIncludesAllChats(selected)
      ? "\nSelected all current and future Messages chats."
      : `\nSelected ${selected.length} Messages chat(s).`);
    console.log(`messages-chat-ids=${selectedIds}`);
    console.log("\nContinue with:");
    console.log(`  ${agentCommand()} agent --continue --messages-handle "<phone_or_apple_id[,apple_id]>" --messages-chat-ids "${selectedIds}"`);
    return;
  }

  console.log(`\nRecent local Messages chats (${chats.length})\n`);
  for (let i = 0; i < chats.length; i++) {
    console.log(`${String(i + 1).padStart(2, " ")}. ${formatMessageChatOption(chats[i])}`);
    console.log(`    ${chats[i].chatId}`);
  }
  console.log("\nPass selected IDs to:");
  console.log(`  ${agentCommand()} agent --continue --messages-handle "<phone_or_apple_id[,apple_id]>" --messages-chat-ids "<id1>,<id2>"`);
  console.log(`  Or explicitly sync all current and future chats with: --messages-chat-ids all`);
}

async function runMessagesAgent() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("messages-agent requires --config <path>");

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const apiUrl = requiredConfigString(config.apiUrl, "apiUrl");
  const userId = requiredConfigString(config.userId, "userId");
  const agentToken = requiredConfigString(config.agentToken, "agentToken");
  const channel = setRuntimeLaunchAgentChannel(config.channel);
  const deviceId = loadOrCreateShepherdDeviceId(channel);
  const agentMetadata = { deviceId, agentVersion: PACKAGE_VERSION, agentChannel: channel };
  mergeShepherdOwnedMessageHandles(config.excludedMessageHandles);
  const backfillOverride = args["backfill-days"] ?? process.env.SHEPHERD_BACKFILL_DAYS;
  const backfillExplicit = backfillOverride !== undefined && backfillOverride !== null && backfillOverride !== "";
  const backfillDays = backfillExplicit
    ? parseBackfillDays(backfillOverride, DEFAULT_MESSAGES_BACKFILL_DAYS)
    : messagesBackfillDaysFromConfig(config);
  const allowedChatIds = parseAllowedChatIds(config.allowedChatIds);
  const allChats = config.allChats === true || selectedChatIdsIncludeAll(allowedChatIds);
  if (!allChats && allowedChatIds.length === 0) {
    throw new Error("Messages config must include selected chat IDs or allChats=true. Re-run onboarding and select chats, or pass --messages-chat-ids all.");
  }

  const kit = await import("@photon-ai/imessage-kit");
  const sdk = new kit.IMessageSDK({ debug: args.debug === true });
  const sender = new MessagesBatchSender(apiUrl, agentToken, userId, channel, agentMetadata);
  const contactLookup = createMutableContactLookup(buildContactLookup({ userId, channel }));
  const serializer = createMessageSerializer(kit, contactLookup, agentMetadata);
  const stateCache = createMessageStateCache(userId, MESSAGES_STATE_CACHE_MAX, channel);
  const backfillGate = createMessagesBackfillGate();
  const contactSync = startMessagesContactSync(sender, contactLookup, {
    userId,
    channel,
    syncAllContacts: allChats,
    seedHandles: allChats ? [] : selectedChatContactSeedHandles(config.selectedChats, allowedChatIds),
    deferWhen: () => backfillGate.running,
  });
  let editDetector = null;
  let commandPoller = null;

  console.log("Shepherd Messages raw sync starting");
  console.log(allChats
    ? "Messages chat filter: all current and future chats"
    : `Messages chat filter: ${allowedChatIds.length} selected chat(s)`);

  try {
    await validateMessagesDatabaseAccess(sdk);
    console.log("Messages local database access validated");
    await contactSync.syncNow({ forceAll: true, reason: "startup" }).catch((err) => {
      console.error("Initial Messages contact sync failed:", safeError(err));
    });
    await loadGroupChatNames(sdk, serializer);
    loadSelectedChatNames(config.selectedChats, serializer);
    const startupCommand = await sender.fetchCommand().catch((err) => {
      console.error("Initial Messages command fetch failed:", safeError(err));
      return null;
    });
    const deferConfiguredBackfillForCommand = Boolean(startupCommand?.id);
    let remoteCommandPending = deferConfiguredBackfillForCommand;
    if (deferConfiguredBackfillForCommand) {
      console.log(`Deferring configured Messages backfill because remote command ${startupCommand.id} is pending`);
    }

    const backfillScope = messagesBackfillScope({ backfillDays, allChats, allowedChatIds });
    let backfillComplete = loadMessagesBackfillComplete(userId, backfillScope);
    let backfillPending = false;
    if (backfillExplicit) {
      clearMessagesBackfillComplete(userId, backfillScope);
      clearMessagesBackfillProgress(userId, backfillScope);
      backfillComplete = null;
    }
    if (!deferConfiguredBackfillForCommand && shouldRunMessagesBackfill({ backfillDays, backfillExplicit, backfillComplete })) {
      const backfillResult = await runMessagesBackfill(sdk, sender, serializer, backfillDays, allChats ? null : allowedChatIds, contactSync, stateCache);
      if (backfillResult.complete) {
        backfillComplete = saveMessagesBackfillComplete(userId, backfillScope, backfillResult);
      } else {
        backfillPending = true;
        console.warn("Messages backfill paused before completion because messages were queued for retry");
      }
      await contactSync.syncNow({ forceAll: true, reason: "post-backfill" }).catch((err) => {
        console.error("Post-backfill Messages contact sync failed:", safeError(err));
      });
    } else if (!deferConfiguredBackfillForCommand && backfillDays !== 0) {
      console.log(`Skipping configured Messages backfill because this chat scope is already complete; use --backfill-days to force a historical backfill`);
    }

    if (!deferConfiguredBackfillForCommand && !backfillPending) {
      await gapFillFromWatermark(sdk, sender, serializer, userId, allChats ? null : allowedChatIds, contactSync, stateCache);
      await contactSync.syncNow({ forceAll: true, reason: "post-gap-fill" }).catch((err) => {
        console.error("Post-gap-fill Messages contact sync failed:", safeError(err));
      });
    }
    editDetector = startMessagesEditDetector(sdk, sender, serializer, allChats ? null : allowedChatIds, {
      contactSync,
      stateCache,
      deferWhen: () => backfillGate.running,
    });
    const backfillMaintenance = startMessagesBackfillMaintenance({
      sdk,
      sender,
      serializer,
      userId,
      backfillDays,
      allChats,
      allowedChatIds,
      contactSync,
      stateCache,
      backfillScope,
      backfillGate,
      enabled: shouldRunMessagesBackfill({ backfillDays, backfillExplicit, backfillComplete }),
      deferWhen: () => remoteCommandPending,
    });
    const queueDrain = startMessagesQueueDrain(sender, {
      deferWhen: () => backfillGate.running,
      onQueueDrained: (reason) => backfillMaintenance.kick?.(`queue-drained-${reason}`),
    });
    commandPoller = startMessagesCommandPoller({
      sdk,
      sender,
      serializer,
      userId,
      defaultBackfillDays: backfillDays,
      allChats,
      allowedChatIds,
      contactSync,
      stateCache,
      backfillGate,
      onIdle: () => {
        if (!remoteCommandPending) return;
        remoteCommandPending = false;
        backfillMaintenance.kick?.("remote-command-idle");
      },
      onCommandSettled: () => {
        if (!remoteCommandPending) return;
        remoteCommandPending = false;
        backfillMaintenance.kick?.("remote-command-settled");
      },
    });
    await watchMessages(sdk, sender, serializer, userId, allChats ? null : allowedChatIds, {
      contactSync,
      stateCache,
      onShutdown: () => {
        editDetector?.stop();
        queueDrain.stop();
        backfillMaintenance.stop();
        commandPoller?.stop();
      },
    });
  } catch (err) {
    editDetector?.stop();
    commandPoller?.stop();
    contactSync.stop();
    await sdk.close?.().catch(() => undefined);
    throw err;
  }
}

async function runCodingSessionsAgent() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("coding-sessions-agent requires --config <path>");

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const apiUrl = requiredConfigString(config.apiUrl, "apiUrl");
  const userId = requiredConfigString(config.userId, "userId");
  const agentToken = requiredConfigString(config.agentToken, "agentToken");
  const channel = setRuntimeLaunchAgentChannel(config.channel);
  const sender = new CodingSessionsBatchSender(apiUrl, agentToken, userId, channel);
  const statePath = codingSessionsStateFile(userId, channel);
  const statusPath = codingSessionsStatusFile(userId, channel);
  const intervalSeconds = Math.max(15, Math.floor(Number(args["interval-seconds"] ?? config.intervalSeconds ?? 60)));

  console.log("Shepherd Coding Sessions sync starting");
  while (true) {
    const startedAt = new Date().toISOString();
    const previous = readCodingSessionsState(statePath);
    let command = null;
    let commandResult = null;
    let commandError = null;
    try {
      command = await sender.fetchCommand();
    } catch (err) {
      commandError = `command_fetch_failed: ${safeError(err)}`;
      console.error("Coding sessions command fetch failed:", safeError(err));
    }

    const scan = await scanCodingSessions(config, previous, codingSessionsScanOptions(command, previous));
    const changed = scan.sessions.filter((session) => previous.hashes[session.sourcePathHash] !== session.contentHash);
    const commandPlan = codingSessionsCommandPlan(command, scan, previous);
    if (commandPlan.error) commandError = commandPlan.error;
    const selected = commandPlan.exactSelection
      ? commandPlan.sessions
      : dedupeCodingSessions([...changed, ...commandPlan.sessions]);
    const shouldSend = !commandPlan.error && (
      selected.length > 0 || (commandPlan.sourceSync && sender.queueDepth() > 0)
    );
    let sendResult = shouldSend
      ? await sender.send(selected, {
          force: commandPlan.force,
          bypassQueue: commandPlan.sourceSync ? false : commandPlan.exactSelection,
          queueOnFailure: commandPlan.sourceSync ? true : !commandPlan.exactSelection,
        })
      : { stored: 0, updated: 0, skipped: 0, queued: 0 };
    const remainingQueueDepth = commandPlan.sourceSync ? sender.queueDepth() : 0;
    const uploadQueued = Number(sendResult.queued ?? 0) > 0 || remainingQueueDepth > 0;
    if (uploadQueued) commandError = `upload_queued: ${sendResult.queued} session(s) queued for retry`;

    if (command) {
      commandResult = commandPlan.sourceSync
        ? codingSessionsSourceSyncReceipt({
            command,
            commandPlan,
            scan,
            sendResult,
            uploadQueued,
            remainingQueueDepth,
            startedAt,
            finishedAt: new Date().toISOString(),
          })
        : {
            ...commandPlan.result,
            sent: sendResult,
          };
      try {
        await sender.ackCommand(command.id, {
          status: uploadQueued || commandPlan.error ? "failed" : "completed",
          result: commandResult,
          ...(uploadQueued || commandPlan.error ? { error: commandError } : {}),
        });
      } catch (err) {
        commandError = `command_ack_failed: ${safeError(err)}`;
        console.error("Coding sessions command ack failed:", safeError(err));
      }
    }

    const nextState = {
      hashes: { ...previous.hashes },
      updatedAt: new Date().toISOString(),
    };
    if (!uploadQueued) {
      for (const session of selected) {
        nextState.hashes[session.sourcePathHash] = session.contentHash;
      }
    }
    writeFileSync(statePath, JSON.stringify(nextState, null, 2), { mode: 0o600 });
    const status = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      scanned: scan.sessions.length,
      uploadable: scan.sessions.length,
      filesDiscovered: scan.filesDiscovered ?? scan.sessions.length,
      filesSelected: scan.filesSelected ?? scan.sessions.length,
      filesIgnored: Math.max(0, Number(scan.filesDiscovered ?? scan.sessions.length) - scan.sessions.length),
      changed: changed.length,
      selected: selected.length,
      sent: sendResult,
      parserVersion: CODING_SESSION_PARSER_VERSION,
      providerStatus: codingSessionsProviderStatus(scan, previous, selected),
      command: command ? {
        id: command.id,
        type: command.type,
        payload: command.payload ?? {},
        result: commandResult,
        error: commandError,
      } : commandError ? { error: commandError } : null,
      probes: sanitizeCodingSessionProbes(scan.probes),
      errors: sanitizeCodingSessionErrors(scan.errors),
    };
    writeFileSync(statusPath, JSON.stringify(status, null, 2), { mode: 0o600 });
    console.log(`Coding session scan: ${scan.sessions.length} scanned, ${changed.length} changed, ${selected.length} selected, ${sendResult.stored ?? 0} stored, ${sendResult.updated ?? 0} updated, ${sendResult.skipped ?? 0} skipped`);

    if (args.once) return;
    await sleep(intervalSeconds * 1000);
  }
}

async function runOfficeAudioAgent() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("office-audio-agent requires --config <path>");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const apiUrl = requiredConfigString(config.apiUrl, "apiUrl");
  const userId = requiredConfigString(config.userId, "userId");
  const agentToken = requiredConfigString(config.agentToken, "agentToken");
  const channel = setRuntimeLaunchAgentChannel(config.channel);
  const safeId = safeFileId(userId);
  const rawDir = join(homedir(), ".shepherd", "office-audio");
  const spoolDir = config.spoolDir || join(rawDir, `${channelFilePrefix(channel)}spool`);
  const sentDir = join(rawDir, `${channelFilePrefix(channel)}sent`);
  const chunkDir = config.chunkDir || join(rawDir, `${channelFilePrefix(channel)}chunks`);
  const statusPath = join(rawDir, `${channelFilePrefix(channel)}${safeId}-status.json`);
  const controlPath = officeAudioControlFile(userId, channel);
  const intervalSeconds = Math.max(5, Math.floor(Number(args["interval-seconds"] ?? config.intervalSeconds ?? 30)));
  await mkdir(spoolDir, { recursive: true });
  await mkdir(sentDir, { recursive: true });
  await mkdir(chunkDir, { recursive: true });

  const sender = new OfficeAudioBatchSender(apiUrl, agentToken, userId);
  let collector = null;
  if (Array.isArray(config.collectorCommand) && config.collectorCommand.length > 0) {
    const child = spawn(config.collectorCommand[0], config.collectorCommand.slice(1), {
      cwd: rawDir,
      env: { ...process.env, SHEPHERD_OFFICE_AUDIO_SPOOL_DIR: spoolDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    collector = {
      mode: "external_command",
      kill: (signal) => child.kill(signal),
      status: () => ({ exitCode: child.exitCode, signalCode: child.signalCode }),
    };
  } else if (config.captureMode === "macos_afrecord") {
    collector = startOfficeAudioMacCollector({ config, userId, rawDir, chunkDir, controlPath });
  }

  console.log("Shepherd Office Audio agent starting");
  console.log(`Office Audio spool: ${spoolDir}`);
  console.log(collector ? `Office Audio collector: ${collector.mode}` : "Office Audio collector: transcript spool mode");
  console.log(`Office Audio processor: ${officeAudioConfiguredTranscriptionBackend(config)}`);

  const shutdown = () => {
    collector?.kill?.("SIGTERM");
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  while (true) {
    const startedAt = new Date().toISOString();
    let files = [];
    let sent = { stored: 0, updated: 0, skipped: 0 };
    let processed = null;
    let error = null;
    try {
      const control = readJsonOptional(controlPath);
      if (control?.paused === true) {
        files = [];
        console.log(`Office Audio paused: ${control.reason ?? "off record"}`);
      } else {
        const backend = officeAudioConfiguredTranscriptionBackend(config);
        if (backend !== "external_provider_command" || (Array.isArray(config.processorCommand) && config.processorCommand.length > 0)) {
          processed = await processOfficeAudioChunksFromConfig(config, {
            chunkDir,
            spoolDir,
            limit: Math.max(1, Math.floor(Number(config.processorBatchLimit ?? 24) || 24)),
            quiet: true,
          });
        }
        files = await officeAudioSpoolFiles(spoolDir);
        for (const filePath of files) {
          const parsed = JSON.parse(await readFile(filePath, "utf8"));
          const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [parsed];
          const result = await sender.send(sessions);
          sent = {
            stored: sent.stored + Number(result.stored ?? 0),
            updated: sent.updated + Number(result.updated ?? 0),
            skipped: sent.skipped + Number(result.skipped ?? 0),
          };
          const target = join(sentDir, `${Date.now()}-${basename(filePath)}`);
          await renameFile(filePath, target);
        }
      }
    } catch (err) {
      error = safeError(err);
      console.error(`Office Audio scan failed: ${error}`);
    }

    const status = {
      ok: !error,
      startedAt,
      finishedAt: new Date().toISOString(),
      spoolDir,
      chunkDir,
      queuedFiles: files.length,
      sent,
      processed,
      collector: collector
        ? { configured: true, mode: collector.mode, ...collector.status() }
        : { configured: false, mode: "transcript_spool" },
      paused: readJsonOptional(controlPath)?.paused === true,
      error,
    };
    writeFileSync(statusPath, JSON.stringify(status, null, 2), { mode: 0o600 });
    console.log(`Office Audio scan: ${files.length} file(s), ${sent.stored} stored, ${sent.updated} updated, ${sent.skipped} skipped${processed ? `, ${processed.processed} chunk(s) processed` : ""}`);

    if (args.once) return;
    await sleep(intervalSeconds * 1000);
  }
}

async function runOfficeAudioProcessChunks() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("office-audio-process-chunks requires --config <path>");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const channel = cliChannel(config.channel);
  const rawDir = join(homedir(), ".shepherd", "office-audio");
  const chunkDir = stringArg("chunk-dir") ?? config.chunkDir ?? join(rawDir, `${channelFilePrefix(channel)}chunks`);
  const spoolDir = stringArg("spool-dir") ?? config.spoolDir ?? join(rawDir, `${channelFilePrefix(channel)}spool`);
  const result = await processOfficeAudioChunksFromConfig(config, {
    chunkDir,
    spoolDir,
    limit: Math.max(1, Math.floor(Number(args.limit ?? 24) || 24)),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function processOfficeAudioChunksFromConfig(config, { chunkDir, spoolDir, limit = 24, quiet = false } = {}) {
  const providerCommandFromArgs = parseJsonArrayArg("provider-command");
  const providerCommand = providerCommandFromArgs
    ?? (Array.isArray(config.processorCommand) ? config.processorCommand.map((value) => String(value)) : null);
  const transcriptionBackend = officeAudioConfiguredTranscriptionBackend(config, {
    providerCommand,
    providerCommandFromArgs: Array.isArray(providerCommandFromArgs),
  });
  const arrayFinalizerCommand = parseJsonArrayArg("array-finalizer-command")
    ?? (Array.isArray(config.arrayFinalizerCommand) ? config.arrayFinalizerCommand.map((value) => String(value)) : null);
  if (transcriptionBackend === "external_provider_command" && (!providerCommand || providerCommand.length === 0)) {
    throw new Error("office-audio-process-chunks external_provider_command backend requires --provider-command JSON array or config.processorCommand.");
  }

  const skipIdentityAudited = transcriptionBackend === "external_provider_command" && (
    config.processorMode === "identity_audit"
    || providerCommand.join(" ").includes("office-audio-provider-pyannoteai")
  );
  const manifests = (await officeAudioRawChunkManifests(chunkDir, { skipIdentityAudited })).slice(0, limit);
  if (manifests.length === 0) {
    return { ok: true, processed: 0, reason: "no raw chunk manifests", chunkDir };
  }

  await mkdir(spoolDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "shepherd-office-audio-"));
  const localAudioKey = officeAudioLocalKey(config);
  let providerResult;
  try {
    const providerInput = {
      schema: "shepherd_office_audio_provider_input.v1",
      runId: `office-audio-${Date.now().toString(36)}`,
      userId: optionalString(config.userId) ?? null,
      roomProfileId: config.roomProfileId ?? null,
      sourceSessionId: config.sourceSessionId ?? sourceSessionIdForManifests(config, manifests),
      roomOwnerUserId: optionalString(config.roomOwnerUserId) ?? optionalString(config.space?.roomOwnerUserId) ?? null,
      roomCode: optionalString(config.roomCode) ?? optionalString(config.space?.roomCode) ?? null,
      devices: officeAudioDevicesFromManifests(config, manifests),
      speakerProfiles: await officeAudioSpeakerProfiles(config),
      chunks: [],
      arrayProducts: [],
      expectedOutput: "Return JSON { sessions: OfficeAudioSession[] } or a single OfficeAudioSession. Speaker names require model evidence or human correction.",
      policy: {
        devicesAreSensorsNotPeople: true,
        doNotNameUnconsentedSpeakers: true,
        rawAudioIsTemporary: true,
        useDistributedMicrophoneArray: true,
        preferArrayProductsOverSingleDeviceChunks: true,
      },
    };

    for (const manifest of manifests) {
      const decryptedPath = join(tempDir, `${safeFileId(manifest.chunkId ?? basename(manifest.path))}.wav`);
      const encrypted = await readFile(requiredConfigString(manifest.encryptedPath, "manifest.encryptedPath"));
      await writeFile(decryptedPath, decryptOfficeAudioChunk(encrypted, localAudioKey), { mode: 0o600 });
      providerInput.chunks.push({
        chunkId: manifest.chunkId,
        deviceId: manifest.deviceId,
        inputDeviceUid: manifest.inputDeviceUid ?? null,
        startedAt: manifest.startedAt,
        endedAt: manifest.endedAt,
        durationMs: manifest.durationMs ?? null,
        format: manifest.format ?? "wav",
        decryptedAudioPath: decryptedPath,
        encryptedPath: manifest.encryptedPath,
        manifestPath: manifest.path,
      });
    }

    providerInput.alignments = await officeAudioAlignmentsFromChunks(providerInput.chunks, manifests);
    providerInput.arrayProducts = await officeAudioArrayProductsFromChunks(providerInput.chunks, providerInput.alignments, tempDir, config);
    providerInput.enhancementPlan = officeAudioArrayEnhancementPlan(providerInput.chunks, providerInput.alignments, providerInput.arrayProducts);
    if (arrayFinalizerCommand && arrayFinalizerCommand.length > 0) {
      providerInput.arrayProducts = await applyOfficeAudioArrayFinalizer(arrayFinalizerCommand, providerInput, tempDir);
    }
    providerResult = transcriptionBackend === "external_provider_command"
      ? await runOfficeAudioProviderCommand(providerCommand, providerInput)
      : await runOfficeAudioBuiltInTranscriptionBackend(providerInput, { backend: transcriptionBackend });
    if (isOfficeAudioIdentityAuditOnlyResult(providerResult)) {
      const auditDir = join(spoolDir, "identity-audits");
      await mkdir(auditDir, { recursive: true });
      const auditPath = join(auditDir, `${safeFileId(providerInput.sourceSessionId)}-${Date.now()}.json`);
      await writeFile(auditPath, `${JSON.stringify({
        provider: providerResult.provider ?? "identity_audit_provider",
        model: providerResult.model ?? null,
        sourceSessionId: providerInput.sourceSessionId,
        roomProfileId: providerInput.roomProfileId,
        identityAudit: providerResult.identityAudit,
        chunkIds: manifests.map((manifest) => manifest.chunkId).filter(Boolean),
        generatedBy: "office-audio-process-chunks",
        generatedAt: new Date().toISOString(),
        policy: {
          transcriptStillRequired: true,
          notQueuedForCanonicalTranscriptIngest: true,
        },
      }, null, 2)}\n`, { mode: 0o600 });
      for (const manifest of manifests) {
        await markOfficeAudioChunkIdentityAudited(manifest.path, auditPath);
      }
      return {
        ok: true,
        processed: 0,
        audited: manifests.length,
        identityAuditPath: auditPath,
        sourceSessionId: providerInput.sourceSessionId,
        provider: providerResult.provider ?? null,
        transcriptionBackend,
        reason: "provider returned identity audit only; canonical transcript still requires an ASR provider",
      };
    }
    const sessions = normalizeOfficeAudioProviderSessions(providerResult, providerInput, manifests, config);
    const outputPath = join(spoolDir, `${safeFileId(providerInput.sourceSessionId)}-${Date.now()}.json`);
    await writeFile(outputPath, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600 });
    for (const manifest of manifests) {
      await markOfficeAudioChunkProcessed(manifest.path, outputPath);
    }
    return {
      ok: true,
      processed: manifests.length,
      outputPath,
      sourceSessionId: providerInput.sourceSessionId,
      sessions: sessions.length,
      provider: sessions[0]?.metadata?.provider ?? null,
      transcriptionBackend,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function officeAudioConfiguredTranscriptionBackend(config, { providerCommand = null, providerCommandFromArgs = false } = {}) {
  const explicit = stringArg("transcription-backend")
    ?? optionalString(process.env.SHEPHERD_OFFICE_AUDIO_TRANSCRIPTION_BACKEND)
    ?? optionalString(process.env.OFFICE_AUDIO_TRANSCRIPTION_BACKEND)
    ?? optionalString(config?.transcriptionBackend)
    ?? optionalString(config?.transcriptionPipeline?.backend);
  if (explicit) return normalizeOfficeAudioTranscriptionBackend(explicit);
  const configProviderCommand = Array.isArray(config?.processorCommand)
    ? config.processorCommand
    : null;
  if (
    providerCommandFromArgs
    || (Array.isArray(providerCommand) && providerCommand.length > 0)
    || (Array.isArray(configProviderCommand) && configProviderCommand.length > 0)
  ) {
    return "external_provider_command";
  }
  return DEFAULT_OFFICE_AUDIO_TRANSCRIPTION_BACKEND;
}

function normalizeOfficeAudioTranscriptionBackend(value) {
  const raw = optionalString(value);
  if (!raw) return DEFAULT_OFFICE_AUDIO_TRANSCRIPTION_BACKEND;
  const normalized = raw.toLowerCase().replace(/[+\s-]+/g, "_");
  const aliases = {
    pyannote: "pyannote_full",
    pyannoteai: "pyannote_full",
    pyannoteai_full: "pyannote_full",
    full_pyannote: "pyannote_full",
    pyannote_only: "pyannote_full",
    elevenlabs: "elevenlabs_pyannote",
    elevenlabs_plus_pyannote: "elevenlabs_pyannote",
    elevenlabs_pyannote_mixed: "elevenlabs_pyannote",
    mixed: "elevenlabs_pyannote",
    external: "external_provider_command",
    provider_command: "external_provider_command",
  };
  const backend = aliases[normalized] ?? normalized;
  if (!OFFICE_AUDIO_TRANSCRIPTION_BACKENDS.has(backend)) {
    throw new Error(`Unsupported Office Audio transcription backend: ${raw}`);
  }
  return backend;
}

function officeAudioBackendUsesPyannoteVoiceprints(backend) {
  return backend === "pyannote_full" || backend === "elevenlabs_pyannote";
}

async function runOfficeAudioEnrollVoice() {
  const configPath = stringArg("config");
  if (!configPath) throw new Error("office-audio-enroll-voice requires --config <path>");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const channel = cliChannel(config.channel);
  const rawDir = join(homedir(), ".shepherd", "office-audio");
  const speakerId = safeFileId(stringArg("speaker-id") ?? config.userId ?? "local-speaker");
  const displayName = stringArg("display-name") ?? config.speakerDisplayName ?? speakerId;
  const scriptId = stringArg("script-id") ?? "founder-room-v1";
  const seconds = Math.max(5, Math.min(60, Math.floor(Number(args.seconds ?? 20) || 20)));
  const enrollmentDir = config.enrollmentDir ?? join(rawDir, `${channelFilePrefix(channel)}speaker-profiles`, speakerId);
  const audioPath = stringArg("audio-path");
  await mkdir(enrollmentDir, { recursive: true });

  const tempDir = await mkdtemp(join(tmpdir(), "shepherd-office-audio-enroll-"));
  const wavPath = audioPath ?? join(tempDir, `${speakerId}.wav`);
  const createdAt = new Date().toISOString();
  const localAudioKey = officeAudioLocalKey(config);
  let providerOutput = null;
  try {
    if (!audioPath) {
      if (platform() !== "darwin") throw new Error("Office Audio voice enrollment recording requires macOS afrecord unless --audio-path is provided.");
      const child = spawn("/usr/bin/afrecord", ["-f", "WAVE", "-d", String(seconds), wavPath], {
        cwd: rawDir,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const exit = await waitForChild(child);
      if (exit.code !== 0) {
        throw new Error(`afrecord exited with ${exit.code ?? exit.signal ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      }
    }

    const audio = await readFile(wavPath);
    const encrypted = encryptOfficeAudioChunk(audio, localAudioKey);
    const clipId = `${createdAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
    const encryptedPath = join(enrollmentDir, `${clipId}.wav.enc`);
    await writeFile(encryptedPath, encrypted.payload, { mode: 0o600 });

    const providerCommand = parseJsonArrayArg("provider-command")
      ?? (Array.isArray(config.enrollmentProviderCommand) ? config.enrollmentProviderCommand.map((value) => String(value)) : null)
      ?? (Array.isArray(config.processorCommand) ? config.processorCommand.map((value) => String(value)) : null);
    const providerInput = {
      schema: "shepherd_office_audio_enrollment_input.v1",
      runId: `office-audio-enroll-${Date.now().toString(36)}`,
      userId: optionalString(config.userId) ?? null,
      roomProfileId: config.roomProfileId ?? null,
      speakerId,
      displayName,
      scriptId,
      consent: {
        state: "consented",
        source: "mac_app_voice_enrollment",
        consentedAt: createdAt,
      },
      enrollmentClip: {
        clipId,
        durationMs: seconds * 1000,
        format: "wav",
        decryptedAudioPath: wavPath,
        encryptedPath,
      },
      expectedOutput: "Return JSON { speakerIdentifiers: [{ provider, model, identifier, label? }], provider?, model?, confidence? }. Do not return transcript text.",
      policy: {
        rawAudioIsTemporary: true,
        speakerIdentifiersAreCustomerConfidential: true,
        consentRequired: true,
      },
    };
    if (providerCommand && providerCommand.length > 0) {
      providerOutput = await runOfficeAudioProviderCommand(providerCommand, providerInput);
    } else if (officeAudioBackendUsesPyannoteVoiceprints(officeAudioConfiguredTranscriptionBackend(config))) {
      providerOutput = await officeAudioPyannoteAiEnrollVoice(providerInput);
    }

    const profile = normalizeOfficeAudioSpeakerProfile({
      schema: "office_audio_speaker_profile.v1",
      speakerId,
      displayName,
      status: providerOutput?.speakerIdentifiers?.length ? "enrolled" : "local_clip_only",
      consent: {
        state: "consented",
        source: "mac_app_voice_enrollment",
        consentedAt: createdAt,
      },
      enrollmentClips: [{
        clipId,
        encryptedPath,
        encryption: {
          algorithm: encrypted.algorithm,
          payloadLayout: encrypted.payloadLayout,
          ivBytes: encrypted.ivBytes,
          authTagBytes: encrypted.authTagBytes,
          keyId: config.localAudioKeyId ?? "local-config-key",
        },
        durationMs: seconds * 1000,
        scriptId,
        createdAt,
      }],
      speakerIdentifiers: Array.isArray(providerOutput?.speakerIdentifiers) ? providerOutput.speakerIdentifiers : [],
      provider: providerOutput?.provider ?? providerOutput?.model ?? null,
      confidence: providerOutput?.confidence ?? null,
      evidence: [{
        type: providerOutput?.speakerIdentifiers?.length ? "provider_known_speaker" : "voice_enrollment_clip",
        provider: providerOutput?.provider ?? null,
        model: providerOutput?.model ?? null,
        createdAt,
      }],
      updatedAt: createdAt,
    });
    const profilePath = join(enrollmentDir, "profile.json");
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    await pushOfficeAudioSpeakerProfile(config, profile).catch((err) => {
      profile.syncError = safeError(err);
    });
    console.log(JSON.stringify({
      ok: true,
      speakerId,
      displayName,
      profilePath,
      status: profile.status,
      speakerIdentifiers: profile.speakerIdentifiers.length,
      synced: !profile.syncError,
      syncError: profile.syncError ?? null,
    }, null, 2));
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runOfficeAudioSpeechmaticsProvider() {
  const input = await readJsonInput();
  const apiKey = optionalString(process.env.SPEECHMATICS_API_KEY ?? process.env.SHEPHERD_SPEECHMATICS_API_KEY);
  if (!apiKey) throw new Error("office-audio-provider-speechmatics requires SPEECHMATICS_API_KEY.");
  if (input?.schema === "shepherd_office_audio_enrollment_input.v1") {
    const speakers = await speechmaticsTranscribeFile({
      apiKey,
      audioPath: requiredConfigString(input.enrollmentClip?.decryptedAudioPath, "enrollmentClip.decryptedAudioPath"),
      enroll: true,
      speakerProfiles: [],
    });
    const identifiers = [];
    for (const speaker of speakers.speakers) {
      for (const identifier of speaker.speaker_identifiers ?? speaker.speakerIdentifiers ?? []) {
        identifiers.push({
          provider: "speechmatics",
          model: "enhanced",
          identifier: String(identifier),
          label: input.speakerId ?? speaker.label ?? "speaker",
          createdAt: new Date().toISOString(),
        });
      }
    }
    console.log(JSON.stringify({
      provider: "speechmatics",
      model: "enhanced",
      speakerIdentifiers: identifiers,
      confidence: identifiers.length > 0 ? 0.82 : 0,
    }));
    return;
  }
  if (input?.schema !== "shepherd_office_audio_provider_input.v1") {
    throw new Error("office-audio-provider-speechmatics received an unsupported input schema.");
  }

  const speakerProfiles = Array.isArray(input.speakerProfiles) ? input.speakerProfiles : [];
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  const audioSources = officeAudioAsrSources(input);
  const startedAtMs = Date.parse(String(audioSources[0]?.startedAt ?? chunks[0]?.startedAt ?? "")) || Date.now();
  const turns = [];
  let turnIndex = 0;
  for (const source of audioSources) {
    const transcript = await speechmaticsTranscribeFile({
      apiKey,
      audioPath: requiredConfigString(source.decryptedAudioPath, "audioSource.decryptedAudioPath"),
      enroll: false,
      speakerProfiles,
    });
    const sourceStartMs = Date.parse(String(source.startedAt ?? ""));
    const offsetMs = Number.isFinite(sourceStartMs) ? sourceStartMs - startedAtMs : 0;
    for (const segment of transcript.segments) {
      const speaker = speechmaticsKnownSpeaker(segment.speakerLabel, speakerProfiles);
      const sourceDeviceIds = Array.isArray(source.sourceProviderDeviceIds)
        ? source.sourceProviderDeviceIds.filter(Boolean)
        : [source.deviceId].filter(Boolean);
      turns.push({
        turnIndex,
        startMs: offsetMs + segment.startMs,
        endMs: offsetMs + segment.endMs,
        text: segment.text,
        speakerLabel: segment.speakerLabel ?? "unknown",
        speakerIdentityStatus: speaker ? "inferred" : "unknown",
        speakerPersonId: speaker?.speakerId ?? null,
        speakerDisplayName: speaker?.displayName ?? null,
        speakerConfidence: speaker ? 820 : 0,
        speakerEvidence: speaker ? [{
          type: "provider_known_speaker",
          provider: "speechmatics",
          model: "enhanced",
          label: segment.speakerLabel,
          matchedSpeakerId: speaker.speakerId,
        }] : [],
        primaryProviderDeviceId: source.primaryProviderDeviceId ?? source.deviceId ?? null,
        sourceProviderDeviceIds: sourceDeviceIds,
        alignmentConfidence: typeof source.alignmentConfidence === "number" ? source.alignmentConfidence : 0.8,
        diarizationConfidence: segment.speakerLabel ? 0.75 : null,
        asrConfidence: segment.confidence,
        consentState: speaker?.consent?.state === "consented" ? "consented" : "pending_review",
      });
      turnIndex += 1;
    }
  }
  console.log(JSON.stringify({
    provider: "speechmatics",
    model: "enhanced",
    sessions: [{
      sourceSessionId: input.sourceSessionId,
      title: "Office audio transcript",
      room: input.roomProfileId ?? null,
      startedAt: chunks[0]?.startedAt ?? new Date().toISOString(),
      endedAt: chunks[chunks.length - 1]?.endedAt ?? null,
      devices: input.devices ?? [],
      alignments: input.alignments ?? [],
      consents: speakerProfiles.map((profile) => ({
        participantKey: profile.speakerId,
        participantUserId: profile.speakerId,
        participantDisplayName: profile.displayName,
        state: profile.consent?.state ?? "pending",
        source: profile.consent?.source ?? "voice_enrollment",
        evidence: { profileStatus: profile.status, provider: profile.provider ?? "speechmatics" },
        consentedAt: profile.consent?.consentedAt ?? null,
      })),
      turns,
      metadata: {
        provider: "speechmatics",
        model: "enhanced",
        identityPolicy: "provider_known_speaker_only",
        arrayProcessing: Array.isArray(input.arrayProducts) && input.arrayProducts.length > 0
          ? {
              mode: "distributed_microphone_array",
              products: input.arrayProducts.map((product) => ({
                productId: product.productId,
                algorithm: product.algorithm,
                sourceProviderDeviceIds: product.sourceProviderDeviceIds,
                confidence: product.alignmentConfidence,
              })),
            }
          : { mode: "single_device_chunks" },
      },
    }],
  }));
}

async function speechmaticsTranscribeFile({ apiKey, audioPath, enroll, speakerProfiles }) {
  const audio = await readFile(audioPath);
  const speakers = speechmaticsSpeakersConfig(speakerProfiles);
  const transcriptionConfig = {
    language: "en",
    model: "enhanced",
    diarization: "speaker",
    max_delay: 2,
    enable_partials: false,
    speaker_diarization_config: enroll
      ? { get_speakers: true }
      : speakers.length > 0
        ? { speakers, speaker_sensitivity: 0.35 }
        : { max_speakers: 10 },
  };
  const messages = await speechmaticsRealtimeSession({
    apiKey,
    audio,
    startMessage: {
      message: "StartRecognition",
      audio_format: { type: "file" },
      transcription_config: transcriptionConfig,
    },
    getSpeakers: enroll,
  });
  const segments = [];
  const speakerResults = [];
  for (const message of messages) {
    if (message.message === "SpeakersResult" && Array.isArray(message.speakers)) {
      speakerResults.push(...message.speakers);
    }
    if (message.message !== "AddTranscript") continue;
    const text = optionalString(message.transcript);
    if (!text) continue;
    const words = Array.isArray(message.results) ? message.results.filter((result) => result?.type === "word") : [];
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    const alt = firstWord?.alternatives?.[0] ?? {};
    const confidences = words
      .map((word) => word?.alternatives?.[0]?.confidence)
      .filter((value) => typeof value === "number");
    segments.push({
      text,
      startMs: Math.round(Number(firstWord?.start_time ?? message.metadata?.start_time ?? 0) * 1000),
      endMs: Math.round(Number(lastWord?.end_time ?? message.metadata?.end_time ?? 0) * 1000),
      speakerLabel: optionalString(alt.speaker),
      confidence: confidences.length > 0
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : null,
    });
  }
  return { segments, speakers: speakerResults };
}

function speechmaticsSpeakersConfig(speakerProfiles) {
  const speakers = [];
  for (const profile of speakerProfiles) {
    const identifiers = Array.isArray(profile.speakerIdentifiers)
      ? profile.speakerIdentifiers
        .filter((identifier) => identifier?.provider === "speechmatics" && optionalString(identifier.identifier))
        .map((identifier) => identifier.identifier)
      : [];
    if (identifiers.length === 0) continue;
    speakers.push({
      label: speechmaticsSpeakerLabel(profile),
      speaker_identifiers: identifiers,
    });
  }
  return speakers.slice(0, 50);
}

function speechmaticsSpeakerLabel(profile) {
  const speakerId = optionalString(profile.speakerId) ?? "speaker";
  const baseLabel = optionalString(profile.displayName) ?? speakerId;
  const cleaned = baseLabel
    .replace(/^\s+|\s+$/g, "")
    .replace(/^(S\d+|UU)$/i, "Speaker")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "Speaker";
  const suffix = createHash("sha256").update(speakerId).digest("hex").slice(0, 10);
  return `${cleaned}_${suffix}`;
}

function speechmaticsKnownSpeaker(label, speakerProfiles) {
  if (!label) return null;
  const exact = speakerProfiles.find((profile) => speechmaticsSpeakerLabel(profile) === label);
  if (exact) return exact;
  const displayMatches = speakerProfiles.filter((profile) => speechmaticsLegacySpeakerLabel(profile) === label);
  return displayMatches.length === 1 ? displayMatches[0] : null;
}

function speechmaticsLegacySpeakerLabel(profile) {
  const label = optionalString(profile.displayName) ?? optionalString(profile.speakerId) ?? "Speaker";
  const cleaned = label.replace(/^\s+|\s+$/g, "").replace(/^(S\d+|UU)$/i, "Speaker");
  return cleaned || "Speaker";
}

function speechmaticsRealtimeSession({ apiKey, audio, startMessage, getSpeakers }) {
  return new Promise((resolve, reject) => {
    const url = optionalString(process.env.SHEPHERD_SPEECHMATICS_REALTIME_URL) ?? "wss://eu.rt.speechmatics.com/v2";
    const ws = new WebSocketClient(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const messages = [];
    let seqNo = 0;
    let settled = false;
    let sawSpeakersResult = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(error);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(messages);
    };
    const timer = setTimeout(() => fail(new Error("Speechmatics realtime session timed out.")), 120_000);
    ws.on("open", () => {
      ws.send(JSON.stringify(startMessage));
    });
    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      messages.push(message);
      if (message.message === "Error") {
        clearTimeout(timer);
        fail(new Error(`Speechmatics realtime error: ${message.type ?? "unknown"}`));
        return;
      }
      if (message.message === "RecognitionStarted") {
        const chunkSize = 64 * 1024;
        for (let offset = 0; offset < audio.length; offset += chunkSize) {
          ws.send(audio.subarray(offset, Math.min(audio.length, offset + chunkSize)));
          seqNo += 1;
        }
        if (getSpeakers) ws.send(JSON.stringify({ message: "GetSpeakers", final: true }));
        ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: seqNo }));
      }
      if (message.message === "EndOfTranscript") {
        if (!getSpeakers) {
          clearTimeout(timer);
          done();
        }
      }
      if (getSpeakers && message.message === "SpeakersResult") {
        sawSpeakersResult = true;
        clearTimeout(timer);
        done();
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      fail(new Error("Speechmatics realtime websocket failed."));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (!settled && getSpeakers && !sawSpeakersResult) {
        fail(new Error("Speechmatics enrollment completed without speaker identifiers."));
      } else if (!settled) {
        done();
      }
    });
  });
}

async function runOfficeAudioElevenLabsProvider() {
  const input = await readJsonInput();
  const apiKey = optionalString(process.env.ELEVENLABS_API_KEY ?? process.env.SHEPHERD_ELEVENLABS_API_KEY);
  if (!apiKey) throw new Error("office-audio-provider-elevenlabs requires ELEVENLABS_API_KEY.");
  if (input?.schema !== "shepherd_office_audio_provider_input.v1") {
    throw new Error("office-audio-provider-elevenlabs received an unsupported input schema.");
  }

  const model = optionalString(process.env.SHEPHERD_ELEVENLABS_MODEL) ?? "scribe_v2";
  const url = optionalString(process.env.SHEPHERD_ELEVENLABS_STT_URL) ?? "https://api.elevenlabs.io/v1/speech-to-text";
  const sourceSegments = [];
  for (const source of officeAudioAsrSources(input)) {
    const body = await officeAudioElevenLabsTranscribeSource({ apiKey, source, model, url });
    sourceSegments.push({ source, segments: elevenLabsSegments(body) });
  }

  console.log(JSON.stringify(officeAudioProviderResultFromSegments({
    input,
    provider: "elevenlabs",
    model,
    sourceSegments,
    identityPolicy: "elevenlabs_speaker_library_identifier_only",
    metadata: { adapter: "office-audio-provider-elevenlabs" },
  })));
}

async function officeAudioElevenLabsTranscribeSource({ apiKey, source, model, url }) {
  const audioPath = requiredConfigString(source.decryptedAudioPath, "audioSource.decryptedAudioPath");
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), basename(audioPath));
  form.append("model_id", model);
  form.append("diarize", "true");
  form.append("timestamps_granularity", "word");
  form.append("use_multi_channel", source.channelCount && source.channelCount > 1 ? "true" : "false");
  form.append("multichannel_output_style", "combined");
  const response = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  return readJsonResponse(response, "ElevenLabs speech-to-text");
}

async function runOfficeAudioDeepgramProvider() {
  const input = await readJsonInput();
  const apiKey = optionalString(process.env.DEEPGRAM_API_KEY ?? process.env.SHEPHERD_DEEPGRAM_API_KEY);
  if (!apiKey) throw new Error("office-audio-provider-deepgram requires DEEPGRAM_API_KEY.");
  if (input?.schema !== "shepherd_office_audio_provider_input.v1") {
    throw new Error("office-audio-provider-deepgram received an unsupported input schema.");
  }

  const model = optionalString(process.env.SHEPHERD_DEEPGRAM_MODEL) ?? "nova-3";
  const defaultUrl = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&diarize=true&diarize_model=latest&punctuate=true&smart_format=true`;
  const url = optionalString(process.env.SHEPHERD_DEEPGRAM_LISTEN_URL) ?? defaultUrl;
  const sourceSegments = [];
  for (const source of officeAudioAsrSources(input)) {
    const audioPath = requiredConfigString(source.decryptedAudioPath, "audioSource.decryptedAudioPath");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "content-type": "audio/wav",
      },
      body: await readFile(audioPath),
    });
    const body = await readJsonResponse(response, "Deepgram listen");
    sourceSegments.push({ source, segments: deepgramSegments(body) });
  }

  console.log(JSON.stringify(officeAudioProviderResultFromSegments({
    input,
    provider: "deepgram",
    model,
    sourceSegments,
    identityPolicy: "generic_diarization_labels_only",
    metadata: { adapter: "office-audio-provider-deepgram" },
  })));
}

async function runOfficeAudioSonioxProvider() {
  const input = await readJsonInput();
  const apiKey = optionalString(process.env.SONIOX_API_KEY ?? process.env.SHEPHERD_SONIOX_API_KEY);
  if (!apiKey) throw new Error("office-audio-provider-soniox requires SONIOX_API_KEY.");
  if (input?.schema !== "shepherd_office_audio_provider_input.v1") {
    throw new Error("office-audio-provider-soniox received an unsupported input schema.");
  }

  const model = optionalString(process.env.SHEPHERD_SONIOX_MODEL) ?? "stt-rt-v5";
  const sourceSegments = [];
  for (const source of officeAudioAsrSources(input)) {
    const audioPath = requiredConfigString(source.decryptedAudioPath, "audioSource.decryptedAudioPath");
    const overrideUrl = optionalString(process.env.SHEPHERD_SONIOX_TRANSCRIBE_URL);
    const body = overrideUrl
      ? await sonioxHttpTranscribe({ apiKey, audioPath, model, url: overrideUrl })
      : await sonioxRealtimeTranscribe({ apiKey, audioPath, model });
    sourceSegments.push({ source, segments: sonioxSegments(body) });
  }

  console.log(JSON.stringify(officeAudioProviderResultFromSegments({
    input,
    provider: "soniox",
    model,
    sourceSegments,
    identityPolicy: "generic_diarization_labels_only",
    metadata: { adapter: "office-audio-provider-soniox" },
  })));
}

async function runOfficeAudioPyannoteAiProvider() {
  const input = await readJsonInput();
  const apiKey = optionalString(process.env.PYANNOTEAI_API_KEY ?? process.env.SHEPHERD_PYANNOTEAI_API_KEY);
  if (!apiKey) throw new Error("office-audio-provider-pyannoteai requires PYANNOTEAI_API_KEY.");
  if (input?.schema === "shepherd_office_audio_enrollment_input.v1") {
    console.log(JSON.stringify(await officeAudioPyannoteAiEnrollVoice(input, { apiKey })));
    return;
  }
  if (input?.schema !== "shepherd_office_audio_provider_input.v1") {
    throw new Error("office-audio-provider-pyannoteai received an unsupported input schema.");
  }

  const model = optionalString(process.env.SHEPHERD_PYANNOTEAI_MODEL) ?? "precision-2";
  const url = optionalString(process.env.SHEPHERD_PYANNOTEAI_IDENTIFY_URL) ?? "https://api.pyannote.ai/v1/identify";
  const voiceprints = officeAudioPyannoteVoiceprints(Array.isArray(input.speakerProfiles) ? input.speakerProfiles : []);
  const sourceSegments = [];
  const identityAuditSegments = [];
  for (const source of officeAudioAsrSources(input)) {
    const publicAudioUrl = optionalString(source.publicAudioUrl ?? source.audioUrl ?? process.env.SHEPHERD_PYANNOTEAI_PUBLIC_AUDIO_URL);
    if (!publicAudioUrl) {
      throw new Error("office-audio-provider-pyannoteai requires a signed audio URL. Refusing implicit raw local audio upload.");
    }
    const body = await pyannoteAiIdentify({
      apiKey,
      url,
      model,
      audioUrl: publicAudioUrl,
      voiceprints,
    });
    const segments = officeAudioPyannoteIdentitySegments(body, { voiceprints });
    if (!segments.some((segment) => optionalString(segment.text))) {
      identityAuditSegments.push(...segments.map((segment) => officeAudioIdentityAuditSegment(segment, source)));
      continue;
    }
    sourceSegments.push({ source, segments });
  }

  if (sourceSegments.length === 0) {
    console.log(JSON.stringify(officeAudioIdentityAuditOnlyResult({
      input,
      provider: "pyannoteai",
      model,
      segments: identityAuditSegments,
    })));
    return;
  }

  console.log(JSON.stringify(officeAudioProviderResultFromSegments({
    input,
    provider: "pyannoteai",
    model,
    sourceSegments,
    identityPolicy: "voiceprint_identifier_only",
    metadata: {
      adapter: "office-audio-provider-pyannoteai",
      identityAudit: identityAuditSegments.length > 0
        ? officeAudioIdentityAuditPayload(input, identityAuditSegments)
        : null,
    },
  })));
}

function isOfficeAudioIdentityAuditOnlyResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (!result.identityAudit || typeof result.identityAudit !== "object" || Array.isArray(result.identityAudit)) return false;
  return !Array.isArray(result.sessions) || result.sessions.length === 0;
}

function officeAudioIdentityAuditOnlyResult({ input, provider, model, segments }) {
  return {
    provider,
    model,
    identityAudit: officeAudioIdentityAuditPayload(input, segments),
  };
}

function officeAudioIdentityAuditPayload(input, segments) {
  return {
    schema: "shepherd_office_audio_identity_audit.v1",
    sourceSessionId: input.sourceSessionId,
    roomProfileId: input.roomProfileId ?? null,
    segments,
    policy: {
      outputContainsTranscriptText: false,
      canonicalTranscriptProviderRequired: true,
      identityEvidenceOnly: true,
    },
  };
}

function officeAudioIdentityAuditSegment(segment, source) {
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    speakerLabel: segment.speakerLabel ?? "unknown",
    speakerIdentifier: segment.speakerIdentifier ?? null,
    confidence: segment.confidence ?? null,
    sourceProviderDeviceIds: officeAudioSourceDeviceIds(source),
  };
}

function officeAudioAsrSources(input) {
  const products = Array.isArray(input?.arrayProducts)
    ? input.arrayProducts.filter((product) => (
        product
        && typeof product === "object"
        && product.role === "asr_primary"
        && optionalString(product.decryptedAudioPath)
        && isOfficeAudioArrayProductExecuted(product)
        && (!isHeavyOfficeAudioArrayProduct(product) || isOfficeAudioArrayProductBenchmarkPassed(product))
      ))
    : [];
  if (products.length > 0) {
    const benchmarkedHeavyProducts = products.filter((product) => (
      isHeavyOfficeAudioArrayProduct(product) && isOfficeAudioArrayProductBenchmarkPassed(product)
    ));
    return (benchmarkedHeavyProducts.length > 0 ? benchmarkedHeavyProducts : products)
      .sort((left, right) => Number(right.alignmentConfidence ?? 0) - Number(left.alignmentConfidence ?? 0))
      .slice(0, 1);
  }
  return Array.isArray(input?.chunks) ? input.chunks : [];
}

async function runOfficeAudioBuiltInTranscriptionBackend(input, { backend }) {
  const normalizedBackend = normalizeOfficeAudioTranscriptionBackend(backend);
  if (normalizedBackend === "external_provider_command") {
    throw new Error("external_provider_command is not a built-in Office Audio transcription backend.");
  }
  const pyannoteApiKey = optionalString(process.env.PYANNOTEAI_API_KEY ?? process.env.SHEPHERD_PYANNOTEAI_API_KEY);
  if (!pyannoteApiKey) throw new Error(`${normalizedBackend} requires PYANNOTEAI_API_KEY.`);
  const voiceprints = officeAudioPyannoteVoiceprints(Array.isArray(input.speakerProfiles) ? input.speakerProfiles : []);
  const pyannoteModel = optionalString(process.env.SHEPHERD_PYANNOTEAI_MODEL) ?? "precision-2";
  const sourceSegments = [];

  if (normalizedBackend === "elevenlabs_pyannote") {
    const elevenLabsApiKey = optionalString(process.env.ELEVENLABS_API_KEY ?? process.env.SHEPHERD_ELEVENLABS_API_KEY);
    if (!elevenLabsApiKey) throw new Error("elevenlabs_pyannote requires ELEVENLABS_API_KEY.");
    const elevenLabsModel = optionalString(process.env.SHEPHERD_ELEVENLABS_MODEL) ?? "scribe_v2";
    const elevenLabsUrl = optionalString(process.env.SHEPHERD_ELEVENLABS_STT_URL) ?? "https://api.elevenlabs.io/v1/speech-to-text";
    for (const source of officeAudioAsrSources(input)) {
      const audioUrl = voiceprints.length > 0
        ? await officeAudioPyannoteAudioUrl({ apiKey: pyannoteApiKey, source, input })
        : null;
      const [elevenLabsBody, identityBody] = await Promise.all([
        officeAudioElevenLabsTranscribeSource({ apiKey: elevenLabsApiKey, source, model: elevenLabsModel, url: elevenLabsUrl }),
        voiceprints.length > 0
          ? pyannoteAiIdentify({
              apiKey: pyannoteApiKey,
              url: optionalString(process.env.SHEPHERD_PYANNOTEAI_IDENTIFY_URL) ?? "https://api.pyannote.ai/v1/identify",
              model: pyannoteModel,
              audioUrl,
              voiceprints,
            })
          : Promise.resolve(null),
      ]);
      const transcriptSegments = elevenLabsSegments(elevenLabsBody);
      const identitySegments = identityBody
        ? officeAudioPyannoteIdentitySegments(identityBody, { voiceprints })
        : [];
      sourceSegments.push({
        source,
        segments: officeAudioAttachIdentityToTranscriptSegments(transcriptSegments, identitySegments, { voiceprints }),
      });
    }
    const providerResult = officeAudioProviderResultFromSegments({
      input,
      provider: "elevenlabs_pyannote",
      model: `${elevenLabsModel}+${pyannoteModel}`,
      sourceSegments,
      identityPolicy: voiceprints.length > 0 ? "pyannote_voiceprint_identifier_only" : "generic_diarization_labels_only",
      metadata: {
        transcriptionBackend: normalizedBackend,
        providerStack: [
          "elevenlabs:speech-to-text",
          ...(voiceprints.length > 0 ? ["pyannoteai:identify"] : []),
          "fireworks:gpt-oss-merge",
        ],
        sttProvider: "elevenlabs",
        identityProvider: voiceprints.length > 0 ? "pyannoteai" : null,
      },
    });
    return officeAudioFinalizeProviderResultWithGptOss(providerResult, input, { backend: normalizedBackend });
  }

  for (const source of officeAudioAsrSources(input)) {
    const audioUrl = await officeAudioPyannoteAudioUrl({ apiKey: pyannoteApiKey, source, input });
    const [transcriptionBody, identityBody] = await Promise.all([
      pyannoteAiDiarizeTranscribe({
        apiKey: pyannoteApiKey,
        url: optionalString(process.env.SHEPHERD_PYANNOTEAI_DIARIZE_URL) ?? "https://api.pyannote.ai/v1/diarize",
        model: pyannoteModel,
        audioUrl,
      }),
      voiceprints.length > 0
        ? pyannoteAiIdentify({
            apiKey: pyannoteApiKey,
            url: optionalString(process.env.SHEPHERD_PYANNOTEAI_IDENTIFY_URL) ?? "https://api.pyannote.ai/v1/identify",
            model: pyannoteModel,
            audioUrl,
            voiceprints,
          })
        : Promise.resolve(null),
    ]);
    const transcriptSegments = officeAudioPyannoteTranscriptSegments(transcriptionBody);
    const identitySegments = identityBody
      ? officeAudioPyannoteIdentitySegments(identityBody, { voiceprints })
      : officeAudioPyannoteDiarizationSegments(transcriptionBody);
    sourceSegments.push({
      source,
      segments: officeAudioAttachIdentityToTranscriptSegments(transcriptSegments, identitySegments, { voiceprints }),
    });
  }
  const providerResult = officeAudioProviderResultFromSegments({
    input,
    provider: "pyannoteai",
    model: pyannoteModel,
    sourceSegments,
    identityPolicy: voiceprints.length > 0 ? "pyannote_stt_orchestration_voiceprint_identifier_only" : "pyannote_stt_orchestration_diarization_only",
      metadata: {
        transcriptionBackend: normalizedBackend,
        providerStack: [
          "pyannoteai:diarize-transcription",
          ...(voiceprints.length > 0 ? ["pyannoteai:identify"] : []),
          "fireworks:gpt-oss-merge",
        ],
      sttProvider: "pyannoteai",
      identityProvider: voiceprints.length > 0 ? "pyannoteai" : null,
    },
  });
  return officeAudioFinalizeProviderResultWithGptOss(providerResult, input, { backend: normalizedBackend });
}

async function officeAudioPyannoteAudioUrl({ apiKey, source, input }) {
  if (optionalString(source.__pyannoteAudioUrl)) return source.__pyannoteAudioUrl;
  const publicAudioUrl = optionalString(source.publicAudioUrl ?? source.audioUrl);
  if (publicAudioUrl) return publicAudioUrl;
  const audioPath = requiredConfigString(source.decryptedAudioPath, "audioSource.decryptedAudioPath");
  const mediaId = [
    "media://shepherd-office-audio",
    safeFileId(input.runId ?? "run"),
    `${safeFileId(source.productId ?? source.chunkId ?? basename(audioPath))}.wav`,
  ].join("/");
  const createUrl = optionalString(process.env.SHEPHERD_PYANNOTEAI_MEDIA_INPUT_URL) ?? "https://api.pyannote.ai/v1/media/input";
  const response = await fetch(createUrl, {
    method: "POST",
    headers: pyannoteAiHeaders(apiKey),
    body: JSON.stringify({ url: mediaId }),
  });
  const body = await readJsonResponse(response, "pyannoteAI media input");
  const uploadUrl = optionalString(body.url ?? body.uploadUrl ?? body.upload_url ?? body.presignedUrl ?? body.presigned_url);
  const pyannoteUrl = optionalString(body.mediaUrl ?? body.media_url ?? body.inputUrl ?? body.input_url) ?? mediaId;
  if (!uploadUrl) throw new Error("pyannoteAI media input did not return an upload URL.");
  const upload = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "audio/wav" },
    body: await readFile(audioPath),
  });
  if (!upload.ok) throw new Error(`pyannoteAI media upload failed with ${upload.status}; body redacted`);
  source.__pyannoteAudioUrl = pyannoteUrl;
  return pyannoteUrl;
}

async function officeAudioPyannoteAiEnrollVoice(input, options = {}) {
  const apiKey = optionalString(options.apiKey ?? process.env.PYANNOTEAI_API_KEY ?? process.env.SHEPHERD_PYANNOTEAI_API_KEY);
  if (!apiKey) throw new Error("pyannoteAI voiceprint enrollment requires PYANNOTEAI_API_KEY.");
  const model = optionalString(process.env.SHEPHERD_PYANNOTEAI_VOICEPRINT_MODEL ?? process.env.SHEPHERD_PYANNOTEAI_MODEL) ?? "precision-2";
  const source = {
    chunkId: input.enrollmentClip?.clipId ?? input.speakerId ?? "voice-enrollment",
    decryptedAudioPath: requiredConfigString(input.enrollmentClip?.decryptedAudioPath, "enrollmentClip.decryptedAudioPath"),
  };
  const audioUrl = await officeAudioPyannoteAudioUrl({ apiKey, source, input });
  const body = await pyannoteAiCreateVoiceprint({
    apiKey,
    url: optionalString(process.env.SHEPHERD_PYANNOTEAI_VOICEPRINT_URL) ?? "https://api.pyannote.ai/v1/voiceprint",
    model,
    audioUrl,
  });
  const voiceprint = officeAudioPyannoteVoiceprintValue(body);
  return {
    provider: "pyannoteai",
    model,
    speakerIdentifiers: voiceprint ? [{
      provider: "pyannoteai",
      model,
      identifier: voiceprint,
      label: optionalString(input.speakerId) ?? "speaker",
      createdAt: new Date().toISOString(),
    }] : [],
    confidence: voiceprint ? 0.9 : 0,
  };
}

function officeAudioPyannoteVoiceprints(speakerProfiles) {
  const voiceprints = [];
  for (const profile of speakerProfiles) {
    const speakerId = optionalString(profile?.speakerId);
    if (!speakerId) continue;
    const identifiers = Array.isArray(profile.speakerIdentifiers) ? profile.speakerIdentifiers : [];
    for (const identifier of identifiers) {
      if (identifier?.provider !== "pyannoteai") continue;
      const voiceprint = optionalString(identifier.identifier ?? identifier.voiceprint);
      if (!voiceprint) continue;
      voiceprints.push({
        label: speakerId,
        voiceprint,
        speakerId,
        displayName: optionalString(profile.displayName) ?? speakerId,
      });
    }
  }
  return voiceprints;
}

function officeAudioPyannoteVoiceprintValue(body) {
  const output = body?.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output : {};
  const candidate = optionalString(body?.voiceprint)
    ?? optionalString(output.voiceprint)
    ?? optionalString(output?.voiceprint?.voiceprint)
    ?? optionalString(body?.voiceprints?.[0]?.voiceprint)
    ?? optionalString(output?.voiceprints?.[0]?.voiceprint);
  return candidate ?? null;
}

function officeAudioPyannoteTranscriptSegments(body) {
  const output = body?.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output : {};
  const turnLevel = firstArray(
    body?.turnLevelTranscription,
    body?.turn_level_transcription,
    output.turnLevelTranscription,
    output.turn_level_transcription,
    output.transcription,
    body?.transcription,
  );
  if (turnLevel.length > 0) {
    return turnLevel.map((turn) => officeAudioTimedTextSegment(turn)).filter((segment) => segment.text);
  }
  const wordLevel = firstArray(
    body?.wordLevelTranscription,
    body?.word_level_transcription,
    output.wordLevelTranscription,
    output.word_level_transcription,
    body?.words,
    output.words,
  );
  if (wordLevel.length > 0) {
    return segmentsFromTimedWords(wordLevel.map((word) => ({
      word: optionalString(word.text ?? word.word) ?? "",
      startMs: word.start_ms != null ? millisecondsToMs(word.start_ms) : secondsToMs(word.start ?? word.start_time),
      endMs: word.end_ms != null ? millisecondsToMs(word.end_ms) : secondsToMs(word.end ?? word.end_time),
      speakerLabel: optionalString(word.speaker ?? word.speakerLabel ?? word.speaker_label),
      confidence: typeof word.confidence === "number" ? word.confidence : null,
    })));
  }
  return pyannoteAiSegments(body).filter((segment) => optionalString(segment.text));
}

function officeAudioPyannoteDiarizationSegments(body) {
  const output = body?.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output : {};
  const diarization = firstArray(
    body?.exclusiveDiarization,
    body?.exclusive_diarization,
    output.exclusiveDiarization,
    output.exclusive_diarization,
    body?.diarization,
    output.diarization,
  );
  return diarization.map((segment) => officeAudioTimedIdentitySegment(segment, { voiceprints: [] }))
    .filter((segment) => segment.speakerLabel);
}

function officeAudioPyannoteIdentitySegments(body, { voiceprints }) {
  const output = body?.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output : {};
  const segments = firstArray(
    body?.identification,
    output.identification,
    body?.segments,
    output.segments,
    body?.diarization,
    output.diarization,
  );
  return segments.map((segment) => officeAudioTimedIdentitySegment(segment, { voiceprints }))
    .filter((segment) => segment.speakerLabel);
}

function officeAudioTimedTextSegment(segment) {
  return {
    text: optionalString(segment.text ?? segment.transcript ?? segment.value) ?? "",
    startMs: segment.start_ms != null
      ? millisecondsToMs(segment.start_ms)
      : secondsToMs(segment.start ?? segment.start_time),
    endMs: segment.end_ms != null
      ? millisecondsToMs(segment.end_ms)
      : secondsToMs(segment.end ?? segment.end_time),
    speakerLabel: optionalString(segment.speaker ?? segment.label ?? segment.speaker_label ?? segment.speakerLabel),
    confidence: typeof segment.confidence === "number" ? segment.confidence : null,
  };
}

function officeAudioTimedIdentitySegment(segment, { voiceprints }) {
  const speakerLabel = optionalString(
    segment.speaker
      ?? segment.label
      ?? segment.speaker_label
      ?? segment.speakerLabel
      ?? segment.identity
      ?? segment.voiceprint_label
      ?? segment.voiceprint?.label,
  );
  const voiceprint = voiceprints.find((candidate) => candidate.label === speakerLabel);
  return {
    text: optionalString(segment.text ?? segment.transcript) ?? "",
    startMs: segment.start_ms != null
      ? millisecondsToMs(segment.start_ms)
      : secondsToMs(segment.start ?? segment.start_time),
    endMs: segment.end_ms != null
      ? millisecondsToMs(segment.end_ms)
      : secondsToMs(segment.end ?? segment.end_time),
    speakerLabel,
    speakerIdentifierProvider: voiceprint ? "pyannoteai" : optionalString(segment.provider),
    speakerIdentifier: optionalString(segment.voiceprint ?? segment.voiceprint_id ?? segment.speaker_id)
      ?? voiceprint?.voiceprint
      ?? null,
    confidence: typeof segment.confidence === "number"
      ? segment.confidence
      : typeof segment.score === "number"
        ? segment.score
        : null,
  };
}

function officeAudioAttachIdentityToTranscriptSegments(transcriptSegments, identitySegments, { voiceprints }) {
  if (!Array.isArray(identitySegments) || identitySegments.length === 0) {
    return transcriptSegments.map((segment) => ({
      ...segment,
      speakerIdentifierProvider: null,
    }));
  }
  return transcriptSegments.map((segment) => {
    const match = bestOverlappingSegment(segment, identitySegments);
    if (!match) return { ...segment, speakerIdentifierProvider: null };
    const voiceprint = voiceprints.find((candidate) => candidate.label === match.speakerLabel);
    const duration = Math.max(1, Math.round(Number(segment.endMs ?? 0) - Number(segment.startMs ?? 0)));
    const overlap = intervalOverlapMs(segment, match);
    const overlapRatio = overlap / duration;
    return {
      ...segment,
      speakerLabel: match.speakerLabel ?? segment.speakerLabel,
      speakerIdentifierProvider: match.speakerIdentifierProvider ?? (voiceprint ? "pyannoteai" : null),
      speakerIdentifier: match.speakerIdentifier ?? voiceprint?.voiceprint ?? segment.speakerIdentifier ?? null,
      speakerConfidence: typeof match.confidence === "number" ? match.confidence : segment.speakerConfidence,
      diarizationConfidence: typeof match.confidence === "number" ? match.confidence : segment.diarizationConfidence,
      alignmentConfidence: Math.max(0.1, Math.min(1, overlapRatio)),
      identityAlignment: {
        overlapMs: overlap,
        overlapRatio,
        uncertain: overlapRatio < 0.5,
      },
    };
  });
}

function bestOverlappingSegment(segment, candidates) {
  let best = null;
  let bestOverlap = 0;
  for (const candidate of candidates) {
    const overlap = intervalOverlapMs(segment, candidate);
    if (overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  if (!best || bestOverlap <= 0) return null;
  return best;
}

function intervalOverlapMs(left, right) {
  const start = Math.max(Number(left.startMs ?? 0), Number(right.startMs ?? 0));
  const end = Math.min(Number(left.endMs ?? left.startMs ?? 0), Number(right.endMs ?? right.startMs ?? 0));
  return Math.max(0, end - start);
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function isOfficeAudioArrayProductExecuted(product) {
  return product?.execution?.executed === true;
}

function isOfficeAudioArrayProductBenchmarkPassed(product) {
  return product?.benchmarkEvidence?.passed === true;
}

function isHeavyOfficeAudioArrayProduct(product) {
  const algorithm = String(product?.algorithm ?? "");
  const stages = Array.isArray(product?.enhancementStages) ? product.enhancementStages : [];
  return /wpe|mvdr|gev|gss|source[_-]?separation|neural/i.test(algorithm)
    || stages.some((stage) => /wpe|mvdr|gev|gss|source[_-]?separation|neural/i.test(String(stage)));
}

function officeAudioProviderResultFromSegments({ input, provider, model, sourceSegments, identityPolicy, metadata }) {
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  const speakerProfiles = Array.isArray(input.speakerProfiles) ? input.speakerProfiles : [];
  const firstSource = sourceSegments[0]?.source ?? chunks[0] ?? {};
  const startedAtMs = Date.parse(String(firstSource.startedAt ?? chunks[0]?.startedAt ?? "")) || Date.now();
  const turns = [];
  let turnIndex = 0;
  for (const { source, segments } of sourceSegments) {
    const sourceStartMs = Date.parse(String(source.startedAt ?? ""));
    const offsetMs = Number.isFinite(sourceStartMs) ? sourceStartMs - startedAtMs : 0;
    for (const rawSegment of segments) {
      const text = optionalString(rawSegment.text);
      if (!text) continue;
      const speaker = officeAudioKnownSpeakerFromProviderSegment(provider, rawSegment, speakerProfiles);
      const sourceDeviceIds = officeAudioSourceDeviceIds(source);
      const speakerLabel = optionalString(rawSegment.speakerLabel ?? rawSegment.speaker ?? rawSegment.label) ?? "unknown";
      turns.push({
        turnIndex,
        startMs: offsetMs + Math.max(0, Math.round(Number(rawSegment.startMs ?? 0) || 0)),
        endMs: offsetMs + Math.max(0, Math.round(Number(rawSegment.endMs ?? rawSegment.startMs ?? 0) || 0)),
        text,
        speakerLabel,
        speakerIdentityStatus: speaker ? "inferred" : "unknown",
        speakerPersonId: speaker?.profile.speakerId ?? null,
        speakerDisplayName: speaker?.profile.displayName ?? null,
        speakerConfidence: speaker ? (rawSegment.speakerConfidence ?? rawSegment.confidence ?? 0.82) : 0,
        speakerEvidence: speaker ? [{
          type: "speaker_identifier_match",
          provider: speaker.identifier?.provider ?? rawSegment.speakerIdentifierProvider ?? provider,
          model,
          label: speakerLabel,
          identifier: speaker.identifier?.identifier ?? rawSegment.speakerIdentifier ?? null,
          matchedSpeakerId: speaker.profile.speakerId,
        }] : [],
        primaryProviderDeviceId: source.primaryProviderDeviceId ?? source.deviceId ?? null,
        sourceProviderDeviceIds: sourceDeviceIds,
        alignmentConfidence: typeof rawSegment.alignmentConfidence === "number"
          ? rawSegment.alignmentConfidence
          : typeof source.alignmentConfidence === "number"
            ? source.alignmentConfidence
            : 0.8,
        diarizationConfidence: rawSegment.speakerLabel || rawSegment.speaker ? (rawSegment.diarizationConfidence ?? 0.75) : null,
        asrConfidence: rawSegment.confidence ?? null,
        consentState: speaker?.profile.consent?.state === "consented" ? "consented" : "pending_review",
      });
      turnIndex += 1;
    }
  }
  if (turns.length === 0) {
    throw new Error(`office-audio-provider-${provider} produced no transcript turns.`);
  }
  return {
    provider,
    model,
    sessions: [{
      sourceSessionId: input.sourceSessionId,
      title: "Office audio transcript",
      room: input.roomProfileId ?? null,
      startedAt: chunks[0]?.startedAt ?? firstSource.startedAt ?? new Date(startedAtMs).toISOString(),
      endedAt: chunks[chunks.length - 1]?.endedAt ?? sourceSegments[sourceSegments.length - 1]?.source?.endedAt ?? null,
      devices: input.devices ?? [],
      alignments: input.alignments ?? [],
      consents: speakerProfiles.map((profile) => ({
        participantKey: profile.speakerId,
        participantUserId: profile.speakerId,
        participantDisplayName: profile.displayName,
        state: profile.consent?.state ?? "pending",
        source: profile.consent?.source ?? "voice_enrollment",
        evidence: { profileStatus: profile.status, provider },
        consentedAt: profile.consent?.consentedAt ?? null,
      })),
      turns,
      metadata: {
        provider,
        model,
        identityPolicy,
        ...metadata,
        arrayProcessing: officeAudioProviderArrayProcessingMetadata(input),
      },
    }],
  };
}

function officeAudioProviderArrayProcessingMetadata(input) {
  if (!Array.isArray(input.arrayProducts) || input.arrayProducts.length === 0) return { mode: "single_device_chunks" };
  return {
    mode: "distributed_microphone_array",
    enhancementPlan: input.enhancementPlan?.schema ?? null,
    products: input.arrayProducts.map((product) => ({
      productId: product.productId,
      algorithm: product.algorithm,
      role: product.role,
      sourceProviderDeviceIds: product.sourceProviderDeviceIds,
      confidence: product.alignmentConfidence,
      executed: product.execution?.executed === true,
    })),
  };
}

function officeAudioKnownSpeakerFromProviderSegment(provider, segment, speakerProfiles) {
  if (provider === "deepgram" || provider === "soniox") return null;
  const label = optionalString(segment.speakerLabel ?? segment.speaker ?? segment.label);
  const identifier = optionalString(segment.speakerIdentifier ?? segment.speakerId ?? segment.speaker_id ?? segment.identity ?? segment.voiceprint);
  const identifierProvider = optionalString(segment.speakerIdentifierProvider ?? segment.identityProvider) ?? provider;
  if (!label && !identifier) return null;
  for (const profile of speakerProfiles) {
    const identifiers = Array.isArray(profile.speakerIdentifiers) ? profile.speakerIdentifiers : [];
    for (const candidate of identifiers) {
      if (candidate?.provider !== identifierProvider) continue;
      const candidateId = optionalString(candidate.identifier ?? candidate.id);
      const candidateLabel = optionalString(candidate.label);
      if (identifier && candidateId && identifier === candidateId) return { profile, identifier: candidate };
      if (label && candidateLabel && label === candidateLabel && candidateId && identifier === candidateId) return { profile, identifier: candidate };
    }
  }
  return null;
}

function officeAudioSourceDeviceIds(source) {
  return Array.isArray(source.sourceProviderDeviceIds)
    ? source.sourceProviderDeviceIds.filter(Boolean)
    : [source.deviceId ?? source.providerDeviceId].filter(Boolean);
}

function elevenLabsSegments(body) {
  if (Array.isArray(body?.transcripts)) {
    return body.transcripts.flatMap((transcript) => elevenLabsSegments(transcript));
  }
  const words = Array.isArray(body?.words)
    ? body.words
    : Array.isArray(body?.word_timestamps)
      ? body.word_timestamps
      : [];
  if (words.length > 0) {
    return segmentsFromTimedWords(words.map((word) => ({
      word: optionalString(word.text ?? word.word) ?? "",
      startMs: word.start_ms != null ? millisecondsToMs(word.start_ms) : secondsToMs(word.start ?? word.start_time),
      endMs: word.end_ms != null ? millisecondsToMs(word.end_ms) : secondsToMs(word.end ?? word.end_time),
      speakerLabel: optionalString(word.speaker_id ?? word.speaker ?? word.speakerLabel),
      speakerIdentifier: optionalString(word.speaker_identifier ?? word.speaker_id),
      confidence: typeof word.confidence === "number" ? word.confidence : null,
    })));
  }
  const text = optionalString(body?.text ?? body?.transcript);
  return text ? [{ text, startMs: 0, endMs: secondsToMs(body?.duration ?? body?.duration_seconds), speakerLabel: null, confidence: body?.confidence ?? null }] : [];
}

function deepgramSegments(body) {
  const words = [];
  for (const channel of body?.results?.channels ?? []) {
    for (const alternative of channel?.alternatives ?? []) {
      for (const word of alternative?.words ?? []) {
        words.push({
          word: optionalString(word.punctuated_word ?? word.word) ?? "",
          startMs: secondsToMs(word.start),
          endMs: secondsToMs(word.end),
          speakerLabel: word.speaker != null ? `speaker_${word.speaker}` : null,
          speakerIdentifier: word.speaker != null ? String(word.speaker) : null,
          confidence: typeof word.confidence === "number" ? word.confidence : null,
        });
      }
    }
  }
  if (words.length > 0) return segmentsFromTimedWords(words);
  const transcript = optionalString(body?.results?.channels?.[0]?.alternatives?.[0]?.transcript);
  return transcript ? [{ text: transcript, startMs: 0, endMs: 0, speakerLabel: null, confidence: null }] : [];
}

function sonioxSegments(body) {
  const tokens = Array.isArray(body?.tokens)
    ? body.tokens
    : Array.isArray(body?.words)
      ? body.words
      : [];
  if (tokens.length > 0) {
    return segmentsFromTimedWords(tokens.map((token) => ({
      word: optionalString(token.text ?? token.word) ?? "",
      startMs: token.start_ms != null || token.startMs != null
        ? millisecondsToMs(token.start_ms ?? token.startMs)
        : secondsToMs(token.start),
      endMs: token.end_ms != null || token.endMs != null
        ? millisecondsToMs(token.end_ms ?? token.endMs)
        : secondsToMs(token.end),
      speakerLabel: optionalString(token.speaker ?? token.speakerLabel ?? token.speaker_id),
      speakerIdentifier: optionalString(token.speaker_id ?? token.speakerIdentifier),
      confidence: typeof token.confidence === "number" ? token.confidence : null,
    })));
  }
  const segments = Array.isArray(body?.segments) ? body.segments : [];
  return segments.map((segment) => ({
    text: optionalString(segment.text) ?? "",
    startMs: segment.start_ms != null || segment.startMs != null
      ? millisecondsToMs(segment.start_ms ?? segment.startMs)
      : secondsToMs(segment.start),
    endMs: segment.end_ms != null || segment.endMs != null
      ? millisecondsToMs(segment.end_ms ?? segment.endMs)
      : secondsToMs(segment.end),
    speakerLabel: optionalString(segment.speaker ?? segment.speakerLabel),
    speakerIdentifier: optionalString(segment.speaker_id ?? segment.speakerIdentifier),
    confidence: segment.confidence ?? null,
  })).filter((segment) => segment.text);
}

function pyannoteAiSegments(body) {
  const segments = Array.isArray(body?.segments)
    ? body.segments
    : Array.isArray(body?.diarization)
      ? body.diarization
      : Array.isArray(body?.output?.diarization)
        ? body.output.diarization
        : [];
  return segments.map((segment) => ({
    text: optionalString(segment.text ?? segment.transcript) ?? "",
    startMs: segment.start_ms != null
      ? millisecondsToMs(segment.start_ms)
      : secondsToMs(segment.start ?? segment.start_time),
    endMs: segment.end_ms != null
      ? millisecondsToMs(segment.end_ms)
      : secondsToMs(segment.end ?? segment.end_time),
    speakerLabel: optionalString(segment.speaker ?? segment.label ?? segment.speaker_label),
    speakerIdentifier: optionalString(segment.speaker_id ?? segment.identity ?? segment.voiceprint),
    confidence: segment.confidence ?? segment.speaker_confidence ?? null,
  })).filter((segment) => segment.text || segment.speakerLabel);
}

function segmentsFromTimedWords(words) {
  const segments = [];
  let current = null;
  const flush = () => {
    if (!current || current.words.length === 0) return;
    segments.push({
      text: joinTranscriptWords(current.words),
      startMs: current.startMs,
      endMs: current.endMs,
      speakerLabel: current.speakerLabel,
      speakerIdentifier: current.speakerIdentifier,
      confidence: current.confidences.length > 0
        ? current.confidences.reduce((sum, value) => sum + value, 0) / current.confidences.length
        : null,
    });
  };
  for (const word of words) {
    const text = optionalString(word.word);
    if (!text) continue;
    const startMs = Number.isFinite(word.startMs) ? word.startMs : current?.endMs ?? 0;
    const endMs = Number.isFinite(word.endMs) ? word.endMs : startMs;
    const speakerLabel = optionalString(word.speakerLabel) ?? "unknown";
    const sameSpeaker = current && current.speakerLabel === speakerLabel && startMs - current.endMs <= 1200;
    if (!sameSpeaker) {
      flush();
      current = {
        words: [],
        startMs,
        endMs,
        speakerLabel,
        speakerIdentifier: optionalString(word.speakerIdentifier) ?? null,
        confidences: [],
      };
    }
    current.words.push(text);
    current.endMs = Math.max(current.endMs, endMs);
    if (typeof word.confidence === "number") current.confidences.push(word.confidence);
  }
  flush();
  return segments;
}

function joinTranscriptWords(words) {
  let output = "";
  for (const word of words) {
    if (/^[,.;:!?)]/.test(word)) output += word;
    else if (!output || output.endsWith("(")) output += word;
    else output += ` ${word}`;
  }
  return output.trim();
}

function secondsToMs(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

function millisecondsToMs(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

async function sonioxHttpTranscribe({ apiKey, audioPath, model, url }) {
  const audio = await readFile(audioPath);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), basename(audioPath));
  form.append("model", model);
  form.append("enable_speaker_diarization", "true");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
  return readJsonResponse(response, "Soniox transcription");
}

function sonioxRealtimeTranscribe({ apiKey, audioPath, model }) {
  return new Promise((resolve, reject) => {
    const url = optionalString(process.env.SHEPHERD_SONIOX_REALTIME_URL) ?? "wss://stt-rt.soniox.com/transcribe-websocket";
    const ws = new WebSocketClient(url);
    const messages = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(error);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({ tokens: messages.flatMap((message) => message.tokens ?? message.words ?? []), messages });
    };
    const timer = setTimeout(() => fail(new Error("Soniox realtime session timed out.")), 120_000);
    ws.on("open", () => {
      void (async () => {
        const wav = await readPcm16WavMono(audioPath);
        if (!wav) {
          clearTimeout(timer);
          fail(new Error("Soniox realtime adapter requires PCM16 WAV input."));
          return;
        }
        ws.send(JSON.stringify({
          api_key: apiKey,
          model,
          audio_format: "pcm_s16le",
          sample_rate: wav.sampleRate,
          num_channels: 1,
          enable_speaker_diarization: true,
        }));
        ws.send(pcm16BytesFromFloatSamples(wav.samples));
        ws.send(JSON.stringify({ type: "finalize" }));
      })().catch((error) => {
        clearTimeout(timer);
        fail(error instanceof Error ? error : new Error("Soniox realtime audio preparation failed."));
      });
    });
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      } catch {
        return;
      }
      messages.push(message);
      if (message.error) {
        clearTimeout(timer);
        fail(new Error(`Soniox realtime error: ${message.error_code ?? "unknown"}`));
      }
      if (message.finished || message.type === "final" || message.type === "finished") {
        clearTimeout(timer);
        done();
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      fail(new Error("Soniox realtime websocket failed."));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (!settled) done();
    });
  });
}

async function pyannoteAiDiarizeTranscribe({ apiKey, url, model, audioUrl }) {
  return pyannoteAiStartAndPollJob({
    apiKey,
    url,
    label: "pyannoteAI diarize",
    body: {
      model,
      url: audioUrl,
      transcription: true,
      exclusive: true,
      turnLevelConfidence: true,
      transcriptionConfig: officeAudioPyannoteTranscriptionConfig(),
    },
  });
}

async function pyannoteAiIdentify({ apiKey, url, model, audioUrl, voiceprints }) {
  return pyannoteAiStartAndPollJob({
    apiKey,
    url,
    label: "pyannoteAI identify",
    body: {
      model,
      url: audioUrl,
      exclusive: true,
      turnLevelConfidence: true,
      voiceprints: voiceprints.map((voiceprint) => ({
        label: voiceprint.label,
        voiceprint: voiceprint.voiceprint,
      })),
    },
  });
}

async function pyannoteAiCreateVoiceprint({ apiKey, url, model, audioUrl }) {
  return pyannoteAiStartAndPollJob({
    apiKey,
    url,
    label: "pyannoteAI voiceprint",
    body: {
      model,
      url: audioUrl,
    },
  });
}

function officeAudioPyannoteTranscriptionConfig() {
  const model = optionalString(process.env.SHEPHERD_PYANNOTEAI_TRANSCRIPTION_MODEL);
  return model ? { model } : undefined;
}

async function pyannoteAiStartAndPollJob({ apiKey, url, body, label }) {
  const response = await fetch(url, {
    method: "POST",
    headers: pyannoteAiHeaders(apiKey),
    body: JSON.stringify(removeUndefinedJsonFields(body)),
  });
  const started = await readJsonResponse(response, label);
  return pyannoteAiPollJobIfNeeded({ apiKey, started, label });
}

async function pyannoteAiPollJobIfNeeded({ apiKey, started, label }) {
  if (pyannoteAiJobCompleted(started) || !pyannoteAiJobId(started)) return started;
  const jobId = pyannoteAiJobId(started);
  const attempts = positiveIntFromEnv("SHEPHERD_PYANNOTEAI_POLL_ATTEMPTS", 120);
  const intervalMs = positiveIntFromEnv("SHEPHERD_PYANNOTEAI_POLL_INTERVAL_MS", 1000);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);
    const url = officeAudioPyannoteJobUrl(jobId);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });
    const body = await readJsonResponse(response, `${label} job`);
    if (pyannoteAiJobFailed(body)) throw new Error(`${label} job failed; body redacted`);
    if (pyannoteAiJobCompleted(body)) return body;
  }
  throw new Error(`${label} job did not finish before polling limit.`);
}

function pyannoteAiHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function officeAudioPyannoteJobUrl(jobId) {
  const template = optionalString(process.env.SHEPHERD_PYANNOTEAI_JOB_URL);
  if (template) return template.replace("{jobId}", encodeURIComponent(jobId));
  return `https://api.pyannote.ai/v1/jobs/${encodeURIComponent(jobId)}`;
}

function pyannoteAiJobId(body) {
  return optionalString(body?.jobId)
    ?? optionalString(body?.job_id)
    ?? optionalString(body?.id)
    ?? optionalString(body?.job?.id)
    ?? null;
}

function pyannoteAiJobCompleted(body) {
  const status = optionalString(body?.status ?? body?.jobStatus ?? body?.job_status)?.toLowerCase();
  if (["succeeded", "success", "completed", "complete", "done"].includes(status ?? "")) return true;
  return Boolean(
    body?.output
      || body?.diarization
      || body?.identification
      || body?.turnLevelTranscription
      || body?.wordLevelTranscription
      || body?.voiceprint
      || body?.voiceprints,
  );
}

function pyannoteAiJobFailed(body) {
  const status = optionalString(body?.status ?? body?.jobStatus ?? body?.job_status)?.toLowerCase();
  return ["failed", "error", "canceled", "cancelled"].includes(status ?? "");
}

function removeUndefinedJsonFields(value) {
  if (Array.isArray(value)) return value.map(removeUndefinedJsonFields);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    output[key] = removeUndefinedJsonFields(item);
  }
  return output;
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with ${response.status}; body redacted`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} did not return JSON.`);
  }
}

function startOfficeAudioMacCollector({ config, userId, rawDir, chunkDir, controlPath }) {
  let stopped = false;
  let child = null;
  let last = {
    ok: true,
    startedAt: null,
    finishedAt: null,
    chunksRecorded: 0,
    lastChunkPath: null,
    lastManifestPath: null,
    lastError: null,
  };
  const localAudioKey = officeAudioLocalKey(config);
  const chunkSeconds = Math.max(5, Math.min(300, Math.floor(Number(config.chunkSeconds ?? 30) || 30)));
  const deviceId = requiredConfigString(config.deviceId ?? `mac-${safeFileId(userId)}`, "deviceId");

  const loop = async () => {
    if (platform() !== "darwin") {
      last = { ...last, ok: false, lastError: "Built-in Office Audio capture currently requires macOS afrecord." };
      return;
    }
    while (!stopped) {
      const control = readJsonOptional(controlPath);
      if (control?.paused === true) {
        await sleep(1000);
        continue;
      }
      const startedAt = new Date();
      const chunkId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
      const wavPath = join(chunkDir, `${chunkId}.wav`);
      const encryptedPath = `${wavPath}.enc`;
      const manifestPath = join(chunkDir, `${chunkId}.json`);
      try {
        await mkdir(chunkDir, { recursive: true });
        child = spawn("/usr/bin/afrecord", ["-f", "WAVE", "-d", String(chunkSeconds), wavPath], {
          cwd: rawDir,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        const exit = await waitForChild(child);
        child = null;
        if (exit.code !== 0) {
          throw new Error(`afrecord exited with ${exit.code ?? exit.signal ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
        }
        const endedAt = new Date();
        const audio = await readFile(wavPath);
        const encrypted = encryptOfficeAudioChunk(audio, localAudioKey);
        await writeFile(encryptedPath, encrypted.payload, { mode: 0o600 });
        const manifest = {
          schema: "office_audio_raw_chunk.v1",
          userId,
          sourceSessionId: config.sourceSessionId ?? null,
          roomProfileId: config.roomProfileId ?? null,
          deviceId,
          inputDeviceUid: config.inputDeviceUid ?? null,
          chunkId,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
          format: "wav",
          encryptedPath,
          encryption: {
            algorithm: encrypted.algorithm,
            payloadLayout: encrypted.payloadLayout,
            ivBytes: encrypted.ivBytes,
            authTagBytes: encrypted.authTagBytes,
            keyId: config.localAudioKeyId ?? "local-config-key",
          },
          transcriptStatus: "pending_provider_transcription",
          note: "Encrypted raw mic chunk captured by the office-audio LaunchAgent. Provider ASR/diarization must produce canonical OfficeAudioSession transcript JSON before brain ingest.",
          createdAt: new Date().toISOString(),
        };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
        last = {
          ok: true,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          chunksRecorded: last.chunksRecorded + 1,
          lastChunkPath: encryptedPath,
          lastManifestPath: manifestPath,
          lastError: null,
        };
      } catch (err) {
        child = null;
        last = {
          ...last,
          ok: false,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          lastError: safeError(err),
        };
        await sleep(5000);
      } finally {
        cleanupOfficeAudioPlaintextChunk(wavPath);
      }
    }
  };
  loop().catch((err) => {
    last = { ...last, ok: false, lastError: safeError(err), finishedAt: new Date().toISOString() };
  });

  return {
    mode: "macos_afrecord_encrypted_chunks",
    kill: (signal) => {
      stopped = true;
      child?.kill(signal);
    },
    status: () => last,
  };
}

function cleanupOfficeAudioPlaintextChunk(wavPath) {
  try {
    if (existsSync(wavPath)) unlinkSync(wavPath);
  } catch {
    // best effort cleanup only
  }
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function officeAudioLocalKey(config) {
  const raw = requiredConfigString(config.localAudioKey, "localAudioKey");
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) throw new Error("Office Audio localAudioKey must be a 32-byte hex key.");
  return key;
}

function decryptOfficeAudioChunk(payload, key) {
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptOfficeAudioChunk(audio, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(audio), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    algorithm: "aes-256-gcm",
    payloadLayout: "iv|ciphertext|auth_tag",
    ivBytes: iv.length,
    authTagBytes: authTag.length,
    payload: Buffer.concat([iv, ciphertext, authTag]),
  };
}

async function officeAudioRawChunkManifests(chunkDir, { skipIdentityAudited = false } = {}) {
  let entries = [];
  try {
    entries = await readdir(chunkDir, { withFileTypes: true });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }

  const manifests = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(chunkDir, entry.name);
    const parsed = readJsonOptional(path);
    if (parsed?.schema !== "office_audio_raw_chunk.v1") continue;
    if (parsed.transcriptStatus === "spooled") continue;
    if (skipIdentityAudited && parsed.identityAuditStatus === "audited") continue;
    if (typeof parsed.encryptedPath !== "string" || !existsSync(parsed.encryptedPath)) continue;
    manifests.push({ ...parsed, path });
  }
  return manifests.sort((left, right) => String(left.startedAt ?? "").localeCompare(String(right.startedAt ?? "")));
}

function sourceSessionIdForManifests(config, manifests) {
  const explicit = optionalString(config.sourceSessionId);
  if (explicit) return explicit;
  const manifestIds = new Set(manifests.map((manifest) => optionalString(manifest.sourceSessionId)).filter(Boolean));
  if (manifestIds.size === 1) return [...manifestIds][0];
  const room = safeFileId(config.roomProfileId ?? "room");
  const firstStartedAt = manifests[0]?.startedAt ? new Date(manifests[0].startedAt) : new Date();
  const stamp = Number.isNaN(firstStartedAt.getTime())
    ? Date.now().toString()
    : firstStartedAt.toISOString().replace(/[^0-9TZ]/g, "");
  return `${room}-${stamp}`;
}

function officeAudioDevicesFromManifests(config, manifests) {
  const byId = new Map();
  for (const manifest of manifests) {
    const providerDeviceId = String(manifest.deviceId ?? config.deviceId ?? "mac-local");
    if (byId.has(providerDeviceId)) continue;
    byId.set(providerDeviceId, {
      providerDeviceId,
      collectorUserId: config.userId,
      deviceName: providerDeviceId,
      inputDeviceUid: manifest.inputDeviceUid ?? config.inputDeviceUid ?? null,
      sampleRate: null,
      captureAppVersion: `askshepherd-${PACKAGE_VERSION}`,
      status: "captured",
      joinedAt: manifest.startedAt ?? null,
      leftAt: manifest.endedAt ?? null,
      metadata: {
        role: "room_sensor",
        chunkManifestSchema: manifest.schema,
      },
    });
  }
  return [...byId.values()];
}

async function officeAudioSpeakerProfiles(config) {
  await pullOfficeAudioSpeakerProfiles(config).catch(() => undefined);
  const channel = cliChannel(config.channel);
  const configuredRoots = [config.speakerProfilesDir, config.enrollmentDir].filter(Boolean);
  const roots = configuredRoots.length > 0
    ? configuredRoots
    : [join(homedir(), ".shepherd", "office-audio", `${channelFilePrefix(channel)}speaker-profiles`)];
  const profilesBySpeakerId = new Map();
  for (const root of roots) {
    const entries = await collectOfficeAudioProfileFiles(root);
    for (const path of entries) {
      const parsed = readJsonOptional(path);
      const profile = normalizeOfficeAudioSpeakerProfile(parsed);
      if (!profile) continue;
      const current = profilesBySpeakerId.get(profile.speakerId);
      if (!current || officeAudioSpeakerProfileRank(profile) >= officeAudioSpeakerProfileRank(current)) {
        profilesBySpeakerId.set(profile.speakerId, profile);
      }
    }
  }
  return [...profilesBySpeakerId.values()].map(officeAudioSpeakerProfileForProvider);
}

function officeAudioSpeakerProfileRank(profile) {
  const updatedAt = Date.parse(String(profile.updatedAt ?? ""));
  const freshness = Number.isFinite(updatedAt) ? updatedAt : 0;
  const enrolledBonus = profile.status === "enrolled" ? 10_000_000_000_000 : 0;
  const identifierBonus = profile.speakerIdentifiers.length * 1_000_000_000;
  const consentBonus = profile.consent?.state === "consented" ? 1_000_000 : 0;
  return enrolledBonus + identifierBonus + consentBonus + freshness;
}

function officeAudioSpeakerProfileForProvider(profile) {
  return {
    speakerId: profile.speakerId,
    displayName: profile.displayName,
    status: profile.status,
    consent: profile.consent,
    speakerIdentifiers: profile.speakerIdentifiers,
    evidence: profile.evidence,
    provider: profile.provider ?? null,
    updatedAt: profile.updatedAt ?? null,
  };
}

async function collectOfficeAudioProfileFiles(root) {
  if (!root) return [];
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    else if (entry.isDirectory()) files.push(...await collectOfficeAudioProfileFiles(path));
  }
  return files;
}

function normalizeOfficeAudioSpeakerProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const speakerId = optionalString(input.speakerId);
  if (!speakerId) return null;
  const identifiers = Array.isArray(input.speakerIdentifiers)
    ? input.speakerIdentifiers
      .map((identifier) => {
        if (!identifier || typeof identifier !== "object" || Array.isArray(identifier)) return null;
        const provider = optionalString(identifier.provider ?? input.provider);
        const model = optionalString(identifier.model ?? input.model);
        const value = optionalString(identifier.identifier ?? identifier.speakerIdentifier ?? identifier.id);
        if (!provider || !value) return null;
        return {
          provider,
          model: model ?? null,
          identifier: value,
          label: optionalString(identifier.label) ?? speakerId,
          createdAt: optionalString(identifier.createdAt) ?? optionalString(input.updatedAt) ?? new Date().toISOString(),
        };
      })
      .filter(Boolean)
    : [];
  return {
    schema: "office_audio_speaker_profile.v1",
    speakerId,
    displayName: optionalString(input.displayName) ?? speakerId,
    status: optionalString(input.status) ?? (identifiers.length > 0 ? "enrolled" : "local_clip_only"),
    consent: input.consent && typeof input.consent === "object" && !Array.isArray(input.consent)
      ? input.consent
      : { state: "pending", source: "unknown" },
    enrollmentClips: Array.isArray(input.enrollmentClips) ? input.enrollmentClips : [],
    speakerIdentifiers: identifiers,
    provider: optionalString(input.provider) ?? identifiers[0]?.provider ?? null,
    confidence: typeof input.confidence === "number" ? input.confidence : null,
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    updatedAt: optionalString(input.updatedAt) ?? new Date().toISOString(),
  };
}

async function pullOfficeAudioSpeakerProfiles(config) {
  if (config.syncSpeakerProfiles === false) return;
  const apiUrl = optionalString(config.apiUrl);
  const agentToken = optionalString(config.agentToken);
  if (!apiUrl || !agentToken) return;
  const channel = cliChannel(config.channel);
  const url = `${trimTrailingSlash(apiUrl)}/api/office-audio/speaker-profiles`;
  const response = await fetch(url, {
    headers: { "x-api-key": agentToken },
  });
  if (!response.ok) throw new Error(`speaker profile pull failed with ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.profiles)) return;
  const root = join(homedir(), ".shepherd", "office-audio", `${channelFilePrefix(channel)}speaker-profiles`, "synced");
  await mkdir(root, { recursive: true });
  const activeSpeakerIds = new Set();
  for (const raw of body.profiles) {
    const profile = normalizeOfficeAudioSpeakerProfile(raw);
    if (!profile) continue;
    activeSpeakerIds.add(profile.speakerId);
    const path = join(root, `${safeFileId(profile.speakerId)}.json`);
    await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  }
  const syncedFiles = await collectOfficeAudioProfileFiles(root);
  for (const path of syncedFiles) {
    const profile = normalizeOfficeAudioSpeakerProfile(readJsonOptional(path));
    if (profile && activeSpeakerIds.has(profile.speakerId)) continue;
    await rm(path, { force: true });
  }
}

async function pushOfficeAudioSpeakerProfile(config, profile) {
  if (config.syncSpeakerProfiles === false) return null;
  const apiUrl = optionalString(config.apiUrl);
  const agentToken = optionalString(config.agentToken);
  if (!apiUrl || !agentToken) return null;
  const response = await fetch(`${trimTrailingSlash(apiUrl)}/api/office-audio/speaker-profiles`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": agentToken,
    },
    body: JSON.stringify({ profile: officeAudioSpeakerProfileForProvider(profile) }),
  });
  if (!response.ok) throw new Error(`speaker profile push failed with ${response.status}`);
  return response.json();
}

async function runOfficeAudioProviderCommand(command, providerInput) {
  const child = spawn(command[0], command.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SHEPHERD_OFFICE_AUDIO_PROVIDER_INPUT_SCHEMA: providerInput.schema,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.resume();
  child.stdin.end(`${JSON.stringify(providerInput)}\n`);
  const exit = await waitForChild(child);
  if (exit.code !== 0) {
    throw new Error(`Office Audio provider command failed with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}; stderr redacted`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Office Audio provider command did not return JSON; stderr redacted");
  }
}

function normalizeOfficeAudioProviderSessions(providerResult, providerInput, manifests, config) {
  const rawSessions = Array.isArray(providerResult?.sessions)
    ? providerResult.sessions
    : Array.isArray(providerResult)
      ? providerResult
      : providerResult && typeof providerResult === "object"
        ? [providerResult]
        : [];
  if (rawSessions.length === 0) throw new Error("Office Audio provider returned no sessions.");

  return rawSessions.map((session, index) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) {
      throw new Error("Office Audio provider session must be an object.");
    }
    const turns = Array.isArray(session.turns) ? session.turns : [];
    if (turns.length === 0) throw new Error("Office Audio provider session must include turns; refusing empty transcript.");
    return {
      ...session,
      sourceSessionId: optionalString(session.sourceSessionId) ?? (index === 0 ? providerInput.sourceSessionId : `${providerInput.sourceSessionId}-${index + 1}`),
      room: optionalString(session.room) ?? config.roomProfileId ?? null,
      startedAt: optionalString(session.startedAt) ?? manifests[0]?.startedAt ?? new Date().toISOString(),
      endedAt: optionalString(session.endedAt) ?? manifests[manifests.length - 1]?.endedAt ?? null,
      status: optionalString(session.status) ?? "processed",
      shareScope: optionalString(session.shareScope) ?? "participants",
      retentionPolicy: optionalString(session.retentionPolicy) ?? "test_room_default",
      devices: Array.isArray(session.devices) && session.devices.length > 0 ? session.devices : providerInput.devices,
      alignments: Array.isArray(session.alignments) && session.alignments.length > 0
        ? session.alignments
        : providerInput.alignments ?? officeAudioAlignmentsFromManifests(manifests),
      turns,
      metadata: {
        ...(session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? session.metadata : {}),
        provider: providerResult.provider ?? providerResult.model ?? "external_provider_command",
        providerCommand: providerResult.transcriptionBackend ? "built_in" : providerInput.policy.rawAudioIsTemporary ? "external_command_redacted" : "external_command",
        transcriptionBackend: providerResult.transcriptionBackend ?? config.transcriptionBackend ?? null,
        ...officeAudioSpacesSessionMetadata(providerInput),
        chunkIds: manifests.map((manifest) => manifest.chunkId).filter(Boolean),
        generatedBy: "office-audio-process-chunks",
        generatedAt: new Date().toISOString(),
      },
    };
  });
}

function officeAudioSpacesSessionMetadata(providerInput) {
  if (!providerInput.roomOwnerUserId && !providerInput.roomCode) {
    return { source: "office_audio" };
  }
  return {
    source: "shepherd_spaces",
    roomOwnerUserId: providerInput.roomOwnerUserId,
    roomCode: providerInput.roomCode,
  };
}

async function officeAudioFinalizeProviderResultWithGptOss(providerResult, providerInput, { backend }) {
  const apiKey = optionalString(process.env.FIREWORKS_API_KEY ?? process.env.SHEPHERD_FIREWORKS_API_KEY);
  const model = officeAudioTranscriptMergeModel();
  const sessions = Array.isArray(providerResult.sessions) ? providerResult.sessions : [];
  if (!apiKey) {
    return officeAudioProviderResultWithMergeMetadata(providerResult, {
      backend,
      mergeProvider: "deterministic_fallback",
      mergeModel: model,
      mergeSkippedReason: "missing_fireworks_api_key",
    });
  }
  const finalizedSessions = [];
  for (const session of sessions) {
    const turns = Array.isArray(session.turns) ? session.turns : [];
    if (turns.length === 0) {
      finalizedSessions.push(session);
      continue;
    }
    const sourceTurns = officeAudioMergeSourceTurns(turns);
    let mergedTurns;
    let mergeProvider = "fireworks";
    let mergeFallbackReason = null;
    try {
      mergedTurns = await officeAudioMergeTurnsWithGptOss({
        apiKey,
        model,
        sourceSessionId: session.sourceSessionId ?? providerInput.sourceSessionId,
        sourceDeviceIds: [...new Set(sourceTurns.flatMap((turn) => turn.sourceDeviceIds))],
        speakerProfiles: Array.isArray(providerInput.speakerProfiles) ? providerInput.speakerProfiles : [],
        turns: sourceTurns,
      });
    } catch {
      mergedTurns = officeAudioFallbackMergedTranscriptTurns(sourceTurns);
      mergeProvider = "deterministic_fallback";
      mergeFallbackReason = "fireworks_error";
    }
    if (!Array.isArray(mergedTurns) || mergedTurns.length === 0) {
      mergedTurns = officeAudioFallbackMergedTranscriptTurns(sourceTurns);
      mergeProvider = "deterministic_fallback";
      mergeFallbackReason = mergeFallbackReason ?? "empty_fireworks_merge";
    }
    finalizedSessions.push({
      ...session,
      turns: mergedTurns.map((turn, index) => ({
        turnIndex: index,
        startMs: turn.startMs,
        endMs: Math.max(turn.startMs, turn.endMs),
        text: turn.text,
        speakerLabel: turn.speakerLabel,
        speakerIdentityStatus: turn.speakerIdentityStatus,
        speakerPersonId: turn.speakerPersonId,
        speakerDisplayName: turn.speakerDisplayName,
        speakerConfidence: turn.speakerConfidence,
        speakerEvidence: turn.speakerEvidence,
        primaryProviderDeviceId: turn.primaryProviderDeviceId,
        sourceProviderDeviceIds: turn.sourceDeviceIds,
        alignmentConfidence: turn.alignmentConfidence,
        diarizationConfidence: turn.diarizationConfidence,
        asrConfidence: turn.asrConfidence,
        consentState: turn.consentState ?? "pending_review",
      })),
      metadata: {
        ...(session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? session.metadata : {}),
        transcriptionBackend: backend,
        mergeProvider,
        mergeModel: model,
        ...(mergeFallbackReason ? { mergeFallbackReason } : {}),
      },
    });
  }
  return {
    ...providerResult,
    transcriptionBackend: backend,
    sessions: finalizedSessions,
  };
}

function officeAudioProviderResultWithMergeMetadata(providerResult, metadata) {
  return {
    ...providerResult,
    transcriptionBackend: metadata.backend,
    sessions: (Array.isArray(providerResult.sessions) ? providerResult.sessions : []).map((session) => ({
      ...session,
      metadata: {
        ...(session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? session.metadata : {}),
        transcriptionBackend: metadata.backend,
        mergeProvider: metadata.mergeProvider,
        mergeModel: metadata.mergeModel,
        mergeSkippedReason: metadata.mergeSkippedReason,
      },
    })),
  };
}

async function officeAudioMergeTurnsWithGptOss({ apiKey, model, sourceSessionId, sourceDeviceIds, speakerProfiles, turns }) {
  const allowedSpeakers = speakerProfiles.map((profile) => ({
    speakerPersonId: profile.speakerId,
    speakerDisplayName: profile.displayName,
  }));
  const candidateTurns = turns.map((turn) => ({
    id: turn.id,
    startMs: turn.startMs,
    endMs: turn.endMs,
    text: turn.text,
    speakerLabel: turn.speakerLabel,
    speakerIdentityStatus: turn.speakerIdentityStatus,
    speakerPersonId: turn.speakerPersonId,
    speakerDisplayName: turn.speakerDisplayName,
    speakerConfidence: turn.speakerConfidence,
    sourceDeviceIds: turn.sourceDeviceIds,
    asrConfidence: turn.asrConfidence,
  }));
  const response = await fetch(officeAudioTranscriptMergeUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: positiveIntFromEnv("SHEPHERD_OFFICE_AUDIO_TRANSCRIPT_MERGE_MAX_TOKENS", 4096),
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You merge room meeting transcript candidates captured by multiple Mac microphones.",
            "Return JSON only with shape {\"turns\":[...]}",
            "Rules:",
            "- Merge duplicate candidates that overlap in time and represent the same utterance.",
            "- Adjacent chunks may overlap by 1-2 seconds; remove duplicated boundary words and repeated turns caused by chunk overlap.",
            "- If one overlapping candidate is clipped at the start/end and another contains the full phrase, keep the fuller wording.",
            "- Keep distinct overlapping speakers as separate turns.",
            "- Produce the best verbatim transcript of what was likely said.",
            "- Prefer words that appear in one or more source candidates.",
            "- You may fix obvious ASR errors when the correction is strongly implied by the other candidates, surrounding context, or normal spoken English.",
            "- Do not summarize, paraphrase, clean up style, or make the speaker sound more polished.",
            "- Do not add new claims, names, numbers, or technical terms unless they are present in a source candidate or unambiguous from context.",
            "- Preserve filler words, false starts, interruptions, and casual phrasing when they are audible in the candidates.",
            "- If uncertain between alternatives, choose the wording best supported by the clearest candidate and nearby context.",
            "- Speaker attribution is evidence-based only. Use a speaker name/personId only when a source candidate already has provider speaker evidence for that same utterance.",
            "- If speaker evidence is missing or conflicting, set speakerIdentityStatus to unknown and speakerPersonId/speakerDisplayName to null.",
            "- sourceTurnIds must list the candidate ids used for the merged turn.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            sourceSessionId,
            sourceDeviceIds,
            allowedSpeakers,
            candidateTurns,
          }),
        },
      ],
    }),
  });
  const body = await readJsonResponse(response, "Fireworks GPT-OSS transcript merge");
  const content = optionalString(body?.choices?.[0]?.message?.content) ?? "";
  const parsed = parseJsonValue(content);
  const items = Array.isArray(parsed?.turns) ? parsed.turns : [];
  const sourceById = new Map(turns.map((turn) => [turn.id, turn]));
  return items
    .map((item) => officeAudioNormalizeMergedTranscriptTurn(item, sourceById, allowedSpeakers))
    .filter(Boolean);
}

function officeAudioMergeSourceTurns(turns) {
  return turns.map((turn, index) => ({
    id: `turn-${index}`,
    startMs: Math.max(0, Math.round(Number(turn.startMs ?? 0) || 0)),
    endMs: Math.max(0, Math.round(Number(turn.endMs ?? turn.startMs ?? 0) || 0)),
    text: optionalString(turn.text) ?? "",
    speakerLabel: optionalString(turn.speakerLabel) ?? "unknown",
    speakerIdentityStatus: optionalString(turn.speakerIdentityStatus) ?? "unknown",
    speakerPersonId: optionalString(turn.speakerPersonId) ?? null,
    speakerDisplayName: optionalString(turn.speakerDisplayName) ?? null,
    speakerConfidence: typeof turn.speakerConfidence === "number" ? turn.speakerConfidence : 0,
    speakerEvidence: Array.isArray(turn.speakerEvidence) ? turn.speakerEvidence : [],
    primaryProviderDeviceId: turn.primaryProviderDeviceId ?? turn.primaryDeviceId ?? null,
    sourceDeviceIds: Array.isArray(turn.sourceProviderDeviceIds)
      ? turn.sourceProviderDeviceIds.filter(Boolean)
      : Array.isArray(turn.sourceDeviceIds)
        ? turn.sourceDeviceIds.filter(Boolean)
        : [],
    alignmentConfidence: typeof turn.alignmentConfidence === "number" ? turn.alignmentConfidence : null,
    diarizationConfidence: typeof turn.diarizationConfidence === "number" ? turn.diarizationConfidence : null,
    asrConfidence: typeof turn.asrConfidence === "number" ? turn.asrConfidence : null,
    consentState: optionalString(turn.consentState) ?? "pending_review",
  })).filter((turn) => turn.text);
}

function officeAudioFallbackMergedTranscriptTurns(turns) {
  return turns.slice().sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    .map((turn) => ({ ...turn, sourceTurnIds: [turn.id] }));
}

function officeAudioNormalizeMergedTranscriptTurn(input, sourceById, allowedSpeakers) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!value) return null;
  const sourceTurnIds = Array.isArray(value.sourceTurnIds)
    ? value.sourceTurnIds.map(optionalString).filter(Boolean)
    : [];
  const sourceTurns = sourceTurnIds.map((id) => sourceById.get(id)).filter(Boolean);
  if (sourceTurns.length === 0) return null;
  const primary = sourceTurns.slice().sort((left, right) => officeAudioTurnQualityScore(right) - officeAudioTurnQualityScore(left))[0];
  const text = optionalString(value.text) ?? primary.text;
  if (!text) return null;
  const claimedPersonId = optionalString(value.speakerPersonId);
  const claimedName = optionalString(value.speakerDisplayName);
  const allowed = allowedSpeakers.find((speaker) => speaker.speakerPersonId === claimedPersonId && speaker.speakerDisplayName === claimedName);
  const evidenceTurn = allowed
    ? sourceTurns.find((turn) => (
        turn.speakerPersonId === allowed.speakerPersonId
        && turn.speakerDisplayName === allowed.speakerDisplayName
        && ["confirmed", "corrected", "inferred"].includes(turn.speakerIdentityStatus)
        && Array.isArray(turn.speakerEvidence)
        && turn.speakerEvidence.length > 0
      ))
    : null;
  const sourceDeviceIds = [...new Set(sourceTurns.flatMap((turn) => turn.sourceDeviceIds))];
  return {
    startMs: Number.isFinite(Number(value.startMs)) ? Math.round(Number(value.startMs)) : Math.min(...sourceTurns.map((turn) => turn.startMs)),
    endMs: Number.isFinite(Number(value.endMs)) ? Math.round(Number(value.endMs)) : Math.max(...sourceTurns.map((turn) => turn.endMs)),
    text,
    speakerLabel: evidenceTurn?.speakerLabel ?? primary.speakerLabel ?? "unknown",
    speakerIdentityStatus: evidenceTurn?.speakerIdentityStatus ?? "unknown",
    speakerPersonId: evidenceTurn?.speakerPersonId ?? null,
    speakerDisplayName: evidenceTurn?.speakerDisplayName ?? null,
    speakerConfidence: evidenceTurn?.speakerConfidence ?? 0,
    speakerEvidence: evidenceTurn?.speakerEvidence ?? [],
    primaryProviderDeviceId: primary.primaryProviderDeviceId ?? null,
    sourceDeviceIds,
    alignmentConfidence: sourceTurns.reduce((sum, turn) => sum + (turn.alignmentConfidence ?? 0.8), 0) / sourceTurns.length,
    diarizationConfidence: evidenceTurn?.diarizationConfidence ?? primary.diarizationConfidence ?? null,
    asrConfidence: sourceTurns.reduce((sum, turn) => sum + (turn.asrConfidence ?? 0.8), 0) / sourceTurns.length,
    consentState: evidenceTurn?.consentState ?? primary.consentState ?? "pending_review",
    sourceTurnIds,
  };
}

function officeAudioTurnQualityScore(turn) {
  return (turn.asrConfidence ?? 0.5) + (turn.diarizationConfidence ?? 0.5) + (turn.speakerConfidence ?? 0);
}

function officeAudioTranscriptMergeModel() {
  return optionalString(process.env.SHEPHERD_OFFICE_AUDIO_TRANSCRIPT_MERGE_MODEL)
    ?? optionalString(process.env.OFFICE_AUDIO_TRANSCRIPT_MERGE_MODEL)
    ?? DEFAULT_OFFICE_AUDIO_TRANSCRIPT_MERGE_MODEL;
}

function officeAudioTranscriptMergeUrl() {
  return optionalString(process.env.SHEPHERD_FIREWORKS_CHAT_COMPLETIONS_URL)
    ?? optionalString(process.env.FIREWORKS_CHAT_COMPLETIONS_URL)
    ?? "https://api.fireworks.ai/inference/v1/chat/completions";
}

async function officeAudioAlignmentsFromChunks(chunks, manifests) {
  const wallClock = officeAudioAlignmentsFromManifests(manifests);
  const decodedByDevice = new Map();
  for (const chunk of chunks) {
    const wav = await readPcm16WavMono(chunk.decryptedAudioPath).catch(() => null);
    if (!wav || wav.samples.length === 0) continue;
    const deviceId = String(chunk.deviceId ?? "mac-local");
    if (!decodedByDevice.has(deviceId)) decodedByDevice.set(deviceId, []);
    decodedByDevice.get(deviceId).push({ chunk, wav, quality: channelQualityProfile(wav.samples) });
  }
  if (decodedByDevice.size < 2) return wallClock;

  const representatives = [...decodedByDevice.entries()]
    .map(([deviceId, decoded]) => ({
      deviceId,
      decoded: decoded[0],
      quality: decoded.reduce((best, item) => item.quality.score > best.score ? item.quality : best, decoded[0].quality),
    }))
    .filter((item) => item.decoded);
  representatives.sort((left, right) => right.quality.score - left.quality.score);
  const referenceRepresentative = representatives[0];
  const referenceDeviceId = referenceRepresentative?.deviceId;
  const referenceDecoded = referenceRepresentative?.decoded;
  if (!referenceDeviceId || !referenceDecoded) return wallClock;

  const alignments = [];
  for (const [deviceId, decodedChunks] of decodedByDevice.entries()) {
    const base = wallClock.find((alignment) => alignment.providerDeviceId === deviceId) ?? {
      providerDeviceId: deviceId,
      offsetMsAtStart: 0,
      driftPpm: null,
      segments: [],
    };
    if (deviceId === referenceDeviceId) {
      alignments.push({
        ...base,
        referenceProviderDeviceId: referenceDeviceId,
        status: "acoustic_reference",
        modelVersion: "office-audio-process-chunks.ad-hoc-array-v2",
        channelQuality: referenceDecoded.quality,
        computedAt: new Date().toISOString(),
      });
      continue;
    }
    const candidateDecoded = decodedChunks[0];
    if (!candidateDecoded) {
      alignments.push(base);
      continue;
    }
    const sampleRate = Math.min(referenceDecoded.wav.sampleRate, candidateDecoded.wav.sampleRate);
    const referenceSamples = referenceDecoded.wav.sampleRate === sampleRate
      ? referenceDecoded.wav.samples
      : resampleLinear(referenceDecoded.wav.samples, referenceDecoded.wav.sampleRate, sampleRate);
    const candidateSamples = candidateDecoded.wav.sampleRate === sampleRate
      ? candidateDecoded.wav.samples
      : resampleLinear(candidateDecoded.wav.samples, candidateDecoded.wav.sampleRate, sampleRate);
    const correlation = estimateAdHocArrayAlignment(referenceSamples, candidateSamples, sampleRate);
    if (!correlation || correlation.confidence < 0.22) {
      alignments.push(base);
      continue;
    }
    const refStart = Date.parse(String(referenceDecoded.chunk.startedAt ?? ""));
    const candidateStart = Date.parse(String(candidateDecoded.chunk.startedAt ?? ""));
    const wallClockOffset = Number.isFinite(refStart) && Number.isFinite(candidateStart) ? candidateStart - refStart : Number(base.offsetMsAtStart ?? 0);
    const offsetMsAtStart = Math.round(wallClockOffset + correlation.offsetMsAtStart);
    alignments.push({
      providerDeviceId: deviceId,
      referenceProviderDeviceId: referenceDeviceId,
      offsetMsAtStart,
      driftPpm: Math.round(correlation.driftPpm),
      segments: correlation.segments.map((segment) => ({
        ...segment,
        offsetMs: Math.round(wallClockOffset + segment.offsetMs),
        confidence: Math.round(segment.confidence * 1000) / 1000,
      })),
      status: "acoustic_aligned",
      modelVersion: "office-audio-process-chunks.ad-hoc-array-v2",
      channelQuality: candidateDecoded.quality,
      computedAt: new Date().toISOString(),
    });
  }
  return alignments;
}

async function officeAudioArrayProductsFromChunks(chunks, alignments, tempDir, config) {
  if (!Array.isArray(chunks) || chunks.length < 2) return [];
  const decoded = [];
  for (const chunk of chunks) {
    const wav = await readPcm16WavMono(chunk.decryptedAudioPath).catch(() => null);
    if (!wav || wav.samples.length === 0) continue;
    decoded.push({ chunk, wav });
  }
  if (decoded.length < 2) return [];

  const sampleRate = Number(config.arraySampleRate ?? decoded[0].wav.sampleRate) || decoded[0].wav.sampleRate;
  const firstStartedAt = decoded
    .map(({ chunk }) => Date.parse(String(chunk.startedAt ?? "")))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => left - right)[0] ?? Date.now();
  const alignmentByDevice = new Map(
    (Array.isArray(alignments) ? alignments : []).map((alignment) => [String(alignment.providerDeviceId), alignment]),
  );
  const sources = decoded.map(({ chunk, wav }) => {
    const deviceId = String(chunk.deviceId ?? "mac-local");
    const startedAt = Date.parse(String(chunk.startedAt ?? ""));
    const alignment = alignmentByDevice.get(deviceId);
    const offsetMs = Number(alignment?.offsetMsAtStart ?? 0);
    const timelineStartMs = (Number.isFinite(startedAt) ? startedAt - firstStartedAt : 0) - offsetMs;
    const samples = wav.sampleRate === sampleRate ? wav.samples : resampleLinear(wav.samples, wav.sampleRate, sampleRate);
    const quality = channelQualityProfile(samples);
    return {
      chunk,
      deviceId,
      samples,
      startFrame: Math.round((timelineStartMs / 1000) * sampleRate),
      weight: quality.weight,
      quality,
      alignment,
    };
  });
  const usable = sources.filter((source) => source.samples.length > 0 && source.weight > 0);
  if (usable.length < 2) return [];

  const minStart = Math.min(...usable.map((source) => source.startFrame));
  const maxEnd = Math.max(...usable.map((source) => source.startFrame + source.samples.length));
  const outputFrames = Math.max(1, maxEnd - minStart);
  const mixed = new Float32Array(outputFrames);
  const weights = new Float32Array(outputFrames);
  const sourceWeights = [];

  for (const source of usable) {
    const start = source.startFrame - minStart;
    const driftPpm = Number(source.alignment?.driftPpm ?? 0);
    sourceWeights.push({
      providerDeviceId: source.deviceId,
      weight: Math.round(source.weight * 1000) / 1000,
      quality: source.quality,
      driftPpm: Number.isFinite(driftPpm) ? Math.round(driftPpm) : 0,
    });
    for (let i = 0; i < source.samples.length; i += 1) {
      const timeMs = (i / sampleRate) * 1000;
      const driftMs = Number.isFinite(driftPpm) ? (driftPpm * timeMs) / 1_000_000 : 0;
      const out = start + i - Math.round((driftMs / 1000) * sampleRate);
      if (out < 0 || out >= outputFrames) continue;
      mixed[out] += source.samples[i] * source.weight;
      weights[out] += source.weight;
    }
  }
  for (let i = 0; i < mixed.length; i += 1) {
    if (weights[i] > 0) mixed[i] /= weights[i];
  }
  normalizeInPlace(mixed, 0.92);

  const productId = `room-array-${safeFileId(config.roomProfileId ?? "room")}-${Date.now().toString(36)}`;
  const productPath = join(tempDir, `${productId}.wav`);
  await writeFile(productPath, encodePcm16WavMono(mixed, sampleRate), { mode: 0o600 });
  const startedAt = new Date(firstStartedAt + Math.round((minStart / sampleRate) * 1000)).toISOString();
  const endedAt = new Date(firstStartedAt + Math.round((maxEnd / sampleRate) * 1000)).toISOString();
  const alignmentConfidences = usable
    .map((source) => Number(source.alignment?.segments?.[0]?.confidence ?? (source.alignment?.status === "acoustic_reference" ? 1 : 0.5)))
    .filter((value) => Number.isFinite(value));
  const alignmentConfidence = alignmentConfidences.length > 0
    ? alignmentConfidences.reduce((sum, value) => sum + value, 0) / alignmentConfidences.length
    : 0.5;
  return [{
    productId,
    kind: "enhanced_room_mix",
    algorithm: "adaptive_ad_hoc_array_fusion_v2",
    role: "asr_primary",
    startedAt,
    endedAt,
    durationMs: Math.round((mixed.length / sampleRate) * 1000),
    sampleRate,
    format: "wav",
    decryptedAudioPath: productPath,
    sourceProviderDeviceIds: [...new Set(usable.map((source) => source.deviceId))],
    primaryProviderDeviceId: null,
    alignmentConfidence: Math.max(0, Math.min(1, alignmentConfidence)),
    sourceWeights,
    enhancementStages: [
      "reference_channel_selection",
      "windowed_gcc_phat_inspired_alignment",
      "sampling_clock_drift_estimation",
      "adaptive_channel_quality_weighting",
      "drift_corrected_delay_sum_fusion",
    ],
    execution: {
      executed: true,
      localProcessor: "office-audio-process-chunks",
      externalFinalizer: false,
    },
    researchBasis: [
      "CHiME distant multi-microphone ASR front ends use dereverberation, beamforming, GSS, and strong ASR backends.",
      "Ad-hoc distributed arrays require acoustic time-delay estimation, channel selection, and clock-drift handling before fusion.",
      "This local stage performs classical alignment/fusion and leaves neural separation or MVDR/GSS to provider-side adapters when configured.",
    ],
    policy: {
      distributedMicrophoneArray: true,
      fusedChannelsBeforeAsr: true,
      preservesDeviceProvenance: true,
      fallbackToSingleDeviceChunksAllowed: true,
    },
  }];
}

function officeAudioArrayEnhancementPlan(chunks, alignments, arrayProducts) {
  const sourceDeviceIds = [...new Set((Array.isArray(chunks) ? chunks : []).map((chunk) => chunk.deviceId).filter(Boolean))];
  return {
    schema: "shepherd_office_audio_array_enhancement_plan.v1",
    sourceDeviceIds,
    baseArrayProducts: Array.isArray(arrayProducts)
      ? arrayProducts.map((product) => ({
          productId: product.productId,
          algorithm: product.algorithm,
          role: product.role,
          executed: product.execution?.executed ?? true,
        }))
      : [],
    requiredBenchmarkProviders: [
      "elevenlabs-scribe-v2",
      "soniox-stt-rt-v5",
      "deepgram-nova-3-or-flux",
      "pyannoteai-precision-2",
    ],
    heavyFinalizerCandidates: [
      {
        stage: "mimo_wpe_dereverberation",
        role: "dereverberation",
        execution: "external_required",
        reason: "WPE needs multichannel STFT dereverberation over aligned sensors; the local Node processor must not fake this stage.",
      },
      {
        stage: "mask_based_mvdr_or_gev_beamforming",
        role: "target_beamforming",
        execution: "external_required",
        reason: "MVDR/GEV needs speech/noise masks and covariance estimation; benchmark only actual enhanced audio outputs.",
      },
      {
        stage: "guided_source_separation",
        role: "speaker_source_separation",
        execution: "external_required",
        reason: "GSS should use diarization/ASR hypotheses to produce separated streams for overlapping speakers.",
      },
      {
        stage: "neural_separation_or_denoising",
        role: "neural_enhancement",
        execution: "external_required",
        reason: "Neural separation requires pinned model weights, device placement, and benchmark evidence before promotion.",
      },
    ],
    alignmentSummary: Array.isArray(alignments)
      ? alignments.map((alignment) => ({
          providerDeviceId: alignment.providerDeviceId,
          referenceProviderDeviceId: alignment.referenceProviderDeviceId ?? null,
          status: alignment.status ?? "unknown",
          offsetMsAtStart: alignment.offsetMsAtStart ?? null,
          driftPpm: alignment.driftPpm ?? null,
          confidence: alignment.segments?.[0]?.confidence ?? null,
        }))
      : [],
    policy: {
      unexecutedHeavyStagesCannotBeAsrPrimary: true,
      compareProviderOnSameArrayProduct: true,
      keepRawAudioTemporary: true,
      benchmarkBeforePromotion: true,
    },
  };
}

async function applyOfficeAudioArrayFinalizer(command, providerInput, tempDir) {
  const result = await runOfficeAudioArrayFinalizerCommand(command, {
    schema: "shepherd_office_audio_array_finalizer_input.v1",
    runId: providerInput.runId,
    sourceSessionId: providerInput.sourceSessionId,
    roomProfileId: providerInput.roomProfileId,
    devices: providerInput.devices,
    chunks: providerInput.chunks,
    alignments: providerInput.alignments,
    baseArrayProducts: providerInput.arrayProducts,
    enhancementPlan: providerInput.enhancementPlan,
    outputDir: tempDir,
    expectedOutput: "Return JSON { arrayProducts: [...] }. Heavy WPE/MVDR/GSS/neural products must include execution.executed=true and a temporary decryptedAudioPath.",
    policy: {
      rawAudioIsTemporary: true,
      doNotReturnTranscriptText: true,
      heavyStagesMustBeActuallyExecuted: true,
      productPathsMustStayInTemporaryOutputDir: true,
    },
  });
  const products = Array.isArray(result?.arrayProducts)
    ? result.arrayProducts
    : Array.isArray(result?.products)
      ? result.products
      : [];
  if (products.length === 0) return providerInput.arrayProducts;
  const normalized = products.map((product) => normalizeOfficeAudioArrayFinalizerProduct(product, tempDir)).filter(Boolean);
  return [...providerInput.arrayProducts, ...normalized];
}

async function runOfficeAudioArrayFinalizerCommand(command, finalizerInput) {
  const child = spawn(command[0], command.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SHEPHERD_OFFICE_AUDIO_ARRAY_FINALIZER_INPUT_SCHEMA: finalizerInput.schema,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.resume();
  child.stdin.end(`${JSON.stringify(finalizerInput)}\n`);
  const exit = await waitForChild(child);
  if (exit.code !== 0) {
    throw new Error(`Office Audio array finalizer failed with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}; stderr redacted`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Office Audio array finalizer did not return JSON; stderr redacted");
  }
}

function normalizeOfficeAudioArrayFinalizerProduct(product, tempDir) {
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new Error("Office Audio array finalizer product must be an object.");
  }
  const productId = safeFileId(optionalString(product.productId) ?? `finalizer-${Date.now().toString(36)}`);
  const algorithm = optionalString(product.algorithm);
  const role = optionalString(product.role);
  const path = optionalString(product.decryptedAudioPath);
  if (!algorithm || !role || !path) {
    throw new Error("Office Audio array finalizer products require productId, algorithm, role, and decryptedAudioPath.");
  }
  const resolvedTemp = realpathSync(tempDir);
  const resolvedProduct = realpathSync(path);
  if (!resolvedProduct.startsWith(`${resolvedTemp}/`)) {
    throw new Error("Office Audio array finalizer product path must stay inside the processor temporary directory.");
  }
  const heavy = /wpe|mvdr|gev|gss|source[_-]?separation|neural/i.test(algorithm)
    || product.enhancementStages?.some?.((stage) => /wpe|mvdr|gev|gss|source[_-]?separation|neural/i.test(String(stage)));
  if (heavy && product.execution?.executed !== true) {
    throw new Error("Heavy Office Audio array products must declare execution.executed=true.");
  }
  if (heavy && role === "asr_primary" && product.benchmarkEvidence?.passed !== true) {
    throw new Error("Heavy Office Audio asr_primary products require benchmarkEvidence.passed=true.");
  }
  return {
    ...product,
    productId,
    algorithm,
    role,
    kind: optionalString(product.kind) ?? "external_array_finalizer_product",
    format: optionalString(product.format) ?? "wav",
    execution: {
      ...(product.execution && typeof product.execution === "object" && !Array.isArray(product.execution) ? product.execution : {}),
      externalFinalizer: true,
    },
    policy: {
      ...(product.policy && typeof product.policy === "object" && !Array.isArray(product.policy) ? product.policy : {}),
      rawAudioIsTemporary: true,
      preservesDeviceProvenance: true,
    },
  };
}

async function wavEnvelope(path) {
  const buffer = await readFile(path);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (dataStart < 0 || sampleRate <= 0 || bitsPerSample !== 16) return null;
  const frameBytes = Math.max(2, channels * 2);
  const windowFrames = Math.max(1, Math.floor(sampleRate * 0.1));
  const values = [];
  let sum = 0;
  let count = 0;
  for (let pos = dataStart; pos + frameBytes <= Math.min(buffer.length, dataStart + dataSize); pos += frameBytes) {
    let mixed = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      mixed += buffer.readInt16LE(pos + (ch * 2)) / 32768;
    }
    mixed /= channels;
    sum += mixed * mixed;
    count += 1;
    if (count >= windowFrames) {
      values.push(Math.sqrt(sum / count));
      sum = 0;
      count = 0;
    }
  }
  if (count > 0) values.push(Math.sqrt(sum / count));
  const mean = values.reduce((acc, value) => acc + value, 0) / Math.max(1, values.length);
  const normalized = values.map((value) => value - mean);
  return {
    values: normalized,
    sampleRate,
    durationMs: Math.round(((dataSize / frameBytes) / sampleRate) * 1000),
    stepMs: 100,
  };
}

async function readPcm16WavMono(path) {
  const buffer = await readFile(path);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      const audioFormat = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
      if (audioFormat !== 1) return null;
    } else if (id === "data") {
      dataStart = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (dataStart < 0 || sampleRate <= 0 || bitsPerSample !== 16 || channels <= 0) return null;
  const frameBytes = channels * 2;
  const frameCount = Math.floor(dataSize / frameBytes);
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const pos = dataStart + (frame * frameBytes);
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      mixed += buffer.readInt16LE(pos + (channel * 2)) / 32768;
    }
    samples[frame] = mixed / channels;
  }
  return { sampleRate, samples };
}

function encodePcm16WavMono(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + (i * 2));
  }
  return buffer;
}

function pcm16BytesFromFloatSamples(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return buffer;
}

function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const source = i * ratio;
    const left = Math.floor(source);
    const right = Math.min(samples.length - 1, left + 1);
    const frac = source - left;
    output[i] = (samples[left] ?? 0) * (1 - frac) + (samples[right] ?? 0) * frac;
  }
  return output;
}

function channelQualityWeight(samples) {
  return channelQualityProfile(samples).weight;
}

function channelQualityProfile(samples) {
  if (!samples.length) {
    return {
      weight: 0,
      score: 0,
      rms: 0,
      dynamicRange: 0,
      clippingRatio: 0,
      speechPresence: 0,
    };
  }
  const abs = [];
  let energy = 0;
  let zeroCrossings = 0;
  let clipped = 0;
  let previous = 0;
  for (const sample of samples) {
    const value = Math.abs(sample);
    abs.push(value);
    energy += sample * sample;
    if (value >= 0.98) clipped += 1;
    if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) zeroCrossings += 1;
    previous = sample;
  }
  abs.sort((left, right) => left - right);
  const floor = abs[Math.floor(abs.length * 0.1)] ?? 0;
  const median = abs[Math.floor(abs.length * 0.5)] ?? 0;
  const peak = abs[Math.floor(abs.length * 0.95)] ?? 0;
  const rms = Math.sqrt(energy / samples.length);
  const dynamicRange = peak / Math.max(0.001, floor);
  const speechPresence = Math.max(0, Math.min(1, (peak - median) / Math.max(0.01, peak)));
  const clippingRatio = clipped / samples.length;
  const unclipped = clippingRatio < 0.001 ? 1 : clippingRatio < 0.01 ? 0.7 : 0.4;
  const zeroCrossingRate = zeroCrossings / samples.length;
  const tonalPenalty = zeroCrossingRate < 0.005 || zeroCrossingRate > 0.35 ? 0.75 : 1;
  const score = Math.max(0, rms * Math.log2(2 + dynamicRange) * speechPresence * unclipped * tonalPenalty);
  return {
    weight: Math.max(0.05, Math.min(1.8, score)),
    score: Math.round(score * 1000) / 1000,
    rms: Math.round(rms * 1000) / 1000,
    dynamicRange: Math.round(dynamicRange * 1000) / 1000,
    clippingRatio: Math.round(clippingRatio * 10000) / 10000,
    speechPresence: Math.round(speechPresence * 1000) / 1000,
  };
}

function normalizeInPlace(samples, targetPeak) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak <= 0 || peak <= targetPeak) return;
  const scale = targetPeak / peak;
  for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
}

function correlateEnvelopes(reference, candidate) {
  const a = reference.values;
  const b = candidate.values;
  if (a.length < 8 || b.length < 8) return null;
  const maxLag = Math.min(50, Math.max(a.length, b.length) - 4);
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let aa = 0;
    let bb = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += 1) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      dot += a[i] * b[j];
      aa += a[i] * a[i];
      bb += b[j] * b[j];
      n += 1;
    }
    if (n < 8 || aa <= 0 || bb <= 0) continue;
    const score = dot / Math.sqrt(aa * bb);
    if (score > best.score) best = { lag, score };
  }
  if (!Number.isFinite(best.score)) return null;
  return {
    offsetMs: best.lag * reference.stepMs,
    confidence: Math.max(0, Math.min(1, best.score)),
  };
}

function estimateAdHocArrayAlignment(referenceSamples, candidateSamples, sampleRate) {
  if (referenceSamples.length < sampleRate * 0.25 || candidateSamples.length < sampleRate * 0.25) return null;
  const featureRate = Math.min(2000, sampleRate);
  const reference = alignmentFeatureSeries(referenceSamples, sampleRate, featureRate);
  const candidate = alignmentFeatureSeries(candidateSamples, sampleRate, featureRate);
  if (reference.length < featureRate * 0.25 || candidate.length < featureRate * 0.25) return null;

  const overlap = Math.min(reference.length, candidate.length);
  const windowFrames = Math.max(Math.floor(featureRate * 0.75), Math.min(overlap, Math.floor(featureRate * 1.5)));
  const starts = uniqueSorted([
    0,
    Math.max(0, Math.floor((overlap - windowFrames) / 2)),
    Math.max(0, overlap - windowFrames),
  ]);
  const maxLagFrames = Math.max(1, Math.floor(featureRate * 0.75));
  const rawSegments = [];
  for (const start of starts) {
    if (start + windowFrames > reference.length || start + windowFrames > candidate.length) continue;
    const result = correlateWindow(reference, candidate, start, windowFrames, maxLagFrames);
    if (!result || result.confidence < 0.18) continue;
    rawSegments.push({
      startMs: Math.round((start / featureRate) * 1000),
      endMs: Math.round(((start + windowFrames) / featureRate) * 1000),
      centerMs: ((start + (windowFrames / 2)) / featureRate) * 1000,
      offsetMs: (result.lag / featureRate) * 1000,
      confidence: result.confidence,
      method: "windowed_whitened_cross_correlation",
    });
  }
  if (rawSegments.length === 0) return null;
  const confident = rawSegments.filter((segment) => segment.confidence >= 0.22);
  const segments = confident.length > 0 ? confident : rawSegments;
  const weighted = weightedLineFit(
    segments.map((segment) => ({
      x: segment.centerMs,
      y: segment.offsetMs,
      weight: Math.max(0.05, segment.confidence),
    })),
  );
  const offsetMsAtStart = weighted ? weighted.intercept : weightedMean(segments.map((segment) => ({ value: segment.offsetMs, weight: segment.confidence })));
  const driftPpm = weighted ? weighted.slope * 1_000_000 : 0;
  const confidence = weightedMean(segments.map((segment) => ({ value: segment.confidence, weight: segment.confidence })));
  return {
    offsetMsAtStart,
    driftPpm: Number.isFinite(driftPpm) ? driftPpm : 0,
    confidence,
    segments: segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      offsetMs: segment.offsetMs,
      confidence: segment.confidence,
      method: segment.method,
    })),
  };
}

function alignmentFeatureSeries(samples, sampleRate, featureRate) {
  const step = Math.max(1, Math.floor(sampleRate / featureRate));
  const features = new Float32Array(Math.max(1, Math.floor(samples.length / step)));
  let previous = 0;
  for (let i = 0; i < features.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < step; j += 1) {
      const sample = samples[(i * step) + j] ?? 0;
      const highPassed = sample - (0.97 * previous);
      previous = sample;
      sum += Math.sign(highPassed) * Math.sqrt(Math.abs(highPassed));
    }
    features[i] = sum / step;
  }
  normalizeFeatureSeries(features);
  return features;
}

function normalizeFeatureSeries(values) {
  let mean = 0;
  for (const value of values) mean += value;
  mean /= Math.max(1, values.length);
  let variance = 0;
  for (const value of values) variance += (value - mean) * (value - mean);
  const stddev = Math.sqrt(variance / Math.max(1, values.length)) || 1;
  for (let i = 0; i < values.length; i += 1) values[i] = (values[i] - mean) / stddev;
}

function correlateWindow(reference, candidate, start, length, maxLag) {
  let best = { lag: 0, score: -Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let aa = 0;
    let bb = 0;
    let n = 0;
    for (let i = 0; i < length; i += 1) {
      const ai = start + i;
      const bi = start + i + lag;
      if (ai < 0 || ai >= reference.length || bi < 0 || bi >= candidate.length) continue;
      const a = reference[ai];
      const b = candidate[bi];
      dot += a * b;
      aa += a * a;
      bb += b * b;
      n += 1;
    }
    if (n < Math.max(32, length * 0.35) || aa <= 0 || bb <= 0) continue;
    const score = dot / Math.sqrt(aa * bb);
    if (score > best.score) best = { lag, score };
  }
  if (!Number.isFinite(best.score)) return null;
  return {
    lag: best.lag,
    confidence: Math.max(0, Math.min(1, best.score)),
  };
}

function weightedLineFit(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    const weight = Number(point.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    sw += weight;
    sx += weight * point.x;
    sy += weight * point.y;
    sxx += weight * point.x * point.x;
    sxy += weight * point.x * point.y;
  }
  const denominator = (sw * sxx) - (sx * sx);
  if (sw <= 0 || Math.abs(denominator) < 1e-9) return null;
  const slope = ((sw * sxy) - (sx * sy)) / denominator;
  const intercept = (sy - (slope * sx)) / sw;
  return { slope, intercept };
}

function weightedMean(values) {
  let total = 0;
  let weightTotal = 0;
  for (const item of values) {
    const weight = Number(item.weight);
    const value = Number(item.value);
    if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(value)) continue;
    total += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? total / weightTotal : 0;
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => Math.max(0, Math.floor(value))))].sort((left, right) => left - right);
}

function officeAudioAlignmentsFromManifests(manifests) {
  const firstByDevice = new Map();
  for (const manifest of manifests) {
    const deviceId = String(manifest.deviceId ?? "mac-local");
    if (!firstByDevice.has(deviceId)) firstByDevice.set(deviceId, manifest);
  }
  const firstStart = [...firstByDevice.values()]
    .map((manifest) => Date.parse(String(manifest.startedAt ?? "")))
    .filter((time) => Number.isFinite(time))
    .sort((left, right) => left - right)[0] ?? Date.now();
  return [...firstByDevice.entries()].map(([deviceId, manifest]) => {
    const start = Date.parse(String(manifest.startedAt ?? ""));
    return {
      providerDeviceId: deviceId,
      offsetMsAtStart: Number.isFinite(start) ? start - firstStart : 0,
      driftPpm: null,
      segments: [],
      status: "wall_clock_initial",
      modelVersion: "office-audio-process-chunks.wall-clock-v1",
      computedAt: new Date().toISOString(),
    };
  });
}

async function markOfficeAudioChunkProcessed(manifestPath, outputPath) {
  const parsed = readJsonOptional(manifestPath);
  if (!parsed || typeof parsed !== "object") return;
  await writeFile(manifestPath, `${JSON.stringify({
    ...parsed,
    transcriptStatus: "spooled",
    transcriptSpoolPath: outputPath,
    transcriptSpooledAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

async function markOfficeAudioChunkIdentityAudited(manifestPath, outputPath) {
  const parsed = readJsonOptional(manifestPath);
  if (!parsed || typeof parsed !== "object") return;
  await writeFile(manifestPath, `${JSON.stringify({
    ...parsed,
    transcriptStatus: parsed.transcriptStatus ?? "pending_provider_transcription",
    identityAuditStatus: "audited",
    identityAuditSpoolPath: outputPath,
    identityAuditedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}

function officeAudioControlFile(userId, channel = STABLE_CHANNEL) {
  const path = join(homedir(), ".shepherd", "office-audio", `${channelFilePrefix(channel)}${safeFileId(userId)}-control.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

async function runOfficeAudioStatus() {
  const configPath = stringArg("config") ?? await latestOfficeAudioConfigPath();
  if (!configPath) {
    const result = { configured: false };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log("Office Audio is not configured on this Mac.");
    return;
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const channel = cliChannel(config.channel);
  const safeId = safeFileId(requiredConfigString(config.userId, "userId"));
  const statusPath = join(homedir(), ".shepherd", "office-audio", `${channelFilePrefix(channel)}${safeId}-status.json`);
  let status = null;
  try {
    status = JSON.parse(await readFile(statusPath, "utf8"));
  } catch {
    status = null;
  }
  const result = {
    configured: true,
    configPath,
    statusPath,
    roomProfileId: config.roomProfileId ?? null,
    deviceId: config.deviceId ?? null,
    inputDeviceUid: config.inputDeviceUid ?? null,
    captureMode: config.captureMode ?? (config.collectorCommand ? "external_command" : "transcript_spool"),
    spoolDir: config.spoolDir ?? null,
    chunkDir: config.chunkDir ?? null,
    speakerProfilesDir: config.speakerProfilesDir ?? null,
    collectorConfigured: Array.isArray(config.collectorCommand) && config.collectorCommand.length > 0,
    transcriptionBackend: officeAudioConfiguredTranscriptionBackend(config),
    processorConfigured: officeAudioConfiguredTranscriptionBackend(config) !== "external_provider_command"
      || (Array.isArray(config.processorCommand) && config.processorCommand.length > 0),
    speakerProfileSyncEnabled: config.syncSpeakerProfiles !== false,
    lastStatus: status,
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Office Audio config: ${configPath}`);
    console.log(`Device: ${result.deviceId ?? "default"}`);
    console.log(`Capture: ${result.captureMode}`);
    console.log(`Spool: ${result.spoolDir}`);
    if (result.chunkDir) console.log(`Chunks: ${result.chunkDir}`);
    console.log(`Collector: ${result.collectorConfigured ? "external command" : result.captureMode}`);
    console.log(`Processor: ${result.transcriptionBackend}${result.processorConfigured ? "" : " (not configured)"}`);
    console.log(`Last status: ${status ? JSON.stringify(status) : "none"}`);
  }
}

async function officeAudioSpoolFiles(spoolDir) {
  let entries;
  try {
    entries = await readdir(spoolDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(spoolDir, entry.name))
    .sort()
    .slice(0, MAX_BATCH_SIZE);
}

async function renameFile(from, to) {
  try {
    await rename(from, to);
  } catch {
    await writeFile(to, await readFile(from));
    unlinkSync(from);
  }
}

async function latestOfficeAudioConfigPath() {
  const dir = join(homedir(), ".shepherd", "office-audio");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".json") && !/-(?:state|status|queue)\.json$/.test(e.name))) {
    const configPath = join(dir, entry.name);
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      if (!parsed?.userId || !parsed?.agentToken) continue;
      if (normalizeLaunchAgentChannel(parsed?.channel) !== cliChannel()) continue;
      const fileStat = await stat(configPath);
      candidates.push({ configPath, mtimeMs: fileStat.mtimeMs });
    } catch {
      // Skip unreadable or non-config files.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.configPath ?? null;
}

async function collectMessagesLocalStatus(preferredUserId = null) {
  const configPath = await messagesConfigPathForUser(preferredUserId) ?? await latestMessagesConfigPath();
  const config = configPath ? readJsonOptional(configPath) : null;
  const channel = cliChannel(config?.channel);
  const userId = config?.userId ?? preferredUserId ?? null;
  const safeId = userId ? safeFileId(userId) : null;
  const label = safeId ? `ai.shepherd.${channelLabelPrefix(channel)}raw-messages.${safeId}` : null;
  const queue = safeId ? readJsonOptional(join(homedir(), ".shepherd", "raw-messages", `${channelFilePrefix(channel)}${safeId}-queue.json`)) : null;

  return {
    configPath: configPath ?? null,
    userId,
    allChats: config?.allChats === true,
    selectedChatCount: Array.isArray(config?.allowedChatIds) ? config.allowedChatIds.length : 0,
    storage: await probePath("messages", MESSAGES_CHAT_DB_PATH),
    contacts: userId ? readJsonOptional(messagesContactStatusFile(userId, channel)) : null,
    backfillProgress: userId ? publicMessagesBackfillStatus(readJsonOptional(messagesBackfillStatusFile(userId, channel))) : null,
    launch: localLaunchStatus(label),
    queueDepth: Array.isArray(queue) ? queue.length : 0,
  };
}

async function collectCodingSessionsLocalStatus(preferredUserId = null, explicitConfigPath = null) {
  const configPath = explicitConfigPath ?? await codingSessionsConfigPathForUser(preferredUserId) ?? await latestCodingSessionsConfigPath();
  const config = configPath ? readJsonOptional(configPath) : null;
  const channel = cliChannel(config?.channel);
  const userId = config?.userId ?? preferredUserId ?? null;
  const safeId = userId ? safeFileId(userId) : null;
  const label = safeId ? `ai.shepherd.${channelLabelPrefix(channel)}coding-sessions.${safeId}` : null;
  const queue = safeId ? readJsonOptional(join(homedir(), ".shepherd", "coding-sessions", `${channelFilePrefix(channel)}${safeId}-queue.json`)) : null;

  return {
    configPath: configPath ?? null,
    userId,
    localFolders: await probeCodingSessionPaths(config ?? {}),
    launch: localLaunchStatus(label),
    lastSync: userId ? readJsonOptional(codingSessionsStatusFile(userId, channel)) : null,
    queueDepth: Array.isArray(queue) ? queue.length : 0,
  };
}

function localLaunchStatus(label) {
  if (!label || platform() !== "darwin") return null;
  const state = readLaunchctlPrint(`gui/${process.getuid?.() ?? 501}/${label}`);
  return {
    label,
    running: /state = running|job state = running/i.test(state),
    state,
  };
}

async function runCodingSessionsStatus() {
  const configPath = stringArg("config") ?? await latestCodingSessionsConfigPath();
  const status = await collectCodingSessionsLocalStatus(null, configPath);
  const config = configPath ? readJsonOptional(configPath) : null;
  const production = await productionOnboardingStatusForCodingSessions(config).catch((err) => ({ error: safeError(err) }));
  const detailedStatus = {
    ...status,
    production,
  };

  if (args.json) {
    console.log(JSON.stringify(detailedStatus, null, 2));
    return;
  }

  console.log("\nShepherd coding-session sync status\n");
  console.log(`Config: ${detailedStatus.configPath ?? "not found"}`);
  if (detailedStatus.userId) console.log(`User: ${detailedStatus.userId}`);
  for (const probe of detailedStatus.localFolders) {
    console.log(`- ${probe.provider}: ${probe.path} ${probe.readable ? "readable" : `not readable (${probe.reason})`}`);
  }
  if (detailedStatus.launch) {
    console.log(`LaunchAgent: ${detailedStatus.launch.label} ${detailedStatus.launch.running ? "running" : "not running or unknown"}`);
  } else {
    console.log("LaunchAgent: not installed or unavailable");
  }
  if (detailedStatus.lastSync) {
    console.log(`Last sync: ${detailedStatus.lastSync.finishedAt ?? "unknown"} (${detailedStatus.lastSync.scanned ?? 0} scanned, ${detailedStatus.lastSync.changed ?? 0} changed)`);
  } else {
    console.log("Last sync: none recorded");
  }
  console.log(`Queued unsent sessions: ${detailedStatus.queueDepth}`);
  if (production?.providers?.codingSessions) {
    console.log(`Production provider: ${production.providers.codingSessions.connected ? "connected" : "not connected"}`);
  } else if (production?.error) {
    console.log(`Production provider: unavailable (${production.error})`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function printHelp(which) {
  if (which === "agent") {
    console.log(`Shepherd coding-agent setup

Usage:
  npx -y ${PACKAGE_NAME}@latest agent
  npx -y ${PACKAGE_NAME}@latest agent --login
  npx -y ${PACKAGE_NAME}@latest agent --name <name> --org <organization>
  npx -y ${PACKAGE_NAME}@latest agent --continue --granola-api-key <key> --messages-handle <value[,value]> --messages-chat-ids <ids|all>
  npx -y ${PACKAGE_NAME}@latest agent --add-sources coding-sessions --name <name> --org <organization>
  npx -y ${PACKAGE_NAME}@latest agent --status
  npx -y ${PACKAGE_NAME}@latest status
  npx -y ${PACKAGE_NAME}@latest coding-sessions-status
  npx -y ${PACKAGE_NAME}@latest messages-chats
  npx -y ${PACKAGE_NAME}@latest granola-api-keys

The bare agent command is intended for coding-agent shells. For direct terminal setup, run:
  npx -y ${PACKAGE_NAME}@latest
`);
    return;
  }

  if (which === "status" || which === "sync-status" || which === "check") {
    console.log(`Shepherd sync status

Usage:
  npx -y ${PACKAGE_NAME}@latest status
  npx -y ${PACKAGE_NAME}@latest status --json

Shows the saved Shepherd account, connected cloud sources, production processing
state, and local background sync health for Messages and Coding Sessions.

Aliases:
  sync-status
  check

Options:
  --json                     Print machine-readable status.
  --state <path>             Local onboarding state file. Defaults to ~/.shepherd/raw-onboarding-agent.json.
  --help                     Show this help.
`);
    return;
  }

  if (which === "coding-sessions-agent") {
    console.log(`Shepherd coding-session sync agent

Usage:
  shepherd-onboard coding-sessions-agent --config ~/.shepherd/coding-sessions/<id>.json

Options:
  --config <path>            Coding-session agent config created by onboarding.
  --once                     Run one scan and exit.
  --interval-seconds <n>     Poll interval for live sync. Defaults to config or 60.
  --debug                    Print extra collector details.
  --help                     Show this help.
`);
    return;
  }

  if (which === "coding-sessions-status") {
    console.log(`Shepherd coding-session sync status

Usage:
  npx -y ${PACKAGE_NAME}@latest coding-sessions-status
  npx -y ${PACKAGE_NAME}@latest coding-sessions-status --json

Shows whether local Codex and Claude Code session folders are readable, whether
the background LaunchAgent is installed/running, and the last local sync result.

Options:
  --config <path>            Config path. Defaults to the latest file in ~/.shepherd/coding-sessions.
  --json                     Print machine-readable status.
  --help                     Show this help.
`);
    return;
  }

  if (which === "office-audio-agent") {
    console.log(`Shepherd Office Audio sync agent

Usage:
  shepherd-onboard office-audio-agent --config ~/.shepherd/office-audio/<id>.json

Options:
  --config <path>            Office Audio agent config created by onboarding.
  --once                     Run one spool scan and exit.
  --interval-seconds <n>     Poll interval for transcript spool sync/status. Defaults to config or 30.
  --help                     Show this help.

When captureMode is macos_afrecord, this agent records short microphone chunks
with /usr/bin/afrecord, encrypts them locally, and writes raw chunk manifests.
Canonical transcript JSON still comes from the configured ASR/diarization path.
`);
    return;
  }

  if (which === "office-audio-enroll-voice") {
    console.log(`Shepherd Office Audio voice enrollment

Usage:
  shepherd-onboard office-audio-enroll-voice --config ~/.shepherd/office-audio/<id>.json --speaker-id <person-id> --display-name "Ada"

Options:
  --config <path>             Office Audio config with localAudioKey and agent token.
  --speaker-id <id>           Person-scoped speaker id. Defaults to the Shepherd user id.
  --display-name <name>       Human label to use only after provider identity evidence.
  --seconds <n>               Recording duration for macOS afrecord. Defaults to 20.
  --audio-path <path>         Use an existing WAV file instead of recording. Intended for tests/imports.
  --provider-command <json>   Optional enrollment adapter command. Defaults to config.enrollmentProviderCommand or processorCommand.
  --help                      Show this help.

Enrollment encrypts the clip locally, stores a speaker profile manifest, and
syncs only consent/profile metadata plus provider speaker identifiers to the
Office Audio backend. With the default pyannote_full backend, this command
creates a pyannoteAI voiceprint from the temporary clip and stores only the
returned provider identifier in the profile.
`);
    return;
  }

  if (which === "office-audio-provider-speechmatics") {
    console.log(`Shepherd Office Audio Speechmatics provider adapter

Usage:
  shepherd-onboard office-audio-provider-speechmatics < provider-input.json

Environment:
  SPEECHMATICS_API_KEY        Required Speechmatics API key.

The adapter accepts shepherd_office_audio_provider_input.v1 and
shepherd_office_audio_enrollment_input.v1 JSON on stdin. It uses Speechmatics
realtime diarization/speaker-identification, returns canonical
OfficeAudioSession JSON for transcripts, and returns provider speaker
identifiers for enrollment.
`);
    return;
  }

  if ([
    "office-audio-provider-elevenlabs",
    "office-audio-provider-soniox",
    "office-audio-provider-deepgram",
    "office-audio-provider-pyannoteai",
  ].includes(which)) {
    console.log(`Shepherd Office Audio provider adapter

Usage:
  shepherd-onboard ${which} < provider-input.json

Environment:
  ELEVENLABS_API_KEY / SHEPHERD_ELEVENLABS_API_KEY       Required for office-audio-provider-elevenlabs.
  SONIOX_API_KEY / SHEPHERD_SONIOX_API_KEY               Required for office-audio-provider-soniox.
  DEEPGRAM_API_KEY / SHEPHERD_DEEPGRAM_API_KEY           Required for office-audio-provider-deepgram.
  PYANNOTEAI_API_KEY / SHEPHERD_PYANNOTEAI_API_KEY       Required for office-audio-provider-pyannoteai.

These adapters accept shepherd_office_audio_provider_input.v1 JSON on stdin
and prefer executed asr_primary arrayProducts over individual chunks. Generic
diarization labels are kept anonymous. Person names require enrolled provider
speaker identifiers or voiceprint evidence; device ownership is never identity.

pyannoteAI accepts enrollment input for voiceprint creation and provider input
for signed-URL identify/diarization audit output. Local chunk upload is only
performed by the built-in office-audio-process-chunks backends.
`);
    return;
  }

  if (which === "office-audio-process-chunks") {
    console.log(`Shepherd Office Audio chunk processor

Usage:
  shepherd-onboard office-audio-process-chunks --config ~/.shepherd/office-audio/<id>.json

Options:
  --config <path>             Office Audio config with localAudioKey, chunkDir, and spoolDir.
  --transcription-backend <name>
                              pyannote_full (default), elevenlabs_pyannote, or external_provider_command.
  --provider-command <json>   JSON array command for external_provider_command. Receives provider-input JSON on stdin and returns OfficeAudioSession JSON on stdout.
  --array-finalizer-command <json>
                              Optional JSON array command. Receives aligned chunks/base arrayProducts and may return executed WPE/MVDR/GSS/neural products.
  --chunk-dir <path>          Override encrypted raw chunk manifest directory.
  --spool-dir <path>          Override canonical transcript spool directory.
  --limit <n>                 Max raw chunk manifests to process in one run. Defaults to 24.
  --help                      Show this help.

The processor decrypts chunks into a temporary directory, runs pyannoteAI STT
orchestration plus identify by default, GPT-OSS merges the final transcript,
writes canonical OfficeAudioSession JSON to spoolDir, marks manifests as
spooled, and deletes temporary plaintext audio. Set
SHEPHERD_OFFICE_AUDIO_TRANSCRIPTION_BACKEND=elevenlabs_pyannote to use
ElevenLabs Scribe v2 for STT with pyannoteAI identify, or use
external_provider_command to preserve a custom adapter. Heavy array products
must be real outputs from the optional finalizer command and must include
benchmark evidence before they can become asr_primary.
`);
    return;
  }

  if (which === "office-audio-status") {
    console.log(`Shepherd Office Audio local sync status

Usage:
  npx -y ${PACKAGE_NAME}@latest office-audio-status
  npx -y ${PACKAGE_NAME}@latest office-audio-status --json

Shows whether the local Office Audio LaunchAgent is configured and the latest
transcript-spool ingestion result.

Options:
  --config <path>            Config path. Defaults to latest file in ~/.shepherd/office-audio.
  --json                     Print machine-readable status.
  --help                     Show this help.
`);
    return;
  }

  if (which === "messages-agent") {
    console.log(`Shepherd Messages raw sync agent

Usage:
  shepherd-onboard messages-agent --config ~/.shepherd/raw-messages/<id>.json

Options:
  --config <path>            Messages agent config created by onboarding.
  --backfill-days <days>     Backfill window before live watch. Defaults to all selected chat history; pass a number to bound it.
  --debug                    Enable iMessage kit debug logs.
  --help                     Show this help.

Environment:
${MESSAGES_UPLOAD_ENV_HELP}
`);
    return;
  }

  if (which === "messages-chats") {
    console.log(`Shepherd Messages recent chat selector

Usage:
  npx -y ${PACKAGE_NAME}@latest messages-chats
  npx -y ${PACKAGE_NAME}@latest messages-chats --json

macOS permission:
  Local Messages sync needs Full Disk Access for the app running onboarding and Node.js.
  This command validates access to ~/Library/Messages/chat.db, opens Full Disk Access settings if access is missing,
  and keeps checking until access works unless --no-permission-prompt is passed.

Options:
  --limit <n>                Number of recent chats to load for search. Defaults to ${DEFAULT_MESSAGE_CHAT_SEARCH_LIMIT}.
  --search <query>           Return chats matching a contact, group, handle, or local Contacts name.
  --messages-chat-ids all    Supported on agent --continue to watch every current and future Messages chat.
  --text                     Print a terminal list instead of opening the selector page.
  --no-open                  Print the local selector URL instead of opening it.
  --no-permission-prompt     Print macOS permission instructions without waiting for confirmation.
  --json                     Print machine-readable chat IDs and labels.
  --help                     Show this help.
`);
    return;
  }

  if (which === "mcp-login") {
    console.log(`Shepherd MCP login

Usage:
  npx -y ${PACKAGE_NAME}@latest mcp-login
  npx -y ${PACKAGE_NAME}@latest mcp-login --json

By default this reuses the saved local onboarding session at ~/.shepherd/raw-onboarding-agent.json.
If local onboarding auth is unavailable, it falls back to Shepherd WorkOS browser login.

Options:
  --api <url>                Advanced: Shepherd API URL.
  --env <environment>        Advanced: MCP environment for askshepherd.ai accounts. Use deploy, canary, or customer-facing.
  --state <path>             Token state file. Defaults to ~/.shepherd/mcp.json.
  --onboarding-state <path>  Local onboarding state file. Defaults to ~/.shepherd/raw-onboarding-agent.json.
  --mcp-program <json_array> Advanced: MCP proxy command prefix. The app uses this to install app-binary-backed MCP instead of npm.
  --no-local                 Skip local onboarding auth and use WorkOS browser login.
  --install <targets>        Install MCP after login. Use all, none, codex, claude, or comma-separated targets.
  --no-install               Save the MCP token without installing client config.
  --no-open                  Print auth URLs instead of opening the browser.
  --json                     Print machine-readable endpoint and token details.
  --help                     Show this help.
`);
    return;
  }

  if (which === "mcp-install") {
    console.log(`Shepherd MCP client install

Usage:
  npx -y ${PACKAGE_NAME}@latest mcp-install
  npx -y ${PACKAGE_NAME}@latest mcp-install --install codex,claude

If ~/.shepherd/mcp.json is missing or near expiry, this first refreshes MCP auth
from the saved local onboarding session before writing client config.

Installs the saved Shepherd MCP login into:
  - Codex CLI/app via codex mcp add
  - Claude Code via claude mcp add --scope user

Options:
  --state <path>             Token state file. Defaults to ~/.shepherd/mcp.json.
  --onboarding-state <path>  Local onboarding state file. Defaults to ~/.shepherd/raw-onboarding-agent.json.
  --mcp-program <json_array> Advanced: MCP proxy command prefix. The app uses this to install app-binary-backed MCP instead of npm.
  --no-local                 Skip local onboarding auth refresh.
  --install <targets>        Use all, none, codex, claude, or comma-separated targets.
  --no-install               Skip client config writes.
  --json                     Print machine-readable install results.
  --help                     Show this help.
`);
    return;
  }

  if (which === "write-agent-state" || which === "write-messages-config" || which === "install-messages-agent" || which === "write-coding-sessions-config" || which === "install-coding-sessions-agent" || which === "write-office-audio-config" || which === "install-office-audio-agent") {
    console.log(`Shepherd onboarding engine commands

These non-interactive commands are used by GUI onboarding apps (for example the
Shepherd macOS app) so that this CLI stays the single owner of Shepherd state
file schemas and the launchd install flow.

Usage:
  shepherd-onboard write-agent-state            JSON object on stdin is merged into ~/.shepherd/raw-onboarding-agent.json. Prints {statePath}.
  shepherd-onboard write-messages-config        JSON object on stdin ({apiUrl, userId, agentToken, backfillDays?, allowedChatIds, selectedChats?}) is written to ~/.shepherd/raw-messages/<userId>.json. Prints {configPath}.
  shepherd-onboard install-messages-agent --config <path>
                                                Installs and verifies the Messages launchd agent for an existing config. Prints install metadata.
  shepherd-onboard write-coding-sessions-config JSON object on stdin ({apiUrl, userId, agentToken, intervalSeconds?}) is written to ~/.shepherd/coding-sessions/<userId>.json. Prints {configPath}.
  shepherd-onboard install-coding-sessions-agent --config <path>
                                                Installs and verifies the Coding Sessions launchd agent for an existing config. Prints install metadata.
  shepherd-onboard write-office-audio-config    JSON object on stdin ({apiUrl, userId, agentToken, intervalSeconds?, spoolDir?, chunkDir?, captureMode?, chunkSeconds?, collectorCommand?, transcriptionBackend?, processorCommand?}) is written to ~/.shepherd/office-audio/<userId>.json. Prints {configPath}.
  shepherd-onboard install-office-audio-agent --config <path>
                                                Installs and verifies the Office Audio launchd agent for an existing config. Prints install metadata.
  shepherd-onboard office-audio-enroll-voice --config <path>
                                                Records/encrypts a consented voice enrollment sample and stores speaker identifiers when a provider command is configured.
  shepherd-onboard office-audio-provider-speechmatics
                                                Provider adapter for Speechmatics realtime diarization and speaker identifiers. Reads provider JSON on stdin.

install agent options:
  --config <path>            Agent config created by onboarding. Required.
  --user-id <id>             Override the user ID. Defaults to the config's userId.
  --program <json_array>     Replace the default npx launcher with custom ProgramArguments (e.g. a signed app binary). --config <path> is appended.
  --env <json_object>        Extra EnvironmentVariables merged into the launchd plist (e.g. ELECTRON_RUN_AS_NODE).
  --dry-run                  Print the launchd plist and paths without writing or loading anything.
  --no-permission-prompt     Fail instead of prompting when Full Disk Access is missing.
  --help                     Show this help.
`);
    return;
  }

  if (which === "mcp") {
    console.log(`Shepherd MCP stdio proxy

Usage:
  npx -y ${PACKAGE_NAME}@latest mcp

This command is installed into MCP clients. It reads ~/.shepherd/mcp.json and
proxies stdio MCP traffic to the authenticated production Shepherd MCP endpoint.
It also exposes local npm-backed setup/status tools such as shepherd_status and
shepherd_setup_coding_sessions so agents can answer what is enabled locally and
guide coding-session setup.

Options:
  --state <path>             Token state file. Defaults to ~/.shepherd/mcp.json.
  --url <url>                Override the MCP endpoint.
  --help                     Show this help.
`);
    return;
  }

  console.log(`Shepherd raw sync onboarding

Usage:
  npx -y ${PACKAGE_NAME}@latest
  npx -y ${PACKAGE_NAME}@latest agent
  npx -y ${PACKAGE_NAME}@latest status
  npx -y ${PACKAGE_NAME}@latest mcp-login
  npx -y ${PACKAGE_NAME}@latest mcp-install
  npx -y ${PACKAGE_NAME}@latest messages-chats
  npx -y ${PACKAGE_NAME}@latest coding-sessions-status
  npx -y ${PACKAGE_NAME}@latest granola-api-keys

Options:
  --email <email>            Advanced: must match the WorkOS-authenticated email.
  --name <name>              Full name.
  --org <name>               Organization name.
  --github-token <token>     GitHub PAT for repository API and webhook setup.
  --github-repo <owner/repo> GitHub repository to sync with webhook coverage.
  --granola-api-key <key>    Legacy Granola API key fallback.
  --messages-handle <value>  Messages phone number or Apple ID email; comma-separate both if needed.
  --messages-chat-ids <ids>  Comma-separated local Messages chat IDs selected from messages-chats, or all to watch every current and future chat.
  --messages-backfill-days <days>
                             Local Messages source backfill window. Defaults to all selected chat history; pass a number to bound it.
  --no-google                Skip Google Workspace (Gmail/Drive/Docs/Calendar/Sheets/Slides/Tasks/Contacts).
  --no-notion                Skip Notion.
  --no-slack                 Skip Slack.
  --no-granola               Skip Granola.
  --no-open-granola          Do not open Granola OAuth/API key setup.
  --no-messages              Skip local Messages.
  --coding-sessions          Opt in to local Codex/Claude Code session metadata sync.
  --sources <list>           Exact sources to connect: google,notion,slack,github,granola,messages,coding-sessions,all.
  --add-sources <list>       Same as --sources, named for second-time onboarding.
  --no-install-messages-agent
                             Save Messages credentials without starting launchd.
  --no-install-coding-sessions-agent
                             Save coding-session credentials without starting launchd.
  --no-open                  Print auth URLs instead of opening the browser.
  --no-permission-prompt     Print macOS permission instructions without waiting for confirmation.
  --api <url>                Advanced: Shepherd API URL.
  --help                     Show this help.

Messages agent environment:
${MESSAGES_UPLOAD_ENV_HELP}
`);
}

function shouldPrintAgentContract() {
  return Boolean(args.prompt || args.json || !isInteractiveTerminal());
}

function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printAgentTerminalHandoff() {
  console.log(`Shepherd raw sync setup

This command is meant for coding-agent shells. To set up Shepherd directly in this terminal, run:
  ${agentCommand()}

If a coding agent asked you to onboard Shepherd, ask the agent to run:
  ${agentCommand()} agent

No source setup has started.`);
}

function printAgentContract() {
  const command = agentCommand();
  const payload = {
    task: "Complete Shepherd production raw-source onboarding for this user with the public customer setup flow.",
    instruction: "Use this as a public onboarding checklist. Confirm required onboarding choices and fields directly with the user instead of assuming them from local repo context, shell identity, machine paths, or earlier conversations.",
    commonUserRequests: [
      {
        userSays: "Check what I've enabled for Shepherd.",
        agentShould: `Run ${command} status and summarize connected sources, local background agents, unreadable folders, queued items, and any next command it prints. Do not inspect local folders or repositories yourself.`,
      },
      {
        userSays: "Help me set up coding agent sessions.",
        agentShould: `Ask for consent to sync Codex and Claude Code session metadata, then run ${command} agent --login if there is no saved Shepherd login, ${command} agent --add-sources coding-sessions --name "<full_name>" --org "<organization>", ${command} agent --continue, and finally ${command} status. Do not search the user's filesystem or repos for an agent implementation.`,
      },
    ],
    askStyle: [
      "Ask in short interactive prompts, not as a pasted checklist.",
      "Start with selection questions to determine what the user wants connected.",
      "Ask whether they are joining an existing organization or creating a new one.",
      "Run Shepherd WorkOS login/signup before source setup. Do not ask whether they already have an account.",
      "Treat WorkOS login as Shepherd account identity only; do not use WorkOS Auth, WorkOS Pipes, or per-user Google OAuth for Google Workspace delegation.",
      "Collect Full name and Organization name as direct text prompts after those choices. The email comes from WorkOS auth.",
      "Tell the user Shepherd verifies existing-org joins from the authenticated WorkOS account and company email domain. The typed org name is not trusted by itself.",
      "If Google Workspace is selected, guide the customer's Google Workspace super admin to authorize Shepherd's Client ID and scopes in Google Admin Console.",
      "Ask Messages as a selectable choice: Skip Messages, or Provide handle.",
      "Ask Coding Sessions as a selectable choice: Skip Coding Sessions, or Sync Codex/Claude Code session metadata.",
      "If the user chooses Provide handle, ask for the phone number, Apple ID email, or both comma-separated.",
      "If Messages is selected, ask the user to grant or confirm macOS Full Disk Access for the app running onboarding and the Node.js binary used by background sync. Shepherd checks this and keeps prompting until access works in interactive onboarding.",
      "If Messages is selected, run the recent-chat command. It opens a browser selector with recent chats and search. Never sync all Messages chats by default; use all only when the user explicitly asks for every current and future chat.",
      "If Coding Sessions is selected, continue onboarding installs a local LaunchAgent that reads Codex and Claude Code session logs, redacts sensitive strings locally, and syncs bounded structured metadata. It usually does not require Full Disk Access unless macOS denies access to ~/.codex or ~/.claude.",
      "After raw onboarding completes, ask whether they want Shepherd MCP installed for their signed-in customer account into Codex, Claude Code, both, or none.",
    ],
    selectionQuestions: [
      {
        label: "Organization",
        prompt: "Are you joining an existing organization or creating a new one?",
        options: ["Join existing org", "Create new org"],
      },
      {
        label: "Sources",
        prompt: "Which sources should Shepherd connect for raw sync?",
        options: ["Google Workspace (Gmail/Drive/Docs/Calendar/Sheets/Slides/Tasks/Contacts)", "Notion", "Slack", "Granola", "Messages", "Coding Sessions (Codex/Claude Code metadata)"],
        multiSelect: true,
      },
      {
        label: "Messages",
        prompt: "Do you want to connect local Messages?",
        options: ["Skip Messages", "Provide handle"],
      },
      {
        label: "MCP install",
        prompt: "After onboarding completes, where should Shepherd MCP be installed for you?",
        options: ["Codex", "Claude Code", "None"],
        multiSelect: true,
      },
    ],
    askUserFor: [
      "Full name",
      "Organization name",
      "Messages phone number, Apple ID email, or both comma-separated, if they want local Messages connected",
      "Full Disk Access confirmation, if they want local Messages connected on macOS",
      "Selected local Messages chats from the browser selector, if they want local Messages connected",
      "Coding-session sync consent, if they want Codex and Claude Code session metadata connected",
      "MCP install targets after onboarding completes: Codex, Claude Code, both, or none",
    ],
    afterStartCommand: [
      "Handle only the current modality opened or printed by the command.",
      "After the current modality is complete, run the continue command to advance to the next unresolved modality.",
      "Do not open Notion, Slack, Granola, or Messages while Google Workspace is still waiting; do not open Slack, Granola, or Messages while Notion is still waiting; do not open Granola or Messages while Slack is still waiting.",
    ],
    doNotDo: [
      "Do not run local wiki generation.",
      "Do not run local daily or weekly memory compilation.",
      "Do not run local document summary generation.",
      "Do not ask the user for Railway or database configuration.",
      "Do not ask the customer to create a Google service account or upload service account JSON for the default Shepherd-managed flow.",
      "Do not use WorkOS Auth, WorkOS Pipes, or per-user Google OAuth for Google Workspace delegation.",
      "Do not fill onboarding fields from local repository context, shell identity, machine paths, or earlier conversations; confirm them directly with the user.",
      "Do not use shell or file tools to list, search, or read the user's home directory, repositories, ~/.codex, ~/.claude, or ~/.shepherd for Shepherd setup. Only the askshepherd npm commands should perform local setup/status checks.",
    ],
    loginCommand: `${command} agent --login`,
    startCommand: `${command} agent --name "<full_name>" --org "<organization>"`,
    addSourcesCommand: `${command} agent --add-sources coding-sessions --name "<full_name>" --org "<organization>"`,
    continueCommand: `${command} agent --continue`,
    checkCommand: `${command} status`,
    mcpLoginCommand: `${command} mcp-login`,
    optionalContinueArgs: [
      "--messages-handle \"<phone_or_apple_id[,apple_id]>\" if local Messages is being connected",
      "--messages-chat-ids \"<comma_separated_chat_ids>\" if local Messages is being connected, or --messages-chat-ids all when the user explicitly wants every current and future Messages chat watched",
      "--github-token \"<github_pat>\" and --github-repo \"<owner/repo>\" if GitHub is being connected",
      "--granola-api-key \"<legacy_granola_key>\" only when Granola falls back to legacy API-key setup",
    ],
    statusCommand: `${command} status`,
    agentStatusCommand: `${command} agent --status`,
    messagesChatsCommand: `${command} messages-chats`,
    messagesPermissions: {
      macOS: "Local Messages raw sync needs Full Disk Access for the app running onboarding and for Node.js used by the background LaunchAgent, so launchd can start the Messages agent after onboarding. The Messages selector command validates local chat.db access, opens Full Disk Access settings if needed, and keeps checking until access works in interactive onboarding. Background sync also verifies launchd can start the Messages agent. Contacts permission is also needed for contact-name hydration; Shepherd reads contact names from the local macOS AddressBook database, reloads Contacts on startup, watches AddressBook changes, and scopes synced messages to the token-bound customer account. If that schema cannot be read, raw message sync still works but contact names are marked degraded and the user should contact founders@askshepherd.ai.",
      nodeBinary: process.execPath,
    },
    codingSessions: {
      sourceFlag: "--sources coding-sessions or --add-sources coding-sessions",
      statusCommand: `${command} coding-sessions-status`,
      localAgentCommand: `${command} coding-sessions-agent --config ~/.shepherd/coding-sessions/<id>.json`,
      privacy: "Shepherd uploads bounded structured session metadata, not full raw Codex or Claude Code transcripts or locally generated narrative summaries. Secrets, auth headers, private keys, credential URLs, high-entropy tokens, and home paths are redacted.",
    },
    googleWorkspaceDelegation: googleWorkspaceDelegationSetup(),
    orgSecurity: "Existing organizations are only reused when Shepherd can verify the authenticated user belongs there, for example by an existing Shepherd account/membership or matching non-personal company email domain. Similar spelling helps match verified orgs, but cannot attach an unverified user to someone else's org.",
    expectedResult: "Cloud sources start raw polling/backfill in the Shepherd production environment selected for the authenticated account. Finalize asks that environment's brain services to schedule downstream ingestion batches, wiki ingestion, memory artifacts, document summaries, and coding-session wiki artifacts. Local Messages and Coding Sessions start via macOS LaunchAgents when run on macOS.",
    granolaApiKeyCommand: `${command} granola-api-keys`,
    granolaApiKeyPath: "Legacy fallback: Granola desktop app -> Settings -> Connectors -> API keys",
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Shepherd coding-agent onboarding

Use this as a public checklist for coding-agent onboarding to Shepherd raw sync.

Confirm onboarding choices and fields directly with the user instead of assuming them from the local repo, shell username, machine paths, or earlier conversations.

Do not inspect the user's folders or repositories for Shepherd setup. Do not run ls, find, rg, grep, cat, Read, Glob, or Explore against the user's home directory, repos, ~/.codex, ~/.claude, or ~/.shepherd. Use the askshepherd npm commands below; those commands perform the bounded local checks.

Ask with short interactive prompts, not as one pasted checklist. Do not paste this whole checklist into the chat unless the user explicitly asks to see it.

Common user requests:
- If the user asks "Check what I've enabled for Shepherd?", run:
  ${payload.checkCommand}
  Then summarize connected sources, local background agents, unreadable folders, queued items, and the next command to fix anything missing.
- If the user asks "Help me set up coding agent sessions", ask for consent to sync Codex and Claude Code session metadata, then run login if needed, add only the coding-sessions source, continue setup, and finish by checking status:
  ${payload.loginCommand}
  ${payload.addSourcesCommand}
  ${payload.continueCommand}
  ${payload.checkCommand}

Start with selection questions to determine intent:
1. Organization: Join existing org, or Create new org.
2. Sources: Google Workspace (Gmail/Drive/Docs/Calendar/Sheets/Slides/Tasks/Contacts), Notion, Slack, GitHub, Granola, Messages, Coding Sessions (Codex/Claude Code metadata). Allow multi-select if your interface supports it.
3. Messages, if selected: Skip Messages, or Provide handle.
4. MCP install after onboarding completes: Codex, Claude Code, both, or none.

When discussing existing orgs, keep it short: Shepherd verifies the join from their Shepherd login and company email domain. The org name they type is not trusted by itself.

Before source setup, always run:
  ${payload.loginCommand}

That opens one WorkOS Shepherd login/signup flow and saves a local onboarding auth session. It creates or relinks the Shepherd customer account; the next setup command attaches sources to the same Shepherd production environment chosen for that authenticated account.
Do not use WorkOS Auth, WorkOS Pipes, or per-user Google OAuth for Google Workspace. WorkOS login is only Shepherd account identity.

Ask the user for:
1. Full name
2. Organization name
3. Messages phone number, Apple ID email, or both comma-separated, only if they selected Messages and chose Provide handle

Do not ask for their email separately. Use the email returned by WorkOS auth.

If they are joining an existing org, ask for the org name they believe they belong to. Shepherd will match similar/case-different org names only when the authenticated account is allowed to join that org. Otherwise it creates or uses a separate org.

If Messages is selected, run:
  ${payload.messagesChatsCommand}

Before or during this step, ask the user to grant or confirm macOS Full Disk Access for local Messages sync. The command validates access to the local Messages database, opens System Settings -> Privacy & Security -> Full Disk Access if access is missing, and keeps checking until access works in interactive onboarding. The user should enable the app running onboarding, such as Terminal, iTerm, Claude Code, or Codex, and Node.js for background sync:
  ${payload.messagesPermissions.nodeBinary}
Shepherd reads contact names from the local macOS AddressBook database. If that database schema cannot be read, raw Messages sync still works, but contact names will be marked degraded and the user should contact founders@askshepherd.ai.

This opens a minimal local webpage with recent local Messages chats and search. Have the user select which contacts/groups Shepherd should sync. Do not select all chats by default. If the user explicitly wants everything, use the "Sync all current and future chats" checkbox or pass --messages-chat-ids all. All-chats mode backfills current chats and keeps watching chats that appear later. When the command returns, keep the printed chat IDs or the literal value all.

Then run:
  ${payload.startCommand}

Add skip flags for sources the user did not select:
- --no-google
- --no-slack
- --no-granola
- --no-messages

Or pass an exact source list, especially for adding sources later:
  ${command} agent --add-sources coding-sessions --name "<full_name>" --org "<organization>"

That command creates/reuses the customer user and org, saves local state, and opens at most one source setup surface. It works one modality at a time after account setup: Google Workspace, then Notion, then Slack, then GitHub, then Granola. If Messages details are still missing, it prints the Messages selector command instead of opening another auth surface. Do not manually open later source setup surfaces until the command tells you that source is the current modality.

If Google Workspace is the current modality, the setup command opens the Admin Console domain-wide delegation page. Show this setup to the user and have their Google Workspace super admin authorize it:

App name: ${payload.googleWorkspaceDelegation.appName}
Service account email: ${payload.googleWorkspaceDelegation.serviceAccountEmail}
Domain-wide delegation OAuth Client ID: ${payload.googleWorkspaceDelegation.clientId}

Scopes:
${payload.googleWorkspaceDelegation.scopes.join("\n")}

The setup command copies those scopes to the clipboard as one comma-separated string on macOS. Tell the user they can paste directly into the OAuth scopes field. If clipboard copy is unavailable, use the scopes printed above.

The customer does not create a service account and does not upload service account JSON in the default Shepherd-managed flow. Their super admin only authorizes the Client ID and scopes in Google Admin Console. Shepherd's backend stores and uses its private service account JSON server-side.
Shepherd must still enforce selected users and groups internally before polling or impersonating any employee email.

If Slack is the current modality and your browser automation can complete that auth screen, do it. If it cannot click through OAuth screens, leave the opened browser tab for the user and ask them to complete Slack auth. Do not open Granola or Messages until Slack is complete and the continue command advances.

If GitHub is the current modality, do not use browser OAuth as the primary setup. Ask the user for a GitHub fine-grained or classic PAT and exact owner/repo, then continue with --github-token and --github-repo. Shepherd uses this path to create the repository webhook; OAuth-only GitHub is tools-only and does not provide full event sync coverage.

If Granola is the current modality, the command opens Granola browser authorization when OAuth is configured. Leave the browser tab for the user and ask them to complete authorization before continuing.

If the command reports the legacy Granola API-key fallback, it opens the Granola desktop app. If your local app automation can navigate it, go to:
  Settings -> Connectors -> API keys
Then have the user create/copy the API key.

If the legacy Granola API-key fallback is needed and Granola did not come forward, run:
  ${payload.granolaApiKeyCommand}
That command opens Granola and tries to navigate to Settings -> Connectors -> API keys. If your tool cannot click inside Granola, leave Granola open and ask the user to go to that screen.

After the current modality is complete, run:
  ${payload.continueCommand} --github-token "<github_pat>" --github-repo "<owner/repo>" --messages-handle "<phone_or_apple_id[,apple_id]>" --messages-chat-ids "<comma_separated_chat_ids_or_all>" --granola-api-key "<legacy_granola_key>"

Omit any optional flag that is not being requested. Do not pass --granola-api-key after successful Granola browser authorization.

If Coding Sessions was selected, the continue step installs local Codex/Claude Code session metadata sync. It probes ~/.codex and ~/.claude, redacts sensitive strings, and uploads bounded structured metadata rather than full transcripts or local narrative summaries. It usually does not need Full Disk Access unless macOS denies access to those folders.
The coding agent must not probe those folders directly; only the askshepherd CLI may perform that local check.

Check progress with:
  ${payload.statusCommand}

Check local coding-session sync with:
  ${payload.codingSessions.statusCommand}

After onboarding completes, ask whether to install Shepherd MCP for the signed-in customer into Codex, Claude Code, both, or none.
If they choose any targets, run:
  ${payload.mcpLoginCommand} --install "<codex,claude>"
Use only the selected target names. If they choose none, skip MCP install for now; they can run the same command later.

Do not ask for Railway, Postgres, Redis, service names, or internal credentials.
Do not trigger local wiki generation, daily/weekly memory compilation, or doc summaries.
This flow links sources, starts raw polling/backfill, and lets the selected Shepherd production brain services run downstream processing separately.
`);
}

function hasIdentityArgs() {
  return Boolean(stringArg("email") && stringArg("name") && stringArg("org"));
}

function selectedSources() {
  const explicitSources = stringArg("sources") ?? stringArg("add-sources");
  const selected = explicitSources
    ? sourceSelectionFromList(explicitSources)
    : {
        google: !args["no-google"],
        notion: !args["no-notion"],
        slack: !args["no-slack"],
        granola: !args["no-granola"],
        messages: !args["no-messages"],
        codingSessions: args["coding-sessions"] === true || args["coding-sessions"] === "true",
      };

  if (args["no-google"]) selected.google = false;
  if (args["no-notion"]) selected.notion = false;
  if (args["no-slack"]) selected.slack = false;
  if (args["no-granola"]) selected.granola = false;
  if (args["no-messages"]) selected.messages = false;
  if (args["no-coding-sessions"]) selected.codingSessions = false;
  if (args["coding-sessions"]) selected.codingSessions = true;

  return selected;
}

function sourceSelectionFromList(value) {
  const selected = {
    google: false,
    notion: false,
    slack: false,
    github: false,
    granola: false,
    messages: false,
    codingSessions: false,
  };
  const aliases = new Map([
    ["google", "google"],
    ["gmail", "google"],
    ["drive", "google"],
    ["docs", "google"],
    ["gdocs", "google"],
    ["calendar", "google"],
    ["notion", "notion"],
    ["slack", "slack"],
    ["github", "github"],
    ["granola", "granola"],
    ["messages", "messages"],
    ["imessage", "messages"],
    ["imessages", "messages"],
    ["coding-sessions", "codingSessions"],
    ["coding_sessions", "codingSessions"],
    ["codingsessions", "codingSessions"],
    ["sessions", "codingSessions"],
    ["codex", "codingSessions"],
    ["claude", "codingSessions"],
    ["claude-code", "codingSessions"],
  ]);
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) throw new Error("--sources requires at least one source.");
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  for (const part of parts) {
    if (part === "all") {
      selected.google = true;
      selected.notion = true;
      selected.slack = true;
      selected.github = true;
      selected.granola = true;
      selected.messages = true;
      selected.codingSessions = true;
      continue;
    }
    const source = aliases.get(part);
    if (!source) {
      throw new Error(`Unknown source "${part}". Use google, notion, slack, github, granola, messages, coding-sessions, or all.`);
    }
    selected[source] = true;
  }
  return selected;
}

async function writeAgentState(state) {
  const path = agentStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  // writeFile's mode only applies on creation; an existing file keeps its
  // permissions, so enforce them on every token write.
  await chmod(path, 0o600);
  return path;
}

async function readAgentState() {
  const path = agentStatePath();
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return {
    ...parsed,
    apiUrl: requiredConfigString(parsed.apiUrl, "apiUrl"),
    sessionId: requiredConfigString(parsed.sessionId, "sessionId"),
    sessionToken: requiredConfigString(parsed.sessionToken, "sessionToken"),
    account: parsed.account,
    sources: parsed.sources ?? {},
    authUrls: stringRecord(parsed.authUrls),
    googleWorkspaceDelegation: parsed.googleWorkspaceDelegation,
    workosAuth: parsed.workosAuth,
  };
}

async function readOptionalAgentState() {
  const path = agentStatePath();
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

function agentStatePath() {
  const onboardingState = stringArg("onboarding-state");
  if (onboardingState) return expandHomePath(onboardingState);
  if (command === "mcp") return DEFAULT_AGENT_STATE_PATH;
  const explicitState = stringArg("state");
  if (explicitState) return explicitState;
  const channel = cliChannel();
  if (channel === STABLE_CHANNEL) return DEFAULT_AGENT_STATE_PATH;
  return join(homedir(), ".shepherd", `raw-onboarding-agent.${channel}.json`);
}

function normalizeLaunchAgentChannel(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const channel = raw || STABLE_CHANNEL;
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Invalid Shepherd launch agent channel "${value}". Use lowercase letters, numbers, and hyphens.`);
  }
  return channel;
}

function cliChannel(...values) {
  for (const value of [...values, stringArg("channel"), runtimeLaunchAgentChannel, process.env.SHEPHERD_ONBOARD_CHANNEL, process.env.SHEPHERD_APP_CHANNEL]) {
    if (typeof value === "string" && value.trim()) return normalizeLaunchAgentChannel(value);
  }
  return STABLE_CHANNEL;
}

function setRuntimeLaunchAgentChannel(value) {
  runtimeLaunchAgentChannel = cliChannel(value);
  return runtimeLaunchAgentChannel;
}

function channelLabelPrefix(channel) {
  return channel === STABLE_CHANNEL ? "" : `${channel}.`;
}

function channelFilePrefix(channel) {
  return channel === STABLE_CHANNEL ? "" : `${channel}-`;
}

function channelRecord(channel) {
  return channel === STABLE_CHANNEL ? {} : { channel };
}

function shepherdDeviceIdFile(channel = cliChannel()) {
  const dir = join(homedir(), ".shepherd");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${channelFilePrefix(normalizeLaunchAgentChannel(channel))}device-id`);
}

function loadOrCreateShepherdDeviceId(channel = cliChannel()) {
  const path = shepherdDeviceIdFile(channel);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (isUuid(existing)) return existing.toLowerCase();
  } catch {
    // Missing or unreadable device id will be repaired below.
  }

  const next = randomUUID();
  const tmpFile = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpFile, `${next}\n`, { mode: 0o600 });
  renameSync(tmpFile, path);
  return next;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? "").trim());
}

async function updateAgentStateFromOnboardingResponse(state, response) {
  const authUrls = stringRecord(response?.authUrls);
  const hasAuthUrls = Object.keys(authUrls).length > 0;
  const hasGoogleWorkspaceDelegation = response?.googleWorkspaceDelegation
    && typeof response.googleWorkspaceDelegation === "object"
    && !Array.isArray(response.googleWorkspaceDelegation);
  const hasStatus = typeof response?.status === "string";
  const hasProcessing = typeof response?.processingEnabled === "boolean" || response?.processing;
  const hasProviders = response?.providers && typeof response.providers === "object" && !Array.isArray(response.providers);
  const responseSources = sourceSelectionFromSession(response, null);
  const hasSources = responseSources !== null;
  if (!hasAuthUrls && !hasGoogleWorkspaceDelegation && !hasStatus && !hasProcessing && !hasProviders && !hasSources) return state;

  const next = {
    ...state,
    ...(hasAuthUrls ? { authUrls: { ...(state.authUrls ?? {}), ...authUrls } } : {}),
    ...(hasGoogleWorkspaceDelegation
      ? { googleWorkspaceDelegation: googleWorkspaceDelegationSetup(response.googleWorkspaceDelegation) }
      : {}),
    ...(hasStatus ? { status: response.status } : {}),
    ...(typeof response?.processingEnabled === "boolean" ? { processingEnabled: response.processingEnabled } : {}),
    ...(response?.processing ? { processing: response.processing } : {}),
    ...(hasProviders ? { providers: response.providers } : {}),
    ...(hasSources ? { sources: responseSources } : {}),
  };
  await writeAgentState(next);
  return next;
}

function printProcessingSummary(payload) {
  if (payload?.processingEnabled === true && payload?.processing?.status === "started") {
    console.log("Downstream processing: started. Wiki, memory, and summary generation are queued or scheduled in production.");
    return;
  }

  console.log("Downstream processing: not started. Run the continue command again after source authorization is complete.");
}

function publicAgentAccount(account) {
  return {
    email: account?.email,
    name: account?.name,
    organizationName: account?.organizationName,
    organizationSlug: account?.organizationSlug,
    organizationMatch: account?.organizationMatch,
  };
}

function googleWorkspaceDelegationSetup(setup) {
  return {
    appName: setup?.appName ?? GOOGLE_WORKSPACE_DELEGATION_APP_NAME,
    serviceAccountEmail:
      setup?.serviceAccountEmail ?? GOOGLE_WORKSPACE_DELEGATION_SERVICE_ACCOUNT_EMAIL,
    clientId: setup?.clientId ?? GOOGLE_WORKSPACE_DELEGATION_CLIENT_ID,
    scopes: Array.isArray(setup?.scopes) && setup.scopes.length > 0
      ? setup.scopes
      : GOOGLE_WORKSPACE_DELEGATION_SCOPES,
  };
}

function printGoogleWorkspaceDelegationSetup(setup) {
  const resolved = googleWorkspaceDelegationSetup(setup);
  const copiedScopes = copyTextToClipboard(resolved.scopes.join(","));
  console.log(`App name: ${resolved.appName}`);
  console.log(`Service account email: ${resolved.serviceAccountEmail}`);
  console.log(`Domain-wide delegation OAuth Client ID: ${resolved.clientId}`);
  console.log("Customer action: in Google Admin Console, add the Client ID above and paste these scopes.");
  console.log("Customers do not create a service account or upload service account JSON; Shepherd stores its private service account JSON server-side.");
  if (copiedScopes) {
    console.log("Copied comma-separated scopes to the clipboard.");
  } else if (platform() === "darwin") {
    console.log("Could not copy scopes to the clipboard; copy the scopes below instead.");
  }
  console.log("\nScopes:");
  for (const scope of resolved.scopes) console.log(scope);
}

function copyTextToClipboard(text) {
  if (platform() !== "darwin") return false;
  try {
    execFileSync("pbcopy", [], {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function authenticatedEmail(authenticated) {
  return authenticated?.workosUser?.email ?? authenticated?.account?.email ?? null;
}

function authenticatedName(authenticated) {
  return authenticated?.workosUser?.name ?? authenticated?.account?.name ?? null;
}

function pendingAgentSources(sources, errors) {
  const pending = new Set(Object.keys(errors ?? {}));
  return AGENT_MODALITY_ORDER.filter((source) => sources?.[source] && pending.has(source));
}

async function openNextAgentModality({ sources, authUrls = {}, noOpen = false, pendingSources = null }) {
  const pending = pendingSources ?? AGENT_MODALITY_ORDER.filter((source) => sources?.[source]);
  for (const source of AGENT_MODALITY_ORDER) {
    if (!sources?.[source] || !pending.includes(source)) continue;

    if (source === "google") {
      return {
        source,
        label: "Google Workspace",
        ...await openGoogleWorkspaceDelegationAdmin({ noOpen }),
      };
    }

    if (source === "notion") {
      const url = typeof authUrls.notion === "string" ? authUrls.notion : null;
      if (!url) {
        return {
          source,
          label: "Notion",
          opened: false,
          message: "Notion authorization URL was not returned by Shepherd.",
        };
      }
      await openOrPrint(url, { noOpen });
      return { source, label: "Notion", opened: !noOpen, url };
    }

    if (source === "slack") {
      const url = typeof authUrls.slack === "string" ? authUrls.slack : null;
      if (!url) {
        return {
          source,
          label: "Slack",
          opened: false,
          message: "Slack authorization URL was not returned by Shepherd.",
        };
      }
      await openOrPrint(url, { noOpen });
      return { source, label: "Slack", opened: !noOpen, url };
    }

    if (source === "github") {
      return {
        source,
        label: "GitHub",
        opened: false,
        patRequired: true,
        message: "Provide --github-token and --github-repo so Shepherd can create the repository webhook; OAuth alone is tools-only and does not provide full event sync coverage.",
      };
    }

    if (source === "granola") {
      const url = typeof authUrls.granola === "string" ? authUrls.granola : null;
      if (url) {
        await openOrPrint(url, { noOpen });
        return { source, label: "Granola", opened: !noOpen, url };
      }
      const result = await openGranolaApiKeys({ noOpen: noOpen || Boolean(args["no-open-granola"]) });
      return { source, label: "Granola", legacyApiKey: true, ...result };
    }

    if (source === "messages") {
      return {
        source,
        label: "Messages",
        opened: false,
        command: `${agentCommand()} messages-chats`,
        message: "Run the local Messages chat selector and keep the printed chat IDs.",
      };
    }

    if (source === "codingSessions") {
      return {
        source,
        label: "Coding Sessions",
        opened: false,
        command: `${agentCommand()} agent --continue`,
        message: "Continue onboarding to install local Codex and Claude Code session sync.",
      };
    }
  }

  return null;
}

function printAgentCurrentAction(action, opts = {}) {
  if (!action) {
    console.log("\nNo source setup page was opened.");
    return;
  }

  console.log(`\nCurrent modality: ${action.label}`);

  if (action.source === "google") {
    if (action.opened) {
      console.log(`Opened Google Admin Console: ${action.url}`);
    } else {
      console.log(`Google Admin Console domain-wide delegation URL: ${action.url}`);
    }
    console.log("\nGoogle Workspace domain-wide delegation setup:");
    printGoogleWorkspaceDelegationSetup(opts.googleWorkspaceDelegation);
    console.log("\nAsk the user's Google Workspace super admin to authorize Shepherd before opening another source.");
    return;
  }

  if (action.source === "slack") {
    if (action.opened) {
      console.log("Opened Slack authorization in the browser.");
    } else if (action.url) {
      console.log(`Slack authorization URL: ${action.url}`);
    } else if (action.message) {
      console.log(action.message);
    }
    console.log("Ask the user to complete Slack authorization before opening another source.");
    return;
  }

  if (action.source === "notion") {
    if (action.opened) {
      console.log("Opened Notion authorization in the browser.");
    } else if (action.url) {
      console.log(`Notion authorization URL: ${action.url}`);
    } else if (action.message) {
      console.log(action.message);
    }
    console.log("Ask the user to complete Notion authorization before opening another source.");
    return;
  }

  if (action.source === "github") {
    console.log(action.message ?? "Provide a GitHub PAT and owner/repo for webhook-backed event sync.");
    console.log("Do not use browser OAuth as the primary GitHub setup path for event coverage.");
    return;
  }

  if (action.source === "granola") {
    if (action.url) {
      if (action.opened) {
        console.log("Opened Granola authorization in the browser.");
      } else {
        console.log(`Granola authorization URL: ${action.url}`);
      }
      console.log("Ask the user to complete Granola authorization before opening another source.");
      return;
    }
    if (action.target) console.log(`Granola target: ${action.target}`);
    console.log("Ask the user to create/copy the legacy Granola API key before opening another source.");
    return;
  }

  if (action.source === "messages") {
    console.log(`Run: ${action.command}`);
    console.log("Have the user select specific local Messages chats; do not select all by default.");
    console.log("Ask the user to grant or confirm macOS Full Disk Access for the app running onboarding and Node.js before installing background Messages sync.");
    return;
  }

  if (action.source === "codingSessions") {
    console.log(`Run: ${action.command}`);
    console.log("This installs a local LaunchAgent that reads Codex and Claude Code session logs, redacts sensitive strings locally, and syncs bounded structured metadata to Shepherd.");
  }
}

function agentNeedsUserAction(sources, action) {
  if (!action) return [];
  if (action.source === "google") return ["Have the customer's Google Workspace super admin authorize Shepherd's domain-wide delegation Client ID and scopes in Google Admin Console."];
  if (action.source === "notion") return ["Complete Notion browser authorization."];
  if (action.source === "slack") return ["Complete Slack browser authorization."];
  if (action.source === "github") return ["Provide --github-token and --github-repo so Shepherd can create the repository webhook; OAuth alone is tools-only and does not provide full event sync coverage."];
  if (action.source === "granola") return [action.url ? "Complete Granola browser authorization." : "Create/copy a legacy Granola API key from the Granola Mac app."];
  if (action.source === "messages") return ["Grant or confirm macOS Full Disk Access for the onboarding app and Node.js, run messages-chats, have the user select local Messages contacts/groups in the browser, then pass the printed chat IDs with the Messages handle."];
  if (action.source === "codingSessions") return ["Run the continue command to install local Codex and Claude Code session metadata sync."];
  return [];
}

function agentCommand() {
  return `npx -y ${PACKAGE_SPEC}`;
}

function safeErrorRecord(errors) {
  return Object.fromEntries(
    Object.entries(errors).map(([source, message]) => [source, safeError(message)]),
  );
}

function stringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry) => typeof entry[1] === "string" && entry[1].trim()),
  );
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function valueOrPrompt(argName, label, opts = {}) {
  const existing = args[argName];
  if (typeof existing === "string") return existing.trim();
  const value = opts.secret
    ? await promptSecret(`${label}${opts.optional ? " (optional)" : ""}: `)
    : await prompt(`${label}${opts.optional ? " (optional)" : ""}: `);
  if (!opts.optional && !value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

async function prompt(label) {
  process.stdin.resume();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptSecret(label) {
  if (!process.stdin.isTTY) return prompt(label);

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdout.write(label);

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
    };

    const onKeypress = (text, key) => {
      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        resolve(value.trim());
        return;
      }
      if (key?.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      if (key?.name === "backspace" || key?.name === "delete") {
        value = value.slice(0, -1);
        return;
      }
      if (typeof text === "string" && text >= " ") {
        value += text;
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

async function waitForEnter(label) {
  await prompt(`${label} `);
}

async function openOrPrint(url, opts) {
  if (opts.noOpen) {
    console.log(url);
    return;
  }

  const opener = platform() === "darwin"
    ? ["open", [url]]
    : platform() === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];

  await new Promise((resolve) => {
    const child = spawn(opener[0], opener[1], { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.log(url);
      resolve();
    });
    child.on("exit", () => resolve());
    child.unref();
    setTimeout(resolve, 500);
  });
}

async function openGoogleWorkspaceDelegationAdmin(opts = {}) {
  if (opts.noOpen) {
    console.log(`Google Admin Console domain-wide delegation URL: ${GOOGLE_WORKSPACE_DELEGATION_ADMIN_URL}`);
    return { opened: false, url: GOOGLE_WORKSPACE_DELEGATION_ADMIN_URL };
  }
  await openOrPrint(GOOGLE_WORKSPACE_DELEGATION_ADMIN_URL, { noOpen: false });
  return { opened: true, url: GOOGLE_WORKSPACE_DELEGATION_ADMIN_URL };
}

async function ensureMessagesReadPermission(opts = {}) {
  if (platform() !== "darwin") return { ok: true, checked: false };
  if (await canReadPath(MESSAGES_CHAT_DB_PATH)) return { ok: true, checked: true };

  while (true) {
    console.log("\nMessages local permission required");
    console.log("Shepherd needs macOS Full Disk Access to read your local Messages database for chat selection and raw sync.");
    printMessagesPermissionTargets();
    await openFullDiskAccessSettings(opts);

    if (await canReadPath(MESSAGES_CHAT_DB_PATH)) return { ok: true, checked: true };

    if (!process.stdin.isTTY || args["no-permission-prompt"]) {
      throw new Error("Shepherd still cannot read local Messages storage. Grant Full Disk Access to the app running onboarding and Node.js, then rerun the Messages step.");
    }

    await waitForEnter("After granting Full Disk Access, press Enter to retry Messages access. Shepherd will keep checking until access works.");
    if (await canReadPath(MESSAGES_CHAT_DB_PATH)) return { ok: true, checked: true };
  }
}

async function explainMessagesBackgroundPermissions(opts = {}) {
  if (platform() !== "darwin" || messagesPermissionNoticePrinted) return;
  messagesPermissionNoticePrinted = true;

  console.log("\nMessages background sync permissions");
  console.log("Local Messages raw sync runs as a macOS LaunchAgent using npx/Node.js. For continuous sync, macOS Full Disk Access must include the background Node.js binary, not just the current terminal.");
  printMessagesPermissionTargets();
  console.log("Shepherd reads contact names from the local macOS AddressBook database. If that schema cannot be read, raw Messages sync still works but contact names are marked degraded; contact founders@askshepherd.ai.");
  await openFullDiskAccessSettings(opts);

  if (opts.waitForUser && process.stdin.isTTY && !args["no-permission-prompt"]) {
    await waitForEnter("Confirm Full Disk Access is granted or already present, then press Enter to install Messages background sync.");
  } else {
    console.log("If the permission is not granted yet, grant it now and rerun the Messages continue step or restart the LaunchAgent after granting it.");
  }
}

function printMessagesPermissionTargets() {
  console.log("Open System Settings -> Privacy & Security -> Full Disk Access, then enable:");
  console.log("- The app running onboarding, such as Terminal, iTerm, Claude Code, or Codex.");
  console.log(`- Node.js: ${process.execPath}`);
  console.log(`Messages database: ${MESSAGES_CHAT_DB_PATH}`);
  console.log(`Messages attachments directory: ${MESSAGES_ATTACHMENTS_DIR}`);
}

async function openFullDiskAccessSettings(opts = {}) {
  if (opts.noOpen) {
    console.log(`Full Disk Access settings: ${MAC_FULL_DISK_ACCESS_URL}`);
    return;
  }
  const opened = await execFileQuiet("open", [MAC_FULL_DISK_ACCESS_URL], { ignoreError: true, captureError: true });
  if (opened.error) {
    await execFileQuiet("open", [LEGACY_MAC_FULL_DISK_ACCESS_URL], { ignoreError: true });
  }
}

async function openContactsPrivacySettings(opts = {}) {
  if (opts.noOpen) {
    console.log(`Apple Contacts privacy settings: ${MAC_CONTACTS_ACCESS_URL}`);
    return;
  }
  const opened = await execFileQuiet("open", [MAC_CONTACTS_ACCESS_URL], { ignoreError: true, captureError: true });
  if (opened.error) {
    await execFileQuiet("open", [LEGACY_MAC_CONTACTS_ACCESS_URL], { ignoreError: true });
  }
}

function printMessagesContactsStatus(contacts) {
  if (platform() !== "darwin" || !contacts || contacts.ok) return;
  console.warn("Apple Contacts access is unavailable, so Messages chats may show phone numbers instead of contact names.");
  console.warn(`Open System Settings -> Privacy & Security -> Contacts and enable Shepherd or the app running onboarding.`);
}

async function canReadPath(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function openGranolaApiKeys(opts = {}) {
  const deepLink = granolaApiKeysDeepLink();
  const target = "Granola Settings -> Connectors -> Personal API keys";
  if (opts.noOpen) {
    console.log("Granola API keys: open the Granola desktop app -> Settings -> Connectors -> Personal API keys");
    return { opened: false, target };
  }

  if (platform() !== "darwin") {
    console.log("Open the Granola app and go to Settings -> Connectors -> Personal API keys.");
    return { opened: false, target };
  }

  console.log("\nOpening Granola Personal API keys");
  const bundleResult = await execFileQuiet("open", ["-b", "com.granola.app"], { ignoreError: true, captureError: true });
  const deepLinkResults = [];
  for (const delayMs of [900, 900, 1400, 2200]) {
    await sleep(delayMs);
    deepLinkResults.push(await execFileQuiet("open", [deepLink], { ignoreError: true, captureError: true }));
  }
  const activateByBundleResult = await execFileQuiet("osascript", [
    "-e",
    'tell application id "com.granola.app" to activate',
  ], { ignoreError: true, captureError: true });
  const activateByNameResult = await execFileQuiet("open", ["-a", "Granola"], { ignoreError: true, captureError: true });

  if (
    bundleResult.error
    && deepLinkResults.every((result) => result.error)
    && activateByBundleResult.error
    && activateByNameResult.error
  ) {
    await execFileQuiet("open", ["-a", "Granola"], { ignoreError: true });
  }

  return {
    opened: true,
    target,
    attemptedDeepLink: deepLink,
    deepLinkAttempts: deepLinkResults.length,
    fallback: "If local app automation cannot navigate inside Granola, ask the user to open Settings -> Connectors -> Personal API keys.",
  };
}

function granolaApiKeysDeepLink() {
  return `granola://open?path=${encodeURIComponent(GRANOLA_API_KEYS_PATH)}`;
}

async function postJson(url, body, opts = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: headers(opts.token),
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok && !(opts.allowConflict && res.status === 409)) {
    throw new Error(json.error ?? `Request failed (${res.status})`);
  }
  return json;
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, { headers: headers(opts.token) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

function headers(token) {
  return {
    "Content-Type": "application/json",
    "x-shepherd-client-source": "cli",
    "x-shepherd-engine-version": PACKAGE_VERSION,
    "x-shepherd-client-platform": platform(),
    "x-shepherd-client-arch": process.arch,
    ...(token ? { "x-shepherd-onboarding-token": token } : {}),
  };
}

async function writeMessagesConfig(input) {
  const channel = cliChannel(input.channel);
  const dir = join(homedir(), ".shepherd", "raw-messages");
  await mkdir(dir, { recursive: true });
  // The userId reaches this path from the network (server-issued session id)
  // and, via write-messages-config, from stdin; sanitize it like the launchd
  // label does so it can never traverse outside the raw-messages directory.
  const safeId = sanitizeUserFileId(input.userId);
  const path = join(dir, `${channelFilePrefix(channel)}${safeId}.json`);
  const allowedChatIds = parseAllowedChatIds(input.allowedChatIds);
  const allChats = selectedChatIdsIncludeAll(allowedChatIds);
  if (!allChats && allowedChatIds.length === 0) {
    throw new Error("Select at least one Messages chat or pass --messages-chat-ids all before installing local Messages sync.");
  }
  const handles = uniqueStrings([
    ...parseMessageHandleList(input.handle),
    ...parseMessageHandleList(input.handles),
  ]);
  const handle = handles[0] ?? null;
  await writeFile(
    path,
    JSON.stringify({
      apiUrl: input.apiUrl,
      userId: input.userId,
      agentToken: input.agentToken,
      ...channelRecord(channel),
      ...(handle ? { handle } : {}),
      ...(handles.length > 0 ? { handles } : {}),
      backfillDays: input.backfillDays,
      ...(input.backfillDays === null ? { backfillAllHistory: true } : {}),
      allChats,
      allowedChatIds: allChats ? [] : allowedChatIds,
      selectedChats: Array.isArray(input.selectedChats) ? input.selectedChats.map(publicMessageChat) : [],
      excludedMessageHandles: SHEPHERD_OWNED_MESSAGE_HANDLES,
      createdAt: new Date().toISOString(),
    }, null, 2),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

function buildMessagesAgentInstall(configPath, userId, overrides = {}) {
  const channel = cliChannel(overrides.channel);
  const safeId = userId.replace(/[^a-zA-Z0-9.-]/g, "-");
  const label = `ai.shepherd.${channelLabelPrefix(channel)}raw-messages.${safeId}`;
  const rawDir = join(homedir(), ".shepherd", "raw-messages");
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${label}.plist`);
  const stdoutPath = join(rawDir, `${channelFilePrefix(channel)}${safeId}.out.log`);
  const stderrPath = join(rawDir, `${channelFilePrefix(channel)}${safeId}.err.log`);

  const programPrefix = Array.isArray(overrides.programArguments) && overrides.programArguments.length > 0
    ? overrides.programArguments
    : ["/usr/bin/env", "npx", "-y", PACKAGE_SPEC, "messages-agent"];
  const programArguments = [...programPrefix, "--config", configPath];
  const environment = {
    PATH: launchAgentPath(),
    ...stringRecord(overrides.environment),
  };

  const programArgumentsXml = programArguments
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(rawDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
</dict>
</plist>
`;

  return { label, rawDir, agentsDir, plistPath, stdoutPath, stderrPath, channel, programArguments, environment, plist };
}

async function installMessagesAgent(configPath, userId, overrides = {}) {
  if (platform() !== "darwin") {
    throw new Error("automatic local Messages sync is only supported on macOS");
  }

  const install = buildMessagesAgentInstall(configPath, userId, overrides);
  const { label, rawDir, agentsDir, plistPath, stdoutPath, stderrPath, plist } = install;
  await mkdir(rawDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });

  await writeFile(plistPath, plist, { mode: 0o600 });
  await chmod(plistPath, 0o600);
  while (true) {
    const stdoutOffset = await fileLength(stdoutPath);
    const stderrOffset = await fileLength(stderrPath);
    await execFileQuiet("launchctl", ["unload", plistPath], { ignoreError: true });
    await execFileQuiet("launchctl", ["load", plistPath]);
    await execFileQuiet("launchctl", ["start", label], { ignoreError: true });

    try {
      await verifyMessagesAgentLaunch({ label, stdoutPath, stderrPath, stdoutOffset, stderrOffset });
      break;
    } catch (err) {
      await execFileQuiet("launchctl", ["unload", plistPath], { ignoreError: true });
      if (!isMessagesStoragePermissionError(err) || !process.stdin.isTTY || args["no-permission-prompt"]) {
        throw err;
      }

      console.log(`\n${safeError(err)}`);
      printMessagesPermissionTargets();
      await openFullDiskAccessSettings({});
      await waitForEnter("After granting Full Disk Access to Node.js, press Enter to retry background Messages sync. Shepherd will keep checking until launchd can read Messages.");
    }
  }

  return { label, plistPath, stdoutPath, stderrPath };
}

async function writeCodingSessionsConfig(input) {
  const channel = cliChannel(input.channel);
  const dir = join(homedir(), ".shepherd", "coding-sessions");
  await mkdir(dir, { recursive: true });
  const safeId = safeFileId(input.userId);
  const path = join(dir, `${channelFilePrefix(channel)}${safeId}.json`);
  const providers = normalizeCodingSessionProviders(input.providers);
  await writeFile(
    path,
    JSON.stringify({
      apiUrl: input.apiUrl,
      userId: input.userId,
      agentToken: input.agentToken,
      ...channelRecord(channel),
      intervalSeconds: Math.max(15, Math.floor(Number(input.intervalSeconds) || 60)),
      providers,
      codexDirs: providers.openai ? [CODEX_SESSIONS_DIR, CODEX_ARCHIVED_SESSIONS_DIR] : [],
      claudeProjectsDir: providers.anthropic ? CLAUDE_PROJECTS_DIR : null,
      maxFilesPerProvider: DEFAULT_CODING_SESSION_FILES_PER_PROVIDER,
      createdAt: new Date().toISOString(),
    }, null, 2),
    { mode: 0o600 },
  );
  return path;
}

async function writeOfficeAudioConfig(input) {
  const channel = cliChannel(input.channel);
  const dir = join(homedir(), ".shepherd", "office-audio");
  await mkdir(dir, { recursive: true });
  const safeId = safeFileId(input.userId);
  const path = join(dir, `${channelFilePrefix(channel)}${safeId}.json`);
  const spoolDir = input.spoolDir || join(dir, `${channelFilePrefix(channel)}spool`);
  const chunkDir = input.chunkDir || join(dir, `${channelFilePrefix(channel)}chunks`);
  const speakerProfilesDir = input.speakerProfilesDir || join(dir, `${channelFilePrefix(channel)}speaker-profiles`);
  await mkdir(spoolDir, { recursive: true });
  await mkdir(chunkDir, { recursive: true });
  await mkdir(speakerProfilesDir, { recursive: true });
  await mkdir(join(dir, `${channelFilePrefix(channel)}sent`), { recursive: true });
  const captureMode = Array.isArray(input.collectorCommand)
    ? "external_command"
    : input.captureMode === "transcript_spool" ? "transcript_spool" : "macos_afrecord";
  const processorCommand = Array.isArray(input.processorCommand)
    ? input.processorCommand.map((value) => String(value))
    : parseJsonArrayEnv("SHEPHERD_OFFICE_AUDIO_PROCESSOR_COMMAND");
  const transcriptionBackend = normalizeOfficeAudioTranscriptionBackend(
    optionalString(input.transcriptionBackend)
      ?? optionalString(process.env.SHEPHERD_OFFICE_AUDIO_TRANSCRIPTION_BACKEND)
      ?? optionalString(process.env.OFFICE_AUDIO_TRANSCRIPTION_BACKEND)
      ?? (processorCommand && processorCommand.length > 0 ? "external_provider_command" : DEFAULT_OFFICE_AUDIO_TRANSCRIPTION_BACKEND),
  );
  const enrollmentProviderCommand = Array.isArray(input.enrollmentProviderCommand)
    ? input.enrollmentProviderCommand.map((value) => String(value))
    : parseJsonArrayEnv("SHEPHERD_OFFICE_AUDIO_ENROLLMENT_PROVIDER_COMMAND") ?? (transcriptionBackend === "external_provider_command" ? processorCommand : null);
  await writeFile(
    path,
    JSON.stringify({
      apiUrl: input.apiUrl,
      userId: input.userId,
      agentToken: input.agentToken,
      ...channelRecord(channel),
      roomProfileId: input.roomProfileId ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      roomOwnerUserId: input.roomOwnerUserId ?? null,
      roomCode: input.roomCode ?? null,
      space: input.space && typeof input.space === "object" && !Array.isArray(input.space) ? input.space : null,
      deviceId: input.deviceId ?? `mac-${safeId}`,
      inputDeviceUid: input.inputDeviceUid ?? null,
      spoolDir,
      chunkDir,
      speakerProfilesDir,
      captureMode,
      chunkSeconds: Math.max(5, Math.min(300, Math.floor(Number(input.chunkSeconds) || 30))),
      transcriptionBackend,
      transcriptionPipeline: {
        mode: input.transcriptionMode === "local_private_eval" ? "local_private_eval" : "hosted_batch_voiceprint_identity",
        backend: transcriptionBackend,
        transcriptPrimaryCandidates: Array.isArray(input.transcriptPrimaryCandidates)
          ? input.transcriptPrimaryCandidates.map((value) => String(value))
          : [
              "pyannoteai-precision2-stt-orchestration",
              "elevenlabs-scribe-v2-plus-pyannoteai-identify",
            ],
        realtimeIdentityProvider: input.realtimeIdentityProvider || null,
        postSessionIdentityAudit: input.postSessionIdentityAudit || "pyannoteai-precision2-identify",
        limitedBatchChecks: Array.isArray(input.limitedBatchChecks)
          ? input.limitedBatchChecks.map((value) => String(value))
          : ["deepgram-nova3-diarization-challenger"],
        challengers: Array.isArray(input.transcriptionChallengers)
          ? input.transcriptionChallengers.map((value) => String(value))
          : [
              "soniox-v5-realtime-latency-challenger",
              "deepgram-nova3-flux-live-challenger",
              "local-pyannote-speechbrain-eval",
            ],
        speakerIdentityPolicy: "provider_model_evidence_or_human_correction_only",
        syncPolicy: "clock_offsets_plus_acoustic_alignment_with_drift_segments",
        deviceIdentityPolicy: "devices_are_room_sensors_not_people",
      },
      localAudioKey: typeof input.localAudioKey === "string" && /^[a-f0-9]{64}$/i.test(input.localAudioKey)
        ? input.localAudioKey
        : randomBytes(32).toString("hex"),
      localAudioKeyId: input.localAudioKeyId ?? `local-${safeId}`,
      collectorCommand: Array.isArray(input.collectorCommand)
        ? input.collectorCommand.map((value) => String(value))
        : null,
      processorCommand: Array.isArray(input.processorCommand)
        ? input.processorCommand.map((value) => String(value))
        : processorCommand,
      enrollmentProviderCommand,
      syncSpeakerProfiles: input.syncSpeakerProfiles !== false,
      speakerDisplayName: input.speakerDisplayName ?? null,
      intervalSeconds: Math.max(5, Math.floor(Number(input.intervalSeconds) || 30)),
      createdAt: new Date().toISOString(),
      contract: {
        spool: "Drop canonical OfficeAudioSession JSON files into spoolDir. The LaunchAgent posts them to /api/office-audio/ingest and moves successful files to sent/.",
        capture: "Default captureMode=macos_afrecord records short microphone chunks with the Shepherd app's macOS TCC identity, encrypts them locally, and writes raw chunk manifests to chunkDir.",
        transcript: "The default pyannote_full backend runs pyannoteAI STT orchestration plus voiceprint identify over the same encrypted chunks, then GPT-OSS merges the final transcript. SHEPHERD_OFFICE_AUDIO_TRANSCRIPTION_BACKEND=elevenlabs_pyannote switches STT to ElevenLabs Scribe v2 while keeping pyannoteAI identify.",
        processor: "office-audio-process-chunks decrypts local chunks into a temporary directory, runs the configured built-in backend or a redacted external processorCommand, writes canonical OfficeAudioSession JSON to spoolDir, and deletes temporary plaintext audio.",
        speakerIdentity: "Speaker names require provider/model identity evidence from enrolled voice references or an explicit human correction. Device collector, channel id, loudness, seating, and roster order are never direct naming authority.",
        realtime: "Live text may be provisional. Durable memory uses final/corrected consented turns only.",
      },
    }, null, 2),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

function normalizeCodingSessionProviders(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const providers = {
    openai: input.openai !== false,
    anthropic: input.anthropic !== false,
  };
  if (!providers.openai && !providers.anthropic) {
    throw new Error("Select at least one Coding Agent Sessions source.");
  }
  return providers;
}

function buildCodingSessionsAgentInstall(configPath, userId, overrides = {}) {
  const channel = cliChannel(overrides.channel);
  const safeId = safeFileId(userId);
  const label = `ai.shepherd.${channelLabelPrefix(channel)}coding-sessions.${safeId}`;
  const rawDir = join(homedir(), ".shepherd", "coding-sessions");
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${label}.plist`);
  const stdoutPath = join(rawDir, `${channelFilePrefix(channel)}${safeId}.out.log`);
  const stderrPath = join(rawDir, `${channelFilePrefix(channel)}${safeId}.err.log`);
  const programPrefix = Array.isArray(overrides.programArguments) && overrides.programArguments.length > 0
    ? overrides.programArguments
    : ["/usr/bin/env", "npx", "-y", PACKAGE_SPEC, "coding-sessions-agent"];
  const programArguments = [...programPrefix, "--config", configPath];
  const environment = {
    PATH: launchAgentPath(),
    ...stringRecord(overrides.environment),
  };

  const programArgumentsXml = programArguments
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(rawDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
</dict>
</plist>
`;

  return { label, rawDir, agentsDir, plistPath, stdoutPath, stderrPath, channel, programArguments, environment, plist };
}

function buildOfficeAudioAgentInstall(configPath, userId, overrides = {}) {
  const channel = cliChannel(overrides.channel);
  const safeId = safeFileId(userId);
  const label = `ai.shepherd.${channelLabelPrefix(channel)}office-audio.${safeId}`;
  const rawDir = join(homedir(), ".shepherd", "office-audio");
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${label}.plist`);
  const stdoutPath = join(rawDir, `${channelFilePrefix(channel)}${safeId}.out.log`);
  const stderrPath = join(rawDir, `${channelFilePrefix(channel)}${safeId}.err.log`);
  const programPrefix = Array.isArray(overrides.programArguments) && overrides.programArguments.length > 0
    ? overrides.programArguments
    : ["/usr/bin/env", "npx", "-y", PACKAGE_SPEC, "office-audio-agent"];
  const programArguments = [...programPrefix, "--config", configPath];
  const environment = {
    PATH: launchAgentPath(),
    ...stringRecord(overrides.environment),
  };

  const programArgumentsXml = programArguments
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(rawDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
</dict>
</plist>
`;

  return { label, rawDir, agentsDir, plistPath, stdoutPath, stderrPath, channel, programArguments, environment, plist };
}

async function installCodingSessionsAgent(configPath, userId, overrides = {}) {
  if (platform() !== "darwin") {
    throw new Error("automatic local coding-session sync is only supported on macOS");
  }

  const install = buildCodingSessionsAgentInstall(configPath, userId, overrides);
  const { label, rawDir, agentsDir, plistPath, stdoutPath, stderrPath, plist } = install;
  await mkdir(rawDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });

  await writeFile(plistPath, plist, { mode: 0o600 });
  await chmod(plistPath, 0o600);
  const stdoutOffset = await fileLength(stdoutPath);
  const stderrOffset = await fileLength(stderrPath);
  await execFileQuiet("launchctl", ["unload", plistPath], { ignoreError: true });
  await execFileQuiet("launchctl", ["load", plistPath]);
  await execFileQuiet("launchctl", ["start", label], { ignoreError: true });
  await verifyCodingSessionsAgentLaunch({ label, stdoutPath, stderrPath, stdoutOffset, stderrOffset });
  return install;
}

async function installOfficeAudioAgent(configPath, userId, overrides = {}) {
  if (platform() !== "darwin") {
    throw new Error("automatic Office Audio sync is only supported on macOS");
  }
  const install = buildOfficeAudioAgentInstall(configPath, userId, overrides);
  const { label, rawDir, agentsDir, plistPath, stdoutPath, stderrPath, plist } = install;
  await mkdir(rawDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  await writeFile(plistPath, plist, { mode: 0o600 });
  await chmod(plistPath, 0o600);
  const stdoutOffset = await fileLength(stdoutPath);
  const stderrOffset = await fileLength(stderrPath);
  await execFileQuiet("launchctl", ["unload", plistPath], { ignoreError: true });
  await execFileQuiet("launchctl", ["load", plistPath]);
  await execFileQuiet("launchctl", ["start", label], { ignoreError: true });
  await verifyOfficeAudioAgentLaunch({ label, stdoutPath, stderrPath, stdoutOffset, stderrOffset });
  return install;
}

async function verifyCodingSessionsAgentLaunch({ label, stdoutPath, stderrPath, stdoutOffset, stderrOffset }) {
  const domainLabel = `gui/${process.getuid?.() ?? 501}/${label}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(1000);
    const stdout = await readFileFrom(stdoutPath, stdoutOffset);
    const stderr = await readFileFrom(stderrPath, stderrOffset);
    const launchState = readLaunchctlPrint(domainLabel);

    if (/Shepherd Coding Sessions sync starting|Coding session scan/i.test(stdout)
      && /state = running|job state = running/i.test(launchState)) {
      return;
    }
    if (/EACCES|operation not permitted|permission denied/i.test(stderr)) {
      throw new Error("Coding-session sync could not read ~/.codex or ~/.claude. Grant the onboarding app access to those folders or run coding-sessions-status for details.");
    }
    if (/last exit code = [1-9]|job state = exited|state = spawn scheduled/i.test(launchState) && stderr.trim()) {
      throw new Error(`Coding-session sync exited during startup: ${firstMeaningfulLine(stderr)}`);
    }
  }

  throw new Error("Coding-session sync did not reach a healthy launchd running state. Check logs under ~/.shepherd/coding-sessions and run coding-sessions-status.");
}

async function verifyOfficeAudioAgentLaunch({ label, stdoutPath, stderrPath, stdoutOffset, stderrOffset }) {
  const domainLabel = `gui/${process.getuid?.() ?? 501}/${label}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(1000);
    const stdout = await readFileFrom(stdoutPath, stdoutOffset);
    const stderr = await readFileFrom(stderrPath, stderrOffset);
    if (/Shepherd Office Audio agent starting/i.test(stdout)) return true;
    if (/Error|failed/i.test(stderr)) throw new Error(stderr.trim().slice(-1000));
    const print = await execFileQuiet("launchctl", ["print", domainLabel], { ignoreError: true, capture: true });
    if (print?.stdout && /state = running|job state = running/i.test(print.stdout)) return true;
  }
  throw new Error("Office Audio LaunchAgent did not start. Check the office-audio .err.log for details.");
}

async function verifyMessagesAgentLaunch({ label, stdoutPath, stderrPath, stdoutOffset, stderrOffset }) {
  const domainLabel = `gui/${process.getuid?.() ?? 501}/${label}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(1500);

    const stdout = await readFileFrom(stdoutPath, stdoutOffset);
    const stderr = await readFileFrom(stderrPath, stderrOffset);
    const launchState = readLaunchctlPrint(domainLabel);

    if (/Failed to open database|unable to open database file/i.test(stderr)) {
      throw new Error("Messages background sync could not open local Messages storage. Grant macOS Full Disk Access to the app running onboarding and Node.js, then rerun or continue the Messages step.");
    }

    if (/Messages local database access validated|Watching for new Messages/i.test(stdout)
      && /state = running|job state = running/i.test(launchState)) {
      return;
    }

    if (/last exit code = [1-9]|job state = exited|state = spawn scheduled/i.test(launchState) && stderr.trim()) {
      throw new Error(`Messages background sync exited during startup: ${firstMeaningfulLine(stderr)}`);
    }
  }

  throw new Error("Messages background sync did not reach a healthy launchd running state. Check the Messages sync logs under ~/.shepherd/raw-messages and rerun or continue the Messages step.");
}

function isMessagesStoragePermissionError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /local Messages storage|Full Disk Access|Failed to open database|unable to open database/i.test(message);
}

function readLaunchctlPrint(domainLabel) {
  try {
    return execFileSync("launchctl", ["print", domainLabel], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  } catch (err) {
    return err?.stdout?.toString?.() ?? err?.stderr?.toString?.() ?? "";
  }
}

async function fileLength(path) {
  try {
    return (await readFile(path)).length;
  } catch {
    return 0;
  }
}

async function readFileFrom(path, offset) {
  try {
    const contents = await readFile(path, "utf8");
    return contents.slice(offset);
  } catch {
    return "";
  }
}

function firstMeaningfulLine(value) {
  return String(value)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "unknown error";
}

function launchAgentPath() {
  const paths = [
    dirname(process.execPath),
    ...String(process.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  return [...new Set(paths)].join(":");
}

async function selectRecentMessageChats() {
  const explicitIds = parseMessageChatIdsArg();
  if (explicitIds.length > 0) {
    return explicitIds.map((chatId) => ({ chatId, label: chatId, kind: "unknown", participants: [] }));
  }

  if (!process.stdin.isTTY) {
    throw new Error(`Messages sync requires selected chat IDs. Run ${agentCommand()} messages-chats and pass --messages-chat-ids "<id1>,<id2>" or --messages-chat-ids all.`);
  }

  const chats = await listRecentMessageChats({
    limit: clampInt(Number(args.limit ?? DEFAULT_MESSAGE_CHAT_SEARCH_LIMIT), 1, 500),
    search: stringArg("search") ?? stringArg("query"),
  });
  if (chats.length === 0) {
    throw new Error("No recent local Messages chats were found on this Mac.");
  }

  if (!args.text && !args.list) {
    return selectChatsInBrowser(chats, { noOpen: Boolean(args["no-open"]) });
  }

  console.log(`\nSelect local Messages chats to sync\n`);
  console.log("Shepherd will only pull from the chats you select.");
  console.log("Enter all to sync every current chat and keep watching future new chats.");
  for (let i = 0; i < chats.length; i++) {
    console.log(`${String(i + 1).padStart(2, " ")}. ${formatMessageChatOption(chats[i])}`);
  }

  const answer = await prompt("\nEnter chat numbers to sync, separated by commas, or all: ");
  if (String(answer ?? "").trim().toLowerCase() === "all") return [allMessagesChatsSelection()];
  const indexes = parseSelectionIndexes(answer, chats.length);
  if (indexes.length === 0) throw new Error("Select at least one Messages chat.");
  return indexes.map((idx) => chats[idx]);
}

async function selectChatsInBrowser(chats, opts = {}) {
  if (!chats.length) throw new Error("No recent local Messages chats were found on this Mac.");

  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  let settled = false;
  let selectorUrl = "";
  let server;
  const sockets = new Set();

  return new Promise((resolve, reject) => {
    const closeSelectorServer = () => {
      server?.close();
      server?.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    };

    const finishBrowserSelection = () => {
      if (opts.noOpen || !selectorUrl) {
        closeSelectorServer();
        return;
      }
      setTimeout(() => {
        void closeLocalBrowserUrl(selectorUrl);
      }, 250);
      setTimeout(closeSelectorServer, 1000);
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      closeSelectorServer();
      reject(new Error("Messages chat selection timed out."));
    }, 20 * 60 * 1000);

    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

        if (req.method === "GET" && url.pathname === "/") {
          sendHtml(res, renderMessagesSelectorPage(chats, token));
          return;
        }

        if (req.method === "POST" && url.pathname === "/select") {
          const body = await readRequestBody(req);
          const form = new URLSearchParams(body);
          if (form.get("token") !== token) {
            sendHtml(res, renderMessagesDonePage("Invalid selection session.", true), 403);
            return;
          }
          if (form.get("allChats") === "1") {
            if (!settled) res.once("finish", finishBrowserSelection);
            sendHtml(res, renderMessagesDonePage("All current and future chats selected."));
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve([allMessagesChatsSelection()]);
            }
            return;
          }
          const selectedIds = form.getAll("chatId").filter(Boolean);
          const selectedSet = new Set(selectedIds);
          const selected = chats.filter((chat) => selectedSet.has(chat.chatId));
          if (selected.length === 0) {
            sendHtml(res, renderMessagesSelectorPage(chats, token, "Select at least one chat."));
            return;
          }

          if (!settled) res.once("finish", finishBrowserSelection);
          sendHtml(res, renderMessagesDonePage(`${selected.length} chat${selected.length === 1 ? "" : "s"} selected.`));
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve(selected);
          }
          return;
        }

        sendHtml(res, renderMessagesDonePage("Not found.", true), 404);
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          closeSelectorServer();
          reject(err);
        }
      }
    });

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeSelectorServer();
      reject(err);
    });

    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      if (!port) {
        settled = true;
        clearTimeout(timeout);
        closeSelectorServer();
        reject(new Error("Could not start local Messages selector."));
        return;
      }
      selectorUrl = `http://127.0.0.1:${port}/`;
      console.log(`\nOpening Messages chat selector: ${selectorUrl}`);
      await openOrPrint(selectorUrl, { noOpen: Boolean(opts.noOpen) });
      console.log("Select the Messages chats to sync in the browser.");
    });
  });
}

function renderMessagesSelectorPage(chats, token, error = "") {
  const logo = shepherdLogoDataUri();
  const rows = chats.map((chat, index) => {
    const people = chatPeopleLine(chat);
    const when = formatMessageChatMeta(chat);
    const searchText = [
      chat.label,
      chat.kind,
      people,
      when,
      ...(chat.participants ?? []).flatMap((participant) => [participant.name, participant.handle]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const kindKey = chat.kind === "group" ? "group" : chat.kind === "dm" ? "dm" : "other";
    const kindLabel = kindKey === "group" ? "Group" : kindKey === "dm" ? "Contact" : "Chat";
    return `
      <label class="chat-row" data-index="${index}" data-search="${htmlAttr(searchText)}">
        <input type="checkbox" name="chatId" value="${htmlAttr(chat.chatId)}">
        <span class="box" aria-hidden="true"></span>
        <span class="chat-name-block">
          <span class="chat-name">${html(chat.label)}</span>
          ${people ? `<span class="chat-people">${html(people)}</span>` : ""}
        </span>
        <span class="chat-kind chat-kind--${kindKey}">${html(kindLabel)}</span>
        <span class="chat-meta">${when ? html(when) : "—"}</span>
      </label>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Select Messages Chats</title>
  <style>
    :root {
      --bg: #ffffff;
      --fg: #141614;
      --muted: #615d59;
      --faint: #a39e98;
      --line: #e6e6e6;
      --green: #1f5c2e;
      --green-hover: #246836;
      --radius: 8px;
      --grid: 20px minmax(0, 1fr) 76px 108px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--fg);
      font-family: Geist, "Geist Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      -webkit-font-smoothing: antialiased;
    }
    main {
      width: min(640px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 56px 0 28px;
    }
    .header {
      display: grid;
      justify-items: center;
      text-align: center;
      padding: 0 0 28px;
    }
    .brand {
      display: grid;
      justify-items: center;
      gap: 16px;
      min-width: 0;
    }
    .logo {
      width: 30px;
      height: 30px;
      object-fit: contain;
    }
    .logo-fallback {
      width: 30px;
      height: 30px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      color: #FFFFFF;
      background: var(--green);
      font-size: 13px;
      font-weight: 700;
      flex: none;
    }
    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.1;
      font-weight: 700;
      letter-spacing: 0;
    }
    .subtitle {
      margin: 8px 0 0;
      font-size: 14px;
      line-height: 1.4;
      color: var(--muted);
    }
    .panel {
      background: transparent;
    }
    .panel-head {
      padding: 0 0 18px;
    }
    .search {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      color: var(--fg);
      padding: 12px 13px;
      font: inherit;
      font-size: 15px;
      outline: none;
    }
    .search:focus {
      border-color: var(--green);
      outline: 2px solid color-mix(in srgb, var(--green) 22%, transparent);
      outline-offset: 1px;
    }
    .search::placeholder { color: var(--faint); }
    .all-chats {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
      margin-top: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      cursor: pointer;
      background: #fbfbfa;
    }
    .all-chats:hover { border-color: var(--green); }
    .all-title {
      display: block;
      font-size: 14px;
      font-weight: 600;
    }
    .all-copy {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: 12.5px;
      line-height: 1.35;
    }
    .error {
      margin: 0 0 12px;
      color: #9B1C1C;
      font-size: 13px;
    }
    .list-head {
      display: grid;
      grid-template-columns: var(--grid);
      gap: 12px;
      align-items: center;
      padding: 9px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      color: var(--faint);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .list-head .right { text-align: left; }
    .chat-list { display: block; }
    .chat-row {
      display: grid;
      grid-template-columns: var(--grid);
      gap: 12px;
      align-items: center;
      padding: 11px 0;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
      transition: background 120ms ease;
    }
    .chat-row:hover { background: #f6f5f4; }
    input[type="checkbox"] {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .box {
      width: 18px;
      height: 18px;
      border: 1.5px solid #C7CDC8;
      border-radius: 4px;
      display: inline-grid;
      place-items: center;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .chat-row:hover .box { border-color: var(--green); }
    input[type="checkbox"]:checked + .box {
      background: var(--green);
      border-color: var(--green);
    }
    input[type="checkbox"]:checked + .box::after {
      content: "";
      width: 7px;
      height: 4px;
      border-left: 2px solid #FFFFFF;
      border-bottom: 2px solid #FFFFFF;
      transform: rotate(-45deg) translateY(-1px);
    }
    .chat-name-block {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    .chat-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 15px;
      font-weight: 500;
    }
    .chat-people {
      color: var(--muted);
      font-size: 12.5px;
      line-height: 1.3;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-kind {
      justify-self: start;
      color: var(--muted);
      font-size: 12.5px;
      font-weight: 400;
    }
    .chat-kind--group { color: var(--fg); }
    .chat-meta {
      color: var(--muted);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    [hidden] { display: none !important; }
    .empty {
      margin: 0;
      padding: 26px 12px;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }
    .actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      position: sticky;
      bottom: 0;
      margin-top: 16px;
      padding: 12px 0 0;
      background: var(--bg);
    }
    .selection-count {
      color: var(--muted);
      font-size: 13px;
      font-weight: 500;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 8px;
      background: var(--green);
      color: #FFFFFF;
      padding: 9px 13px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: background 120ms ease;
    }
    button:hover { background: var(--green-hover); }
    @media (max-width: 560px) {
      :root { --grid: 18px minmax(0, 1fr) auto; }
      .list-head span:last-child,
      .chat-meta { display: none; }
    }
  </style>
</head>
<body>
  <main>
    <header class="header">
      <div class="brand">
        ${logo ? `<img class="logo" src="${htmlAttr(logo)}" alt="">` : `<span class="logo-fallback" aria-hidden="true">S</span>`}
        <div>
          <h1>Select chats</h1>
          <p class="subtitle">Choose which local Messages chats Shepherd should sync.</p>
        </div>
      </div>
    </header>
    <form method="post" action="/select">
      <input type="hidden" name="token" value="${htmlAttr(token)}">
      <div class="panel">
        <div class="panel-head">
          <input class="search" id="search" type="search" placeholder="Search contacts or groups" autocomplete="off">
          <label class="all-chats">
            <input type="checkbox" id="all-chats" name="allChats" value="1">
            <span class="box" aria-hidden="true"></span>
            <span>
              <span class="all-title">Sync all current and future chats</span>
              <span class="all-copy">Backfill every current Messages chat and keep watching chats that appear later.</span>
            </span>
          </label>
        </div>
        ${error ? `<p class="error">${html(error)}</p>` : ""}
        <div class="list-head">
          <span></span>
          <span>Name</span>
          <span>Type</span>
          <span class="right">Last message</span>
        </div>
        <div class="chat-list">${rows}</div>
        <p class="empty" id="empty" hidden>No chats found.</p>
      </div>
      <div class="actions">
        <span class="selection-count" id="selection-count">0 selected</span>
        <button type="submit">Return</button>
      </div>
    </form>
  </main>
  <script>
    const initialRows = ${INITIAL_MESSAGE_CHAT_ROWS};
    const rows = Array.from(document.querySelectorAll(".chat-row"));
    const search = document.getElementById("search");
    const empty = document.getElementById("empty");
    const selected = document.getElementById("selection-count");
    const form = document.querySelector("form");
    const checks = Array.from(document.querySelectorAll('input[name="chatId"]'));
    const allChats = document.getElementById("all-chats");

    function updateRows() {
      const query = search.value.trim().toLowerCase();
      let visible = 0;
      for (const row of rows) {
        const matches = query
          ? row.dataset.search.includes(query)
          : Number(row.dataset.index) < initialRows;
        row.hidden = !matches;
        if (matches) visible += 1;
      }
      empty.hidden = visible !== 0;
    }

    function updateSelected() {
      if (allChats.checked) {
        selected.textContent = "All current and future chats";
        for (const check of checks) check.disabled = true;
        return;
      }
      for (const check of checks) check.disabled = false;
      const count = checks.filter((check) => check.checked).length;
      selected.textContent = count + " selected";
    }

    search.addEventListener("input", updateRows);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      form.requestSubmit();
    });
    allChats.addEventListener("change", updateSelected);
    for (const check of checks) check.addEventListener("change", updateSelected);
    updateRows();
    updateSelected();
  </script>
</body>
</html>`;
}

function renderMessagesDonePage(message, isError = false) {
  const closeScript = isError ? "" : `<script>
    setTimeout(() => {
      window.open("", "_self");
      window.close();
    }, 150);
  </script>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Messages Selection</title>
  <style>
    :root { color-scheme: light dark; --bg: #FCFCFC; --fg: #111; --muted: #6D726D; --button: #136033; --button-text: #FFFFFF; --radius: 10px; }
    @media (prefers-color-scheme: dark) { :root { --bg: #000; --fg: #F8F8F8; --muted: #A2A8A2; --button: #FFFFFF; --button-text: #000; } }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font-family: Geist, "Geist Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    main { width: min(420px, calc(100vw - 32px)); }
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.1; font-weight: 650; }
    p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; }
    .mark { width: 34px; height: 34px; border-radius: var(--radius); display: grid; place-items: center; margin-bottom: 14px; background: var(--button); color: var(--button-text); font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <div class="mark">${isError ? "!" : "OK"}</div>
    <h1>${html(message)}</h1>
    <p>${isError ? "Return to the terminal and retry." : "Returning to the terminal."}</p>
  </main>
  ${closeScript}
</body>
</html>`;
}

async function closeLocalBrowserUrl(urlPrefix) {
  if (platform() !== "darwin") return;

  await execFileQuiet("osascript", [
    "-e", "on run argv",
    "-e", "set targetUrl to item 1 of argv",
    "-e", "set browserIds to {\"com.apple.Safari\", \"com.google.Chrome\", \"com.microsoft.edgemac\", \"com.brave.Browser\", \"company.thebrowser.Browser\", \"com.vivaldi.Vivaldi\", \"com.operasoftware.Opera\"}",
    "-e", "repeat with browserId in browserIds",
    "-e", "try",
    "-e", "tell application id browserId",
    "-e", "repeat with browserWindow in windows",
    "-e", "repeat with browserTab in tabs of browserWindow",
    "-e", "try",
    "-e", "if (URL of browserTab starts with targetUrl) then close browserTab",
    "-e", "end try",
    "-e", "end repeat",
    "-e", "end repeat",
    "-e", "end tell",
    "-e", "end try",
    "-e", "end repeat",
    "-e", "end run",
    urlPrefix,
  ], { ignoreError: true });
}

function renderChatPeople(chat) {
  const people = chatPeopleLine(chat);
  if (!people) return "";
  return `<span class="chat-people">${html(people)}</span>`;
}

function chatPeopleLine(chat) {
  if (chat.kind !== "group") return "";
  const names = chat.participants
    ?.map((participant) => participant.name)
    .filter((name) => name && !looksLikeHandleList(name)) ?? [];
  const line = names.slice(0, 6).join(", ");
  if (!line || normalizeDisplayText(line) === normalizeDisplayText(chat.label)) return "";
  return line;
}

function formatMessageChatMeta(chat) {
  return formatShortChatTime(chat.lastMessageAt);
}

function formatShortChatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / (24 * 60 * 60 * 1000));
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(date)
    .replace(":00", "")
    .replace(/\s/g, "")
    .toLowerCase();

  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays >= 0 && diffDays < 7) {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
    return `${weekday} ${time}`;
  }
  const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  return `${monthDay} ${time}`;
}

function normalizeDisplayText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function shepherdLogoDataUri() {
  try {
    const bytes = readFileSync(SHEPHERD_LOGO_PATH);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function sendHtml(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "close",
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function listRecentMessageChats({ limit, search, contactLookup = buildContactLookup() }) {
  if (platform() !== "darwin") {
    throw new Error("local Messages chat discovery is only supported on macOS");
  }

  const kit = await import("@photon-ai/imessage-kit");
  const sdk = new kit.IMessageSDK({ debug: args.debug === true });
  const query = typeof search === "string" ? search.trim() : "";
  try {
    const chats = [...await sdk.listChats({
      sortBy: "recent",
      limit: Math.max(limit, INITIAL_MESSAGE_CHAT_ROWS),
      ...(query ? { search: query } : {}),
    })];

    if (query) {
      const matchingHandles = typeof contactLookup.searchHandles === "function"
        ? contactLookup.searchHandles(query).slice(0, Math.max(limit, 25))
        : [];
      for (const handle of matchingHandles) {
        const matches = await sdk.listChats({ chatId: handle, kind: "dm", limit: 5 }).catch(() => []);
        chats.push(...matches);
      }
    }

    const candidates = dedupeMessageChats(chats)
      .filter((chat) => typeof chat.chatId === "string" && chat.chatId.trim())
      .filter((chat) => chat.kind === "dm" || chat.kind === "group");

    return await enrichMessageChatCandidates(sdk, candidates, contactLookup, { limit, query });
  } finally {
    await sdk.close?.().catch(() => undefined);
  }
}

async function enrichMessageChatCandidates(sdk, candidates, contactLookup, { limit, query = "" } = {}) {
  const enriched = [];
  const max = Math.max(1, Number(limit) || DEFAULT_MESSAGE_CHAT_SEARCH_LIMIT);
  for (let index = 0; index < candidates.length && enriched.length < max; index += MESSAGE_CHAT_ENRICH_CONCURRENCY) {
    const chunk = candidates.slice(index, index + MESSAGE_CHAT_ENRICH_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (chat) => {
      const candidate = await enrichMessageChat(sdk, chat, contactLookup);
      if (messageChatTouchesShepherdAgent(candidate)) return null;
      if (query && !messageChatMatchesSearch(candidate, query)) return null;
      return candidate;
    }));
    for (const result of results) {
      if (!result) continue;
      enriched.push(result);
      if (enriched.length >= max) break;
    }
  }
  return enriched;
}

function dedupeMessageChats(chats) {
  const byId = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (typeof chat?.chatId !== "string" || !chat.chatId.trim()) continue;
    if (!byId.has(chat.chatId)) byId.set(chat.chatId, chat);
  }
  return [...byId.values()];
}

function messageChatMatchesSearch(chat, query) {
  const searchable = [
    chat.label,
    chat.kind,
    chat.service,
    chat.chatId,
    ...(chat.participants ?? []).flatMap((participant) => [participant.name, participant.handle]),
  ].filter(Boolean).join(" ");
  return searchTextMatches(searchable, query);
}

async function loadSelectedMessageChatsForConfig(chatIds, contactLookup = buildContactLookup()) {
  const allowedChatIds = parseAllowedChatIds(chatIds);
  if (allowedChatIds.length === 0 || selectedChatIdsIncludeAll(allowedChatIds)) return [];
  if (platform() !== "darwin") return [];

  const kit = await import("@photon-ai/imessage-kit");
  const sdk = new kit.IMessageSDK({ debug: args.debug === true });
  try {
    const listedChats = typeof sdk.listChats === "function"
      ? await sdk.listChats({ sortBy: "recent", limit: 5_000 }).catch(() => [])
      : [];
    const byId = new Map(listedChats
      .filter((chat) => typeof chat?.chatId === "string")
      .map((chat) => [chat.chatId, chat]));

    const selected = [];
    for (const chatId of allowedChatIds) {
      const listed = byId.get(chatId);
      const fallback = {
        chatId,
        kind: parseDmHandleFromChatId(chatId) ? "dm" : "group",
        name: null,
        service: null,
        lastMessageAt: null,
      };
      const candidate = await enrichMessageChat(sdk, { ...fallback, ...listed, chatId }, contactLookup);
      if (!messageChatTouchesShepherdAgent(candidate)) selected.push(candidate);
    }
    return selected;
  } finally {
    await sdk.close?.().catch(() => undefined);
  }
}

async function enrichMessageChat(sdk, chat, contactLookup) {
  const chatName = cleanChatName(chat.name);
  const parsedDmHandle = chat.kind === "dm" ? parseDmHandleFromChatId(chat.chatId) : null;
  if (parsedDmHandle) {
    const dmName = contactLookup.resolveName(parsedDmHandle);
    const participants = contactLookup.isSelfHandle(parsedDmHandle) || isShepherdAgentMessageHandle(parsedDmHandle)
      ? []
      : [{ handle: parsedDmHandle, name: dmName }];
    return {
      chatId: chat.chatId,
      label: dmName ?? nonHandleChatName(chatName) ?? parsedDmHandle ?? "Contact",
      kind: chat.kind ?? "unknown",
      service: chat.service ?? null,
      lastMessageAt: isoDate(chat.lastMessageAt),
      participants,
    };
  }

  const recentMessages = await sdk.getMessages({ chatId: chat.chatId, limit: 30 }).catch(() => []);
  const participants = uniqueParticipants(recentMessages, contactLookup);
  const dmHandle = chat.kind === "dm"
    ? participants[0]?.handle ?? parsedDmHandle
    : null;
  const dmName = dmHandle ? contactLookup.resolveName(dmHandle) : null;
  const groupNames = participants.map((participant) => participant.name ?? participant.handle).filter(Boolean);
  const label = chat.kind === "dm"
    ? dmName ?? nonHandleChatName(chatName) ?? dmHandle ?? "Contact"
    : nonHandleChatName(chatName)
      ?? (groupNames.length ? groupNames.slice(0, 4).join(", ") : null)
      ?? "Group";

  return {
    chatId: chat.chatId,
    label,
    kind: chat.kind ?? "unknown",
    service: chat.service ?? null,
    lastMessageAt: isoDate(chat.lastMessageAt),
    participants,
  };
}

function uniqueParticipants(messages, contactLookup) {
  const seen = new Set();
  const participants = [];
  for (const msg of messages) {
    const handle = typeof msg.participant === "string" ? msg.participant.trim() : "";
    if (!handle || contactLookup.isSelfHandle(handle) || isShepherdAgentMessageHandle(handle)) continue;
    const normalized = normalizeHandle(handle);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    participants.push({
      handle,
      name: contactLookup.resolveName(handle),
    });
  }
  return participants;
}

function formatMessageChatOption(chat) {
  const kind = chat.kind === "group" ? "Group" : chat.kind === "dm" ? "Contact" : "Chat";
  const people = chatPeopleLine(chat);
  const when = formatMessageChatMeta(chat);
  return [chat.label, kind, people, when].filter(Boolean).join(" · ");
}

function publicMessageChat(chat) {
  return {
    chatId: chat.chatId,
    label: chat.label,
    kind: chat.kind,
    service: chat.service ?? null,
    lastMessageAt: chat.lastMessageAt ?? null,
    participants: Array.isArray(chat.participants) ? chat.participants : [],
  };
}

function allMessagesChatsSelection() {
  return {
    chatId: ALL_MESSAGES_CHATS,
    label: "All current and future chats",
    kind: "all",
    service: null,
    lastMessageAt: null,
    participants: [],
  };
}

function selectedIncludesAllChats(chats) {
  return Array.isArray(chats) && chats.some((chat) => chat?.chatId === ALL_MESSAGES_CHATS);
}

async function loadGroupChatNames(sdk, serializer) {
  if (typeof sdk.listChats !== "function") return;
  try {
    const chats = await sdk.listChats({ kind: "group" });
    for (const chat of chats) {
      if (chat.chatId && chat.name) serializer.setChatName(chat.chatId, chat.name);
    }
    console.log(`Loaded ${chats.length} group chat names`);
  } catch (err) {
    console.error("Could not load group chat names:", err instanceof Error ? err.message : err);
  }
}

function loadSelectedChatNames(selectedChats, serializer) {
  if (!Array.isArray(selectedChats)) return;
  for (const chat of selectedChats) {
    if (chat && typeof chat.chatId === "string" && typeof chat.label === "string") {
      serializer.setChatName(chat.chatId, chat.label);
    }
  }
}

function selectedChatContactSeedHandles(selectedChats, allowedChatIds) {
  const handles = [];
  for (const chatId of allowedChatIds ?? []) {
    const dmHandle = parseDmHandleFromChatId(chatId);
    if (dmHandle && !isShepherdAgentMessageHandle(dmHandle)) handles.push(dmHandle);
  }
  for (const chat of Array.isArray(selectedChats) ? selectedChats : []) {
    for (const participant of Array.isArray(chat?.participants) ? chat.participants : []) {
      if (
        typeof participant?.handle === "string"
        && participant.handle.trim()
        && !isShepherdAgentMessageHandle(participant.handle)
      ) {
        handles.push(participant.handle);
      }
    }
  }
  return [...new Set(handles)];
}

async function validateMessagesDatabaseAccess(sdk) {
  await sdk.getMessages({ limit: 1 });
}

function messagesBackfillScope({ backfillDays, allChats, allowedChatIds }) {
  return {
    version: 1,
    backfillDays: backfillDays == null ? "all" : backfillDays,
    scope: allChats
      ? { allChats: true }
      : { chatIds: [...allowedChatIds].sort() },
  };
}

function shouldRunMessagesBackfill({ backfillDays, backfillExplicit, backfillComplete }) {
  if (backfillDays === 0) return false;
  if (backfillExplicit) return true;
  return !backfillComplete;
}

async function runMessagesBackfill(sdk, sender, serializer, days, allowedChatIds, contactSync = null, stateCache = null, options = {}) {
  const allChats = allowedChatIds == null;
  const backfillScope = messagesBackfillScope({ backfillDays: days, allChats, allowedChatIds: allowedChatIds ?? [] });
  console.log(allChats
    ? `Running ${days == null ? "all-history" : `${days}-day`} Messages backfill for all current chats`
    : `Running ${days == null ? "all-history" : `${days}-day`} Messages backfill for ${allowedChatIds.length} selected chat(s)`);
  const since = options.since instanceof Date
    ? options.since
    : days == null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pageSize = 1000;
  const estimatedTotalMessages = await estimateMessagesBackfillTotal(sdk, { since, allowedChatIds });
  const progress = createMessagesBackfillProgress({
    userId: sender.userId,
    scope: backfillScope,
    allChats,
    chatCount: allChats ? null : allowedChatIds.length,
    since,
    estimatedTotalMessages,
  });
  progress.reporter = sender;
  let totalMessages = 0;
  let totalStored = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  if (allChats) {
    const progressKey = messagesBackfillProgressKey(null);
    while (true) {
      const cursor = loadMessagesBackfillProgressCursor(sender.userId, backfillScope, progressKey);
      const messages = await sdk.getMessages({
        ...(since ? { since } : {}),
        sinceRowId: cursor,
        orderByRowIdAsc: true,
        limit: pageSize,
      });
      if (!messages.length) break;
      const filtered = messages.filter((msg) => !messageTouchesShepherdAgent(msg));

      contactSync?.observeMessages(filtered);
      totalMessages += filtered.length;
      const result = await sender.send(filtered.map((msg) => serializer.serialize(msg)));
      totalStored += countValue(result.stored);
      totalUpdated += countValue(result.updated);
      totalSkipped += countValue(result.skipped);
      updateMessagesBackfillProgress(progress, { totalMessages, totalStored, totalUpdated, totalSkipped, queued: result.queued });
      if ((result.queued ?? 0) > 0) {
        finishMessagesBackfillProgress(progress, { status: "paused", totalMessages, totalStored, totalUpdated, totalSkipped, queued: result.queued });
        return { complete: false, totalMessages, totalStored, totalUpdated, totalSkipped, queued: result.queued };
      }
      stateCache?.observe(filtered);
      const pageMaxRowId = maxRowId(messages);
      saveMessagesBackfillProgressCursor(sender.userId, backfillScope, progressKey, pageMaxRowId);
      saveMessagesWatermark(sender.userId, pageMaxRowId);

      if (messages.length < pageSize) break;
    }

    console.log(`Messages backfill complete: stored ${totalStored} of ${totalMessages}`);
    finishMessagesBackfillProgress(progress, { status: "complete", totalMessages, totalStored, totalUpdated, totalSkipped, queued: 0 });
    return { complete: true, totalMessages, totalStored, totalUpdated, totalSkipped, queued: 0, watermark: loadMessagesWatermark(sender.userId) };
  }

  for (const chatId of allowedChatIds) {
    const progressKey = messagesBackfillProgressKey(chatId);
    while (true) {
      const cursor = loadMessagesBackfillProgressCursor(sender.userId, backfillScope, progressKey);
      const messages = await sdk.getMessages({
        chatId,
        ...(since ? { since } : {}),
        sinceRowId: cursor,
        orderByRowIdAsc: true,
        limit: pageSize,
      });
      if (!messages.length) break;
      const filtered = messages.filter((msg) => !messageTouchesShepherdAgent(msg));

      contactSync?.observeMessages(filtered);
      totalMessages += filtered.length;
      const result = await sender.send(filtered.map((msg) => serializer.serialize(msg)));
      totalStored += countValue(result.stored);
      totalUpdated += countValue(result.updated);
      totalSkipped += countValue(result.skipped);
      updateMessagesBackfillProgress(progress, { totalMessages, totalStored, totalUpdated, totalSkipped, queued: result.queued });
      if ((result.queued ?? 0) > 0) {
        finishMessagesBackfillProgress(progress, { status: "paused", totalMessages, totalStored, totalUpdated, totalSkipped, queued: result.queued });
        return { complete: false, totalMessages, totalStored, totalUpdated, totalSkipped, queued: result.queued };
      }
      stateCache?.observe(filtered);
      const pageMaxRowId = maxRowId(messages);
      saveMessagesBackfillProgressCursor(sender.userId, backfillScope, progressKey, pageMaxRowId);
      saveMessagesWatermark(sender.userId, pageMaxRowId);

      if (messages.length < pageSize) break;
    }
  }

  console.log(`Messages backfill complete: stored ${totalStored} of ${totalMessages}`);
  finishMessagesBackfillProgress(progress, { status: "complete", totalMessages, totalStored, totalUpdated, totalSkipped, queued: 0 });
  return { complete: true, totalMessages, totalStored, totalUpdated, totalSkipped, queued: 0, watermark: loadMessagesWatermark(sender.userId) };
}

async function estimateMessagesBackfillTotal(sdk, { since, allowedChatIds }) {
  if (typeof sdk?.countMessages !== "function") return null;
  try {
    if (allowedChatIds == null) {
      return countValue(await sdk.countMessages({ ...(since ? { since } : {}) }));
    }
    let total = 0;
    for (const chatId of allowedChatIds) {
      total += countValue(await sdk.countMessages({ chatId, ...(since ? { since } : {}) }));
    }
    return total;
  } catch {
    return null;
  }
}

function createMessagesBackfillProgress({ userId, scope, allChats, chatCount, since, estimatedTotalMessages }) {
  return {
    userId,
    startedAtMs: Date.now(),
    lastLogAtMs: 0,
    lastReportAtMs: 0,
    reporter: null,
    record: {
      version: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      scope: publicMessagesBackfillScope(scope, { allChats, chatCount }),
      scopeKind: allChats ? "all_chats" : "selected_chats",
      chatCount,
      since: since ? since.toISOString() : null,
      estimatedTotalMessages,
      scannedMessages: 0,
      sentMessages: 0,
      storedMessages: 0,
      updatedMessages: 0,
      skippedMessages: 0,
      queuedMessages: 0,
      ratePerMinute: 0,
      etaSeconds: null,
    },
  };
}

function publicMessagesBackfillScope(scope, { allChats, chatCount }) {
  return {
    version: scope?.version ?? 1,
    backfillDays: scope?.backfillDays ?? "all",
    scope: allChats ? { allChats: true } : { selectedChatCount: chatCount },
  };
}

function publicMessagesBackfillStatus(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const chatCount = countValue(record.chatCount);
  const allChats = record.scopeKind === "all_chats" || record.scope?.scope?.allChats === true;
  return {
    ...record,
    scope: publicMessagesBackfillScope(record.scope, { allChats, chatCount }),
  };
}

function updateMessagesBackfillProgress(progress, { totalMessages, totalStored, totalUpdated, totalSkipped, queued = 0 }) {
  const sentMessages = countValue(totalStored) + countValue(totalUpdated) + countValue(totalSkipped);
  const elapsedSeconds = Math.max(0.001, (Date.now() - progress.startedAtMs) / 1000);
  const ratePerMinute = countValue(totalMessages) / elapsedSeconds * 60;
  const estimatedTotal = countValue(progress.record.estimatedTotalMessages);
  const remaining = estimatedTotal > countValue(totalMessages) && ratePerMinute > 0
    ? estimatedTotal - countValue(totalMessages)
    : 0;
  progress.record = {
    ...progress.record,
    updatedAt: new Date().toISOString(),
    scannedMessages: countValue(totalMessages),
    sentMessages,
    storedMessages: countValue(totalStored),
    updatedMessages: countValue(totalUpdated),
    skippedMessages: countValue(totalSkipped),
    queuedMessages: countValue(queued),
    ratePerMinute: Math.round(ratePerMinute),
    etaSeconds: remaining > 0 ? Math.ceil(remaining / (ratePerMinute / 60)) : null,
  };
  saveMessagesBackfillStatus(progress.userId, progress.record);
  reportMessagesBackfillProgress(progress, false);
  if (Date.now() - progress.lastLogAtMs >= 15_000 || countValue(queued) > 0) {
    progress.lastLogAtMs = Date.now();
    console.log(formatMessagesBackfillProgress(progress.record));
  }
}

function finishMessagesBackfillProgress(progress, { status, totalMessages, totalStored, totalUpdated, totalSkipped, queued = 0 }) {
  updateMessagesBackfillProgress(progress, { totalMessages, totalStored, totalUpdated, totalSkipped, queued });
  progress.record = {
    ...progress.record,
    status,
    finishedAt: new Date().toISOString(),
    etaSeconds: null,
  };
  saveMessagesBackfillStatus(progress.userId, progress.record);
  reportMessagesBackfillProgress(progress, true);
  console.log(formatMessagesBackfillProgress(progress.record));
}

function reportMessagesBackfillProgress(progress, force) {
  if (!progress.reporter || typeof progress.reporter.postLocalStatus !== "function") return;
  if (!force && Date.now() - progress.lastReportAtMs < 15_000) return;
  progress.lastReportAtMs = Date.now();
  progress.reporter.postLocalStatus(progress.record).catch((err) => {
    console.warn("Messages local status update failed:", safeError(err));
  });
}

function formatMessagesBackfillProgress(record) {
  const eta = record.etaSeconds == null ? "ETA unknown" : `ETA ${formatDuration(record.etaSeconds)}`;
  const total = record.estimatedTotalMessages == null ? "" : `/${record.estimatedTotalMessages}`;
  return `[messages-backfill] ${record.status}: scanned ${record.scannedMessages}${total}, sent ${record.sentMessages}, queued ${record.queuedMessages}, ${record.ratePerMinute}/min, ${eta}`;
}

async function gapFillFromWatermark(sdk, sender, serializer, userId, allowedChatIds, contactSync = null, stateCache = null) {
  const allChats = allowedChatIds == null;
  const lastWatermark = loadMessagesWatermark(userId);
  if (lastWatermark <= 0) return;

  let missed = [];
  if (allChats) {
    missed = await getMessagesAfterWatermark(sdk, { lastWatermark, pageSize: 1000 });
  } else {
    for (const chatId of allowedChatIds) {
      missed.push(...await getMessagesAfterWatermark(sdk, { chatId, lastWatermark, pageSize: 1000 }));
    }
  }
  const newMessages = missed.filter((msg) =>
    Number(msg.rowId) > lastWatermark
    && (allChats || allowedChatIds.includes(msg.chatId))
    && !messageTouchesShepherdAgent(msg));
  if (newMessages.length === 0) return;

  newMessages.sort((a, b) => Number(a.rowId ?? 0) - Number(b.rowId ?? 0));
  contactSync?.observeMessages(newMessages);
  const result = await sender.send(newMessages.map((msg) => serializer.serialize(msg)));
  if ((result.queued ?? 0) === 0) {
    stateCache?.observe(newMessages);
    saveMessagesWatermark(userId, maxRowId(newMessages));
  }
  console.log(`Messages gap-fill complete: stored ${result.stored} of ${newMessages.length}`);
}

async function getMessagesAfterWatermark(sdk, { chatId = null, lastWatermark, pageSize }) {
  const messages = [];
  let offset = 0;
  while (true) {
    const page = await sdk.getMessages({ ...(chatId ? { chatId } : {}), limit: pageSize, offset });
    if (!page.length) break;
    messages.push(...page.filter((msg) => Number(msg.rowId) > lastWatermark));
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return messages;
}

function startMessagesQueueDrain(sender, opts = {}) {
  const intervalMs = opts.intervalMs ?? MESSAGES_QUEUE_DRAIN_INTERVAL_MS;
  let stopped = false;
  let draining = false;

  const drain = async (reason) => {
    const depth = sender.queueDepth();
    if (stopped || draining || depth === 0) return;
    if (opts.deferWhen?.()) return;
    draining = true;
    const before = depth;
    try {
      const result = await sender.send([]);
      const after = sender.queueDepth();
      if (before > 0 && after !== before) {
        console.log(`Messages queue drain ${reason}: queued ${before} -> ${after}; stored ${result.stored ?? 0}, updated ${result.updated ?? 0}, skipped ${result.skipped ?? 0}`);
      }
      if (before > 0 && after === 0) {
        opts.onQueueDrained?.(reason);
      }
    } catch (err) {
      console.error("Messages queue drain failed:", safeError(err));
    } finally {
      draining = false;
    }
  };

  const interval = setInterval(() => {
    drain("interval").catch((err) => console.error("Messages queue drain failed:", safeError(err)));
  }, intervalMs);
  drain("startup").catch((err) => console.error("Messages queue drain failed:", safeError(err)));

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

function startMessagesBackfillMaintenance(opts) {
  if (!opts.enabled) return { stop() {}, kick() {} };

  const intervalMs = opts.intervalMs ?? MESSAGES_BACKFILL_RETRY_INTERVAL_MS;
  let stopped = false;
  let running = false;
  let interval = null;

  const stop = () => {
    stopped = true;
    if (interval) clearInterval(interval);
    interval = null;
  };

  const run = async (reason) => {
    if (stopped || running) return;
    if (loadMessagesBackfillComplete(opts.userId, opts.backfillScope)) {
      stop();
      return;
    }
    if (typeof opts.deferWhen === "function" && opts.deferWhen()) {
      console.log(`Messages backfill maintenance deferred (${reason}); remote command is pending`);
      return;
    }

    running = true;
    try {
      const gated = await runWithMessagesBackfillGate(opts.backfillGate, async () => {
        const result = await runMessagesBackfill(
          opts.sdk,
          opts.sender,
          opts.serializer,
          opts.backfillDays,
          opts.allChats ? null : opts.allowedChatIds,
          opts.contactSync,
          opts.stateCache,
        );
        return result;
      });
      if (gated.skipped) return;
      const result = gated.value;
      if (result.complete) {
        saveMessagesBackfillComplete(opts.userId, opts.backfillScope, result);
        console.log(`Messages backfill maintenance complete (${reason}); stored ${result.totalStored ?? 0} of ${result.totalMessages ?? 0}`);
        await gapFillFromWatermark(
          opts.sdk,
          opts.sender,
          opts.serializer,
          opts.userId,
          opts.allChats ? null : opts.allowedChatIds,
          opts.contactSync,
          opts.stateCache,
        );
        stop();
      } else {
        console.warn(`Messages backfill maintenance paused (${reason}); ${result.queued ?? 0} message(s) queued for retry`);
      }
    } catch (err) {
      console.error("Messages backfill maintenance failed:", safeError(err));
    } finally {
      running = false;
    }
  };

  interval = setInterval(() => {
    run("interval").catch((err) => console.error("Messages backfill maintenance failed:", safeError(err)));
  }, intervalMs);
  setTimeout(() => {
    run("startup").catch((err) => console.error("Messages backfill maintenance failed:", safeError(err)));
  }, 0);

  return {
    stop,
    kick(reason = "kick") {
      run(reason).catch((err) => console.error("Messages backfill maintenance failed:", safeError(err)));
    },
  };
}

function startMessagesCommandPoller(opts) {
  const intervalMs = opts.intervalMs ?? positiveIntFromEnv("SHEPHERD_MESSAGES_COMMAND_INTERVAL_MS", 60_000);
  let stopped = false;
  let running = false;

  const run = async (reason) => {
    if (stopped || running) return;
    running = true;
    let command = null;
    try {
      command = await opts.sender.fetchCommand();
      if (!command) {
        opts.onIdle?.();
        return;
      }
      if (command.type !== "messages_backfill_reset" && command.type !== "messages_source_sync") {
        console.warn(`Ignoring unsupported Messages agent command (${command.type ?? "unknown"})`);
        await opts.sender.ackCommand(command.id, { status: "failed", error: `Unsupported Messages agent command: ${command.type ?? "unknown"}` });
        opts.onCommandSettled?.(command);
        return;
      }

      if (command.type === "messages_source_sync") {
        const sourceSyncRunId = stringValue(command.sourceSyncRunId);
        const coverageTo = dateFromCommand(command.coverageTo);
        const coverageFromProvided = Object.prototype.hasOwnProperty.call(command, "coverageFrom");
        const coverageFrom = dateFromCommand(command.coverageFrom);
        if (!sourceSyncRunId || !coverageTo || (coverageFromProvided && command.coverageFrom !== null && !coverageFrom)) {
          const error = !sourceSyncRunId
            ? "sourceSyncRunId is required for messages_source_sync"
            : !coverageTo
              ? "valid coverageTo is required for messages_source_sync"
              : "valid coverageFrom is required for messages_source_sync";
          await opts.sender.ackCommand(command.id, { status: "failed", error });
          clearMessagesAgentCommandState(opts.userId);
          opts.onCommandSettled?.(command);
          return;
        }
        const gated = await runWithMessagesBackfillGate(opts.backfillGate, async () => {
          const backfillDays = sourceSyncBackfillDays(coverageFrom, coverageTo);
          const scope = messagesBackfillScope({
            backfillDays,
            allChats: opts.allChats,
            allowedChatIds: opts.allowedChatIds,
          });
          const commandState = loadMessagesAgentCommandState(opts.userId);
          if (commandState.commandId !== command.id) {
            clearMessagesBackfillComplete(opts.userId, scope);
            clearMessagesBackfillProgress(opts.userId, scope);
            saveMessagesAgentCommandState(opts.userId, {
              commandId: command.id,
              type: command.type,
              startedAt: new Date().toISOString(),
            });
          }
          console.log(`Running Messages source-sync command ${command.id} (${reason})`);

          const result = await runMessagesBackfill(
            opts.sdk,
            opts.sender,
            opts.serializer,
            backfillDays,
            opts.allChats ? null : opts.allowedChatIds,
            opts.contactSync,
            opts.stateCache,
            { since: coverageFrom },
          );
          return { result, scope, coverageFrom, coverageTo };
        });
        if (gated.skipped) return;
        const {
          result,
          scope,
          coverageFrom: receiptCoverageFrom,
          coverageTo: receiptCoverageTo,
        } = gated.value;
        if (!result.complete) {
          console.warn(`Messages source-sync command ${command.id} paused with ${result.queued ?? 0} queued message(s); it will retry`);
          return;
        }

        saveMessagesBackfillComplete(opts.userId, scope, result);
        await opts.contactSync?.syncNow?.({ forceAll: true, reason: "remote-source-sync" }).catch((err) => {
          console.error("Remote source-sync Messages contact sync failed:", safeError(err));
        });
        await gapFillFromWatermark(
          opts.sdk,
          opts.sender,
          opts.serializer,
          opts.userId,
          opts.allChats ? null : opts.allowedChatIds,
          opts.contactSync,
          opts.stateCache,
        );
        const queueDepth = opts.sender.queueDepth();
        if (queueDepth > 0) {
          console.warn(`Messages source-sync command ${command.id} paused with ${queueDepth} queued message(s) after gap-fill; it will retry`);
          return;
        }
        await opts.sender.ackCommand(command.id, {
          status: "completed",
          result: messagesSourceSyncReceipt({
            command,
            result,
            coverageFrom: receiptCoverageFrom,
            coverageTo: receiptCoverageTo,
            allChats: opts.allChats,
            allowedChatIds: opts.allowedChatIds,
            queueDepth,
            deviceId: opts.sender.deviceId,
            agentVersion: opts.sender.agentVersion,
            agentChannel: opts.sender.agentChannel,
          }),
        });
        clearMessagesAgentCommandState(opts.userId);
        opts.onCommandSettled?.(command);
        console.log(`Messages source-sync command ${command.id} completed`);
        return;
      }

      const gated = await runWithMessagesBackfillGate(opts.backfillGate, async () => {
        const backfillDays = parseBackfillDays(command.backfillDays, opts.defaultBackfillDays);
        const scope = messagesBackfillScope({
          backfillDays,
          allChats: opts.allChats,
          allowedChatIds: opts.allowedChatIds,
        });
        const commandState = loadMessagesAgentCommandState(opts.userId);
        if (commandState.commandId !== command.id) {
          clearMessagesBackfillComplete(opts.userId, scope);
          clearMessagesBackfillProgress(opts.userId, scope);
          saveMessagesAgentCommandState(opts.userId, {
            commandId: command.id,
            type: command.type,
            startedAt: new Date().toISOString(),
          });
        }
        console.log(`Running Messages backfill reset command ${command.id} (${reason})`);

        const result = await runMessagesBackfill(
          opts.sdk,
          opts.sender,
          opts.serializer,
          backfillDays,
          opts.allChats ? null : opts.allowedChatIds,
          opts.contactSync,
          opts.stateCache,
        );
        return { result, scope };
      });
      if (gated.skipped) return;
      const { result, scope } = gated.value;
      if (!result.complete) {
        console.warn(`Messages backfill reset command ${command.id} paused with ${result.queued ?? 0} queued message(s); it will retry`);
        return;
      }

      saveMessagesBackfillComplete(opts.userId, scope, result);
      await opts.contactSync?.syncNow?.({ forceAll: true, reason: "remote-backfill-reset" }).catch((err) => {
        console.error("Remote reset Messages contact sync failed:", safeError(err));
      });
      await gapFillFromWatermark(
        opts.sdk,
        opts.sender,
        opts.serializer,
        opts.userId,
        opts.allChats ? null : opts.allowedChatIds,
        opts.contactSync,
        opts.stateCache,
      );
      await opts.sender.ackCommand(command.id, { status: "completed", result });
      clearMessagesAgentCommandState(opts.userId);
      opts.onCommandSettled?.(command);
      console.log(`Messages backfill reset command ${command.id} completed`);
    } catch (err) {
      console.error("Messages command poll failed:", safeError(err));
      if (command?.id) {
        let failureAcked = false;
        await opts.sender.ackCommand(command.id, { status: "failed", error: safeError(err) }).then(() => {
          failureAcked = true;
        }).catch((ackErr) => {
          console.error("Messages command failure ack failed:", safeError(ackErr));
        });
        if (failureAcked) {
          clearMessagesAgentCommandState(opts.userId);
          opts.onCommandSettled?.(command);
        }
      }
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => {
    run("interval").catch((err) => console.error("Messages command poll failed:", safeError(err)));
  }, intervalMs);
  run("startup").catch((err) => console.error("Messages command poll failed:", safeError(err)));

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

function createMessagesBackfillGate() {
  return { running: false };
}

function messagesSourceSyncReceipt({
  command,
  result,
  coverageFrom,
  coverageTo,
  allChats,
  allowedChatIds,
  queueDepth,
  deviceId,
  agentVersion = PACKAGE_VERSION,
  agentChannel = cliChannel(),
}) {
  const stored = countValue(result.totalStored);
  const updated = countValue(result.totalUpdated);
  const skipped = countValue(result.totalSkipped);
  const pendingMessages = Math.max(countValue(result.queued), countValue(queueDepth));
  const sourceSyncRunId = stringValue(command.sourceSyncRunId);
  const scope = allChats
    ? { allChats: true }
    : { chatIdsHash: hashObject([...allowedChatIds].sort()), chatCount: allowedChatIds.length };
  return {
    receiptVersion: 1,
    sourceSyncRunId,
    commandId: command.id,
    provider: "imessage",
    deviceId,
    agentVersion,
    agentChannel,
    coverageFrom: coverageFrom ? coverageFrom.toISOString() : null,
    coverageTo: coverageTo.toISOString(),
    highWatermark: receiptWatermark(`${sourceSyncRunId}:imessage-rowid:${countValue(result.watermark)}`),
    exhausted: pendingMessages === 0,
    capHit: false,
    scannedMessages: countValue(result.totalMessages),
    sentMessages: stored + updated + skipped,
    chatsSeen: allChats ? null : allowedChatIds.length,
    pendingMessages,
    failedMessages: 0,
    queueDepth: pendingMessages,
    scopeKind: allChats ? "all_chats" : "selected_chats",
    scopeHash: receiptWatermark(`${sourceSyncRunId}:scope:${hashObject(scope)}`),
  };
}

function receiptWatermark(value) {
  return `sha256:${hashString(value)}`;
}

function dateFromCommand(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function sourceSyncBackfillDays(coverageFrom, coverageTo) {
  if (!coverageFrom) return null;
  const ms = coverageTo.getTime() - coverageFrom.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

async function runWithMessagesBackfillGate(gate, fn) {
  if (!gate) return { skipped: false, value: await fn() };
  if (gate.running) return { skipped: true };
  gate.running = true;
  try {
    return { skipped: false, value: await fn() };
  } finally {
    gate.running = false;
  }
}

function createMessageStateCache(userId, maxSize = MESSAGES_STATE_CACHE_MAX, channel = cliChannel()) {
  const stateFile = messagesStateFile(userId, channel);
  const initial = readJsonOptional(stateFile);
  const cache = new Map(Object.entries(
    initial && typeof initial === "object" && !Array.isArray(initial) ? initial : {},
  ));

  const remember = (msg) => {
    const key = messageIdentity(msg);
    if (!key) return;
    cache.set(key, messageState(msg));
    trimMessageStateCache(cache, maxSize);
  };

  const persist = () => saveMessagesState(userId, Object.fromEntries(cache), channel);

  return {
    observe(messages) {
      for (const msg of messages ?? []) remember(msg);
      persist();
    },
    changed(messages) {
      const changed = [];
      for (const msg of messages ?? []) {
        const key = messageIdentity(msg);
        if (!key) continue;
        const current = messageState(msg);
        const previous = cache.get(key);
        if ((previous && !sameMessageState(previous, current))
          || (!previous && hasMessageEditOrRetraction(msg))) {
          changed.push(msg);
        }
      }
      return changed;
    },
  };
}

function trimMessageStateCache(cache, maxSize) {
  if (cache.size <= maxSize) return;
  const excess = cache.size - maxSize;
  for (const key of [...cache.keys()].slice(0, excess)) cache.delete(key);
}

function hasMessageEditOrRetraction(msg) {
  return Boolean(msg?.editedAt || msg?.retractedAt);
}

function messageIdentity(msg) {
  const value = msg?.id ?? msg?.messageId ?? msg?.rowId;
  return value == null ? null : String(value);
}

function providerMessageGuidCandidate(msg) {
  const explicit = providerMessageGuidValue(msg?.id, msg);
  if (explicit) return { value: explicit, explicit: true };
  const inferred = providerMessageGuidValue(msg?.messageId, msg);
  if (inferred) return { value: inferred, explicit: false };
  return null;
}

function providerMessageGuidValue(value, msg) {
  if (value == null) return null;
  const string = String(value).trim();
  if (!string || /^[0-9]+$/.test(string)) return null;
  const rowId = Number(msg?.rowId);
  if (Number.isFinite(rowId) && string === String(rowId)) return null;
  return string;
}

function messageState(msg) {
  const participant = messageParticipant(msg);
  return {
    text: msg?.text ?? null,
    chatId: msg?.chatId ?? null,
    chatKind: messageChatKind(msg),
    participant,
    isFromMe: Boolean(msg?.isFromMe),
    editedAt: isoDate(msg?.editedAt),
    retractedAt: isoDate(msg?.retractedAt),
    replyToMessageId: msg?.replyToMessageId ?? null,
    threadRootMessageId: msg?.threadRootMessageId ?? null,
    affectedParticipant: msg?.affectedParticipant ?? null,
    kind: msg?.kind ?? null,
    hasAttachments: Boolean(msg?.hasAttachments ?? (Array.isArray(msg?.attachments) && msg.attachments.length > 0)),
    attachments: messageAttachmentState(msg),
  };
}

function sameMessageState(a, b) {
  return a.text === b.text
    && a.chatId === b.chatId
    && a.chatKind === b.chatKind
    && a.participant === b.participant
    && a.isFromMe === b.isFromMe
    && a.editedAt === b.editedAt
    && a.retractedAt === b.retractedAt
    && a.replyToMessageId === b.replyToMessageId
    && a.threadRootMessageId === b.threadRootMessageId
    && a.affectedParticipant === b.affectedParticipant
    && a.kind === b.kind
    && a.hasAttachments === b.hasAttachments
    && stableLocalJson(a.attachments) === stableLocalJson(b.attachments);
}

function messageAttachmentState(msg) {
  return (Array.isArray(msg?.attachments) ? msg.attachments : [])
    .map((att) => ({
      id: String(att?.id ?? ""),
      fileName: att?.fileName ?? null,
      mimeType: att?.mimeType ?? null,
      sizeBytes: Number(att?.sizeBytes ?? 0),
      transferStatus: att?.transferStatus ?? null,
      isSticker: Boolean(att?.isSticker),
      isSensitiveContent: Boolean(att?.isSensitiveContent),
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || String(a.fileName ?? "").localeCompare(String(b.fileName ?? "")));
}

function stableLocalJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableLocalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableLocalJson(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function startMessagesEditDetector(sdk, sender, serializer, allowedChatIds, opts = {}) {
  const contactSync = opts.contactSync ?? null;
  const stateCache = opts.stateCache ?? createMessageStateCache(sender.userId);
  const watchers = [];
  let stopped = false;
  let timer = null;
  let scanning = false;
  let lastMutationReconcileAt = 0;

  const scan = async (reason) => {
    if (stopped || scanning) return;
    if (opts.deferWhen?.()) return;
    scanning = true;
    try {
      const recentResult = await scanMessagesForEditsAndUnsends(sdk, sender, serializer, allowedChatIds, {
        contactSync,
        stateCache,
      });
      const shouldReconcileMutations = reason === "startup"
        || Date.now() - lastMutationReconcileAt >= MESSAGES_MUTATION_RECONCILE_INTERVAL_MS;
      const mutationResult = shouldReconcileMutations
        ? await reconcileMessagesMutations(sdk, sender, serializer, allowedChatIds, {
            contactSync,
            stateCache,
          })
        : { changed: 0, stored: 0, updated: 0, queued: 0 };
      if (shouldReconcileMutations) lastMutationReconcileAt = Date.now();

      const result = {
        changed: recentResult.changed + mutationResult.changed,
        stored: recentResult.stored + mutationResult.stored,
        updated: recentResult.updated + mutationResult.updated,
        queued: recentResult.queued + mutationResult.queued,
      };
      if (result.changed > 0) {
        console.log(`Messages edit detector: ${result.changed} edit/unsend change(s) sent (${reason}); stored ${result.stored}, updated ${result.updated}, queued ${result.queued}`);
      }
    } catch (err) {
      console.error("Messages edit detector failed:", safeError(err));
    } finally {
      scanning = false;
    }
  };

  const schedule = (reason) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      scan(reason).catch((err) => console.error("Messages edit detector failed:", safeError(err)));
    }, 500);
  };

  for (const walPath of messagesWatchPaths()) {
    try {
      watchers.push(watch(walPath, () => {
        schedule("messages-db");
      }));
    } catch (err) {
      console.warn(`Could not watch Messages database file ${walPath}: ${safeError(err)}`);
    }
  }

  if (watchers.length > 0) {
    console.log(`Watching ${watchers.length} Messages database file(s) for edits and unsends`);
  } else if (platform() === "darwin") {
    console.warn("Messages database watch files not found; edit/unsend detection will use fallback polling only");
  }

  const interval = setInterval(() => {
    scan("fallback").catch((err) => console.error("Messages edit detector failed:", safeError(err)));
  }, MESSAGES_EDIT_SCAN_INTERVAL_MS);
  scan("startup").catch((err) => console.error("Messages edit detector failed:", safeError(err)));

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      for (const watcher of watchers) watcher.close();
    },
  };
}

function messagesWatchPaths() {
  if (platform() !== "darwin") return [];
  return [
    MESSAGES_CHAT_DB_PATH,
    `${MESSAGES_CHAT_DB_PATH}-wal`,
    `${MESSAGES_CHAT_DB_PATH}-shm`,
  ].filter((path) => existsSync(path));
}

async function scanMessagesForEditsAndUnsends(sdk, sender, serializer, allowedChatIds, opts = {}) {
  const allChats = allowedChatIds == null;
  const since = new Date(Date.now() - MESSAGES_EDIT_SCAN_WINDOW_MS);
  const messages = await getScopedMessages(sdk, allowedChatIds, { since });

  const filtered = messages.filter((msg) =>
    msg?.chatId
    && (allChats || allowedChatIds.includes(msg.chatId))
    && !messageTouchesShepherdAgent(msg));
  opts.contactSync?.observeMessages(filtered);

  const changed = opts.stateCache?.changed(filtered) ?? [];
  if (changed.length === 0) {
    opts.stateCache?.observe(filtered);
    return { changed: 0, stored: 0, updated: 0, queued: 0 };
  }

  const result = await sender.send(changed.map((msg) => serializer.serialize(msg)));
  if ((result.queued ?? 0) === 0) opts.stateCache?.observe(filtered);
  return {
    changed: changed.length,
    stored: result.stored ?? 0,
    updated: result.updated ?? 0,
    queued: result.queued ?? 0,
  };
}

async function getScopedMessages(sdk, allowedChatIds, query) {
  const messages = [];
  if (allowedChatIds == null) {
    messages.push(...await getPagedMessages(sdk, query));
    return messages;
  }

  for (const chatId of allowedChatIds) {
    messages.push(...await getPagedMessages(sdk, { ...query, chatId }));
  }
  return messages;
}

async function getPagedMessages(sdk, query) {
  const messages = [];
  let offset = 0;
  while (true) {
    const page = await sdk.getMessages({ ...query, limit: MESSAGES_EDIT_SCAN_LIMIT, offset });
    if (!page.length) break;
    messages.push(...page);
    if (page.length < MESSAGES_EDIT_SCAN_LIMIT) break;
    offset += MESSAGES_EDIT_SCAN_LIMIT;
  }
  return messages;
}

async function reconcileMessagesMutations(sdk, sender, serializer, allowedChatIds, opts = {}) {
  const allChats = allowedChatIds == null;
  const rowIds = queryMessagesMutationRowIds(sdk, allowedChatIds);
  if (rowIds.length === 0) return { changed: 0, stored: 0, updated: 0, queued: 0 };

  const messages = await getMessagesByRowIds(sdk, rowIds);
  const filtered = messages.filter((msg) =>
    msg?.chatId
    && (allChats || allowedChatIds.includes(msg.chatId))
    && !messageTouchesShepherdAgent(msg));
  opts.contactSync?.observeMessages(filtered);

  const changed = opts.stateCache?.changed(filtered) ?? filtered.filter(hasMessageEditOrRetraction);
  if (changed.length === 0) {
    opts.stateCache?.observe(filtered);
    return { changed: 0, stored: 0, updated: 0, queued: 0 };
  }

  const result = await sender.send(changed.map((msg) => serializer.serialize(msg)));
  if ((result.queued ?? 0) === 0) opts.stateCache?.observe(filtered);
  return {
    changed: changed.length,
    stored: result.stored ?? 0,
    updated: result.updated ?? 0,
    queued: result.queued ?? 0,
  };
}

function queryMessagesMutationRowIds(sdk, allowedChatIds = null) {
  const db = sdk?.database;
  if (!db || typeof db.all !== "function") {
    console.warn("Messages mutation reconciliation unavailable: SDK database reader is not exposed");
    return [];
  }

  const columns = messageTableColumns(db);
  const predicates = [];
  if (columns.has("date_edited")) predicates.push("COALESCE(message.date_edited, 0) != 0");
  if (columns.has("date_retracted")) predicates.push("COALESCE(message.date_retracted, 0) != 0");
  if (!predicates.length) return [];

  const params = [];
  let chatJoin = "";
  let chatPredicate = "";
  if (allowedChatIds != null) {
    const values = uniqueStrings(allowedChatIds.flatMap(chatIdMatchValues));
    if (values.length === 0) return [];
    const placeholders = values.map(() => "?").join(", ");
    chatJoin = `
      INNER JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
      INNER JOIN chat ON chat.ROWID = chat_message_join.chat_id
    `;
    chatPredicate = `AND (chat.chat_identifier IN (${placeholders}) OR chat.guid IN (${placeholders}))`;
    params.push(...values, ...values);
  }

  try {
    const rows = db.all(`
      SELECT DISTINCT message.ROWID AS rowId
      FROM message
      ${chatJoin}
      WHERE (${predicates.join(" OR ")})
      ${chatPredicate}
      ORDER BY message.ROWID ASC
    `, params);
    return rows
      .map((row) => Number(row.rowId))
      .filter((rowId) => Number.isFinite(rowId) && rowId > 0);
  } catch (err) {
    console.warn(`Messages mutation reconciliation query failed: ${safeError(err)}`);
    return [];
  }
}

function messageTableColumns(db) {
  try {
    return new Set(db.all("PRAGMA table_info(message)").map((row) => String(row.name)));
  } catch (err) {
    console.warn(`Messages mutation reconciliation unavailable: ${safeError(err)}`);
    return new Set();
  }
}

function chatIdMatchValues(chatId) {
  const raw = String(chatId ?? "").trim();
  if (!raw) return [];
  const core = raw.includes(";+;")
    ? raw.slice(raw.indexOf(";+;") + 3)
    : raw.includes(";-;")
      ? raw.slice(raw.indexOf(";-;") + 3)
      : raw;
  return raw === core ? [raw] : [raw, core];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

async function getMessagesByRowIds(sdk, rowIds) {
  const messages = [];
  for (const rowId of rowIds) {
    const page = await sdk.getMessages({
      sinceRowId: rowId - 1,
      orderByRowIdAsc: true,
      limit: 1,
    });
    const msg = page.find((candidate) => Number(candidate.rowId) === rowId);
    if (msg) messages.push(msg);
  }
  return messages;
}

async function watchMessages(sdk, sender, serializer, userId, allowedChatIds, opts = {}) {
  const allChats = allowedChatIds == null;
  const allowed = new Set(allowedChatIds ?? []);
  const contactSync = opts.contactSync ?? null;
  const stateCache = opts.stateCache ?? null;
  let buffer = [];
  let timer = null;
  let stopping = false;
  let restarting = false;
  let restartTimer = null;

  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer.splice(0, MESSAGES_UPLOAD_BATCH_SIZE);
    const result = await sender.send(batch.map((msg) => serializer.serialize(msg)));
    if ((result.queued ?? 0) === 0) {
      stateCache?.observe(batch);
      saveMessagesWatermark(userId, maxRowId(batch));
    }
  };

  const scheduleFlush = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await flush().catch((err) => console.error("Messages flush failed:", safeError(err)));
    }, 3000);
  };

  const onMessage = (msg) => {
    if (!msg.chatId || (!allChats && !allowed.has(msg.chatId))) return;
    if (messageTouchesShepherdAgent(msg)) return;
    contactSync?.observeMessages([msg]);
    buffer.push(msg);
    if (buffer.length >= MESSAGES_UPLOAD_BATCH_SIZE) {
      if (timer) clearTimeout(timer);
      timer = null;
      flush().catch((err) => console.error("Messages flush failed:", safeError(err)));
    } else {
      scheduleFlush();
    }
  };

  async function startWatcher() {
    await sdk.startWatching({
      onIncomingMessage: onMessage,
      onFromMeMessage: onMessage,
      onError: (err) => {
        console.error("Messages watcher error:", safeError(err));
        scheduleRestart();
      },
    });
  }

  async function restartWatcher() {
    if (stopping || restarting) return;
    restarting = true;
    try {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush().catch((err) => console.error("Messages flush failed:", safeError(err)));
      await sdk.stopWatching?.().catch((err) => console.error("Messages watcher stop failed:", safeError(err)));
      await gapFillFromWatermark(sdk, sender, serializer, userId, allowedChatIds, contactSync, stateCache);
      if (!stopping) {
        await startWatcher();
        console.log("Messages watcher restarted");
      }
    } catch (err) {
      console.error("Messages watcher restart failed:", safeError(err));
      if (!stopping) scheduleRestart();
    } finally {
      restarting = false;
    }
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      restartWatcher().catch((err) => console.error("Messages watcher restart failed:", safeError(err)));
    }, MESSAGES_WATCH_RESTART_DELAY_MS);
  }

  await startWatcher();

  console.log(allChats
    ? "Watching for new Messages in all current and future chats"
    : "Watching for new Messages in selected chats");

  await new Promise((resolve) => {
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      if (timer) clearTimeout(timer);
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      contactSync?.stop();
      opts.onShutdown?.();
      await flush().catch(() => undefined);
      await sdk.close?.().catch(() => undefined);
      resolve();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function createMutableContactLookup(initial = emptyContactLookup()) {
  let current = initial;
  return {
    replace(next) {
      current = next ?? emptyContactLookup();
    },
    resolveName(handle) {
      return current.resolveName(handle);
    },
    isSelfHandle(handle) {
      return current.isSelfHandle(handle);
    },
    mappings() {
      return contactMappingsFromLookup(current);
    },
  };
}

function startMessagesContactSync(sender, contactLookup, opts = {}) {
  const syncAllContacts = opts.syncAllContacts === true;
  const observedHandles = new Set();
  for (const handle of opts.seedHandles ?? []) rememberObservedHandle(observedHandles, contactLookup, handle);

  let previousSnapshot = new Map();
  let syncTimer = null;
  let contactsWatcher = null;
  let fallbackInterval = null;
  let syncing = false;
  let pendingReason = null;
  let stopped = false;

  const visibleMappings = () => {
    const mappings = contactLookup.mappings();
    if (syncAllContacts) return mappings;
    return mappings.filter((mapping) => handleCandidates(mapping.handle).some((candidate) => observedHandles.has(candidate)));
  };

  const syncNow = async ({ forceAll = false, reason = "manual" } = {}) => {
    if (stopped) return { skipped: true, reason: "stopped" };
    if (!forceAll && opts.deferWhen?.()) return { skipped: true, reason: "backfill_active" };
    if (syncing) {
      pendingReason = reason;
      return { skipped: true, reason: "already_syncing" };
    }

    syncing = true;
    try {
      const nextLookup = buildContactLookup({ userId: opts.userId });
      contactLookup.replace(nextLookup);
      const mappings = visibleMappings();
      const toSync = forceAll
        ? mappings
        : mappings.filter((mapping) => previousSnapshot.get(mapping.handle) !== mapping.name);

      if (toSync.length === 0) {
        previousSnapshot = snapshotContactMappings(mappings);
        return { updated: 0, contactsProcessed: 0 };
      }

      const result = await sender.syncContacts(toSync);
      previousSnapshot = snapshotContactMappings(mappings);
      console.log(`[contacts] Synced ${toSync.length}/${mappings.length} Messages contact mappings (${reason}); updated ${result.updated ?? 0}`);
      return result;
    } finally {
      syncing = false;
      const queuedReason = pendingReason;
      pendingReason = null;
      if (queuedReason && !stopped) scheduleSync(queuedReason);
    }
  };

  const scheduleSync = (reason) => {
    if (stopped) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncNow({ reason }).catch((err) => console.error("Messages contact sync failed:", safeError(err)));
    }, CONTACT_SYNC_DEBOUNCE_MS);
  };

  const observeMessages = (messages) => {
    let changed = false;
    for (const msg of messages ?? []) {
      if (rememberObservedHandle(observedHandles, contactLookup, messageParticipant(msg))) changed = true;
      if (msg?.affectedParticipant) {
        if (rememberObservedHandle(observedHandles, contactLookup, msg.affectedParticipant)) changed = true;
      }
    }
    if (changed) scheduleSync("observed-message-handle");
  };

  const contactWatchPaths = addressBookWalPaths();
  if (contactWatchPaths.length > 0) {
    contactsWatcher = [];
    for (const path of contactWatchPaths) {
      try {
        contactsWatcher.push(watch(path, () => scheduleSync("contacts-watch")));
      } catch (err) {
        console.warn(`Could not watch Contacts WAL ${path}: ${safeError(err)}`);
      }
    }
    if (contactsWatcher.length > 0) {
      console.log(`Watching ${contactsWatcher.length} Contacts database WAL file(s) for Messages name changes`);
    } else {
      console.warn("Contacts WAL files were found but could not be watched; Messages contact sync will use fallback polling only");
    }
  } else if (platform() === "darwin") {
    console.warn("Contacts WAL not found; Messages contact sync will use fallback polling only");
  }

  fallbackInterval = setInterval(() => {
    syncNow({ reason: "fallback" }).catch((err) => console.error("Messages contact fallback sync failed:", safeError(err)));
  }, CONTACT_SYNC_FALLBACK_MS);

  return {
    observeMessages,
    syncNow,
    stop() {
      stopped = true;
      if (syncTimer) clearTimeout(syncTimer);
      if (fallbackInterval) clearInterval(fallbackInterval);
      if (contactsWatcher) {
        for (const watcher of contactsWatcher) watcher.close();
      }
    },
  };
}

function rememberObservedHandle(observedHandles, contactLookup, handle) {
  const raw = typeof handle === "string" ? handle.trim() : "";
  if (!raw || contactLookup.isSelfHandle(raw)) return false;
  let changed = false;
  for (const candidate of handleCandidates(raw)) {
    if (!observedHandles.has(candidate)) {
      observedHandles.add(candidate);
      changed = true;
    }
  }
  return changed;
}

function contactMappingsFromLookup(lookup) {
  const mappings = typeof lookup?.mappings === "function" ? lookup.mappings() : lookup?.mappings;
  if (!Array.isArray(mappings)) return [];
  return mappings.filter((mapping) =>
    mapping
    && typeof mapping.handle === "string"
    && mapping.handle.trim()
    && typeof mapping.name === "string"
    && mapping.name.trim());
}

function snapshotContactMappings(mappings) {
  return new Map(mappings.map((mapping) => [mapping.handle, mapping.name]));
}

function createMessageSerializer(kit, contactLookup = emptyContactLookup(), agentMetadata = {}) {
  const chatNames = new Map();
  const isImageAttachment = kit.isImageAttachment ?? (() => false);
  const isVideoAttachment = kit.isVideoAttachment ?? (() => false);
  const isAudioAttachment = kit.isAudioAttachment ?? (() => false);
  const deviceId = typeof agentMetadata.deviceId === "string" && agentMetadata.deviceId.trim()
    ? agentMetadata.deviceId.trim()
    : null;
  const agentVersion = typeof agentMetadata.agentVersion === "string" && agentMetadata.agentVersion.trim()
    ? agentMetadata.agentVersion.trim()
    : PACKAGE_VERSION;
  const agentChannel = typeof agentMetadata.agentChannel === "string" && agentMetadata.agentChannel.trim()
    ? normalizeLaunchAgentChannel(agentMetadata.agentChannel)
    : cliChannel();

  return {
    setChatName(chatId, name) {
      chatNames.set(chatId, name);
    },
    serialize(msg) {
      const chatId = msg.chatId ?? "unknown";
      const participant = messageParticipant(msg);
      const chatKind = messageChatKind(msg);
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      const providerMessageGuid = providerMessageGuidCandidate(msg);
      return {
        messageId: String(providerMessageGuid?.value ?? msg.messageId ?? msg.rowId),
        providerMessageGuid: providerMessageGuid == null ? null : String(providerMessageGuid.value),
        _provider_guid_explicit: providerMessageGuid == null ? null : providerMessageGuid.explicit,
        deviceId,
        agentVersion,
        agentChannel,
        localRowId: Number(msg.rowId ?? 0),
        rowId: Number(msg.rowId ?? 0),
        text: msg.text ?? null,
        service: msg.service ?? "iMessage",
        chatId,
        chatKind,
        chatName: chatNames.get(chatId) ?? null,
        participant,
        isFromMe: Boolean(msg.isFromMe),
        createdAt: isoDate(msg.createdAt) ?? new Date().toISOString(),
        deliveredAt: isoDate(msg.deliveredAt),
        readAt: isoDate(msg.readAt),
        editedAt: isoDate(msg.editedAt),
        retractedAt: isoDate(msg.retractedAt),
        reaction: msg.reaction
          ? {
              kind: msg.reaction.kind,
              targetMessageId: msg.reaction.targetMessageId ?? null,
              emoji: msg.reaction.emoji ?? null,
              isRemoved: Boolean(msg.reaction.isRemoved),
              textRange: msg.reaction.textRange ?? null,
              appBundleId: msg.reaction.appBundleId ?? null,
            }
          : null,
        hasAttachments: Boolean(msg.hasAttachments ?? attachments.length > 0),
        attachments: attachments.map((att) => ({
          id: String(att.id ?? ""),
          fileName: att.fileName ?? null,
          mimeType: att.mimeType ?? "application/octet-stream",
          uti: att.uti ?? null,
          sizeBytes: Number(att.sizeBytes ?? 0),
          transferStatus: att.transferStatus ?? "unknown",
          createdAt: isoDate(att.createdAt),
          altText: att.altText ?? null,
          isFromMe: typeof att.isFromMe === "boolean" ? att.isFromMe : null,
          isSensitiveContent: Boolean(att.isSensitiveContent),
          isSticker: Boolean(att.isSticker),
          isImage: isImageAttachment(att),
          isVideo: isVideoAttachment(att),
          isAudio: isAudioAttachment(att),
        })),
        replyToMessageId: msg.replyToMessageId ?? null,
        threadRootMessageId: msg.threadRootMessageId ?? null,
        sendEffect: msg.sendEffect ?? null,
        kind: msg.kind ?? "message",
        isAudioMessage: Boolean(msg.isAudioMessage),
        isForwarded: Boolean(msg.isForwarded),
        affectedParticipant: msg.affectedParticipant ?? null,
        newGroupName: msg.newGroupName ?? null,
        _resolved_name: participant ? contactLookup.resolveName(participant) : null,
        _is_self_handle: participant ? contactLookup.isSelfHandle(participant) : false,
      };
    },
  };
}

function messageParticipant(msg) {
  const explicit = typeof msg?.participant === "string" ? msg.participant.trim() : "";
  if (explicit) return explicit;
  if (!isDirectMessageKind(messageChatKind(msg))) return null;
  return parseDmHandleFromChatId(msg?.chatId);
}

function messageChatKind(msg) {
  const explicit = typeof msg?.chatKind === "string" ? msg.chatKind.trim() : "";
  if (explicit === "direct") return "dm";
  if (explicit) return explicit;
  return parseDmHandleFromChatId(msg?.chatId) ? "dm" : "unknown";
}

function isDirectMessageKind(kind) {
  return kind === "dm";
}

function buildContactLookup(opts = {}) {
  const addressBook = platform() === "darwin" ? loadContactsFromAddressBookDb() : { contacts: [], myCard: null };
  const status = messagesContactsStatus(addressBook);
  if (opts.userId) {
    saveMessagesContactStatus(opts.userId, status, opts.channel);
  }
  if (addressBook.ok !== true && platform() === "darwin" && opts.warn !== false) {
    console.warn(`Messages contact resolution degraded: ${addressBook.error ?? "unsupported local Contacts database schema"}. Raw Messages sync will continue; contact founders@askshepherd.ai.`);
  }
  const contacts = opts.loadAll === false ? [] : addressBook.contacts;
  const myCard = addressBook.myCard;
  const handleToName = new Map();
  const selfHandles = new Set();

  for (const contact of contacts) {
    for (const phone of contact.phones) {
      addHandleMapping(handleToName, phone, contact.name);
    }
    for (const email of contact.emails) {
      addHandleMapping(handleToName, email, contact.name);
    }
  }

  if (myCard) {
    for (const phone of myCard.phones) addSelfHandle(selfHandles, phone);
    for (const email of myCard.emails) addSelfHandle(selfHandles, email);
  }

  return {
    resolveName(handle) {
      const candidates = handleCandidates(handle);
      for (const candidate of candidates) {
        const name = handleToName.get(candidate);
        if (name) return name;
      }
      return null;
    },
    isSelfHandle(handle) {
      return handleCandidates(handle).some((candidate) => selfHandles.has(candidate));
    },
    searchHandles(query) {
      const matches = [];
      for (const contact of contacts) {
        const handles = [...contact.phones, ...contact.emails];
        const searchable = [contact.name, ...handles].join(" ");
        if (searchTextMatches(searchable, query)) matches.push(...handles);
      }
      return uniqueStrings(matches);
    },
    mappings() {
      return [...handleToName.entries()].map(([handle, name]) => ({ handle, name }));
    },
    contactsStatus() {
      return status;
    },
  };
}

function emptyContactLookup() {
  return {
    resolveName() {
      return null;
    },
    isSelfHandle() {
      return false;
    },
    searchHandles() {
      return [];
    },
    mappings() {
      return [];
    },
    contactsStatus() {
      return messagesContactsStatus({ ok: false, contacts: [], myCard: null, error: "Apple Contacts lookup is unavailable" });
    },
  };
}

function messagesContactsStatus(addressBook) {
  const ok = addressBook?.ok === true;
  return {
    provider: "apple_contacts",
    ok,
    updatedAt: new Date().toISOString(),
    contacts: Array.isArray(addressBook?.contacts) ? addressBook.contacts.length : 0,
    hasMyCard: Boolean(addressBook?.myCard),
    settingsUrl: MAC_CONTACTS_ACCESS_URL,
    error: ok ? null : addressBook?.error ?? "unsupported local Contacts database schema",
  };
}

function loadContactsFromAddressBookDb() {
  const contacts = [];
  let myCard = null;
  let readSucceeded = false;
  let firstError = null;
  for (const dbPath of addressBookDatabasePaths()) {
    const query = `
with records as (
  select Z_PK as id,
         coalesce(ZME, 0) as me,
         coalesce(Z22_ME, 0) as me22,
         coalesce(
           nullif(ZNAME, ''),
           nullif(trim(coalesce(ZFIRSTNAME, '') || ' ' || coalesce(ZMIDDLENAME, '') || ' ' || coalesce(ZLASTNAME, '')), ''),
           nullif(ZNICKNAME, ''),
           nullif(ZORGANIZATION, ''),
           ''
         ) as display_name
  from ZABCDRECORD
),
phones as (
  select coalesce(ZOWNER, Z22_OWNER) as owner, ZFULLNUMBER as value
  from ZABCDPHONENUMBER
  where nullif(ZFULLNUMBER, '') is not null
),
emails as (
  select coalesce(ZOWNER, Z22_OWNER) as owner, coalesce(ZADDRESSNORMALIZED, ZADDRESS) as value
  from ZABCDEMAILADDRESS
  where nullif(coalesce(ZADDRESSNORMALIZED, ZADDRESS), '') is not null
)
select r.id,
       r.me,
       r.me22,
       r.display_name,
       coalesce(p.value, '') as phone,
       coalesce(e.value, '') as email
from records r
left join phones p on p.owner = r.id
left join emails e on e.owner = r.id
where r.display_name != ''
  and (p.value is not null or e.value is not null);`;

    try {
      const raw = execFileSync("sqlite3", ["-separator", "\t", dbPath, query], {
        encoding: "utf8",
        timeout: 10_000,
      });
      readSucceeded = true;
      for (const line of raw.split("\n").filter(Boolean)) {
        const [id, me, me22, rawName, phone, email] = line.split("\t");
        const name = rawName?.trim();
        if (!id || !name) continue;
        const key = `${dbPath}:${id}`;
        let current = contacts.find((contact) => contact._key === key);
        if (!current) {
          current = { _key: key, name, phones: [], emails: [] };
          contacts.push(current);
        }
        if (phone?.trim()) current.phones.push(phone.trim());
        if (email?.trim()) current.emails.push(email.trim());
        if (Number(me) !== 0 || Number(me22) !== 0) myCard = current;
      }
    } catch (err) {
      firstError ??= safeError(err);
      if (args.debug === true) console.error(`Could not read Contacts DB ${dbPath}:`, safeError(err));
    }
  }

  const cleanContacts = contacts
    .map(({ _key, ...contact }) => ({
      name: contact.name,
      phones: [...new Set(contact.phones)],
      emails: [...new Set(contact.emails)],
    }))
    .filter((contact) => contact.name && (contact.phones.length > 0 || contact.emails.length > 0));

  const cleanMyCard = myCard
    ? {
        name: myCard.name,
        phones: [...new Set(myCard.phones)],
        emails: [...new Set(myCard.emails)],
      }
    : null;

  return {
    ok: readSucceeded,
    contacts: cleanContacts,
    myCard: cleanMyCard,
    error: readSucceeded ? null : firstError,
  };
}

function addressBookDatabasePaths() {
  const addressBookDir = join(homedir(), "Library", "Application Support", "AddressBook");
  try {
    const raw = execFileSync("find", [addressBookDir, "-maxdepth", "4", "-name", "AddressBook-v22.abcddb"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return [...new Set(raw.split("\n").map((path) => path.trim()).filter(Boolean))];
  } catch {
    return [join(addressBookDir, "AddressBook-v22.abcddb")];
  }
}

function addressBookWalPaths() {
  if (platform() !== "darwin") return [];
  const paths = new Set([CONTACTS_WAL_PATH]);
  for (const dbPath of addressBookDatabasePaths()) {
    paths.add(`${dbPath}-wal`);
  }
  return [...paths].filter((path) => existsSync(path));
}

function addHandleMapping(map, handle, name) {
  for (const candidate of handleCandidates(handle)) {
    map.set(candidate, name);
  }
}

function addSelfHandle(set, handle) {
  for (const candidate of handleCandidates(handle)) {
    set.add(candidate);
  }
}

function handleCandidates(handle) {
  const raw = String(handle ?? "").trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const normalized = normalizeHandle(raw);
  const candidates = new Set([raw, lower, normalized]);
  if (normalized.startsWith("+1") && normalized.length === 12) {
    candidates.add(normalized.slice(2));
  }
  if (/^\d{10}$/.test(normalized)) {
    candidates.add(`+1${normalized}`);
  }
  return [...candidates].filter(Boolean);
}

function normalizeHandle(handle) {
  const raw = String(handle ?? "").trim();
  if (raw.includes("@")) return raw.toLowerCase();
  const compact = raw.replace(/[^\d+]/g, "");
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  return compact || raw.toLowerCase();
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function searchTextMatches(value, query) {
  const haystack = normalizeSearchText(value);
  const needle = normalizeSearchText(query);
  if (!haystack || needle.length < 2) return false;
  if (haystack.includes(needle)) return true;
  const tokens = needle.split(/\s+/).filter((token) => token.length >= 2);
  return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
}

function cleanChatName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed || null;
}

function nonHandleChatName(name) {
  if (!name) return null;
  return looksLikeHandleList(name) ? null : name;
}

function looksLikeHandleList(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const tokens = text
    .split(/[,;/&\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((token) => {
    if (token.includes("@")) return true;
    const digits = token.replace(/\D/g, "");
    if (digits.length >= 4 && /^[+()\-\d.\s]+$/.test(token)) return true;
    return /^\d{4,}$/.test(token);
  });
}

function parseDmHandleFromChatId(chatId) {
  const parts = String(chatId ?? "").split(";");
  if (parts.length >= 3 && parts[1] === "-") return parts.slice(2).join(";") || null;
  return null;
}

function messageChatTouchesShepherdAgent(chat) {
  if (isShepherdAgentMessageHandle(parseDmHandleFromChatId(chat?.chatId))) return true;
  return Array.isArray(chat?.participants)
    && chat.participants.some((participant) => isShepherdAgentMessageHandle(participant?.handle));
}

function messageTouchesShepherdAgent(msg) {
  return isShepherdAgentMessageHandle(msg?.participant)
    || isShepherdAgentMessageHandle(msg?.affectedParticipant)
    || isShepherdAgentMessageHandle(parseDmHandleFromChatId(msg?.chatId));
}

function isShepherdAgentMessageHandle(handle) {
  if (!SHEPHERD_OWNED_MESSAGE_HANDLES.length) return false;
  const blocked = new Set(SHEPHERD_OWNED_MESSAGE_HANDLES.flatMap(handleCandidates));
  return handleCandidates(handle).some((candidate) => blocked.has(candidate));
}

function parseMessageHandleList(value) {
  return String(value ?? "")
    .split(",")
    .map((handle) => handle.trim())
    .filter(Boolean);
}

function mergeShepherdOwnedMessageHandles(value) {
  for (const handle of Array.isArray(value) ? value : parseMessageHandleList(value)) {
    if (typeof handle !== "string" || !handle.trim()) continue;
    if (!SHEPHERD_OWNED_MESSAGE_HANDLES.includes(handle.trim())) {
      SHEPHERD_OWNED_MESSAGE_HANDLES.push(handle.trim());
    }
  }
}

function parseSelectionIndexes(answer, max) {
  const indexes = new Set();
  for (const part of String(answer ?? "").split(/[,\s]+/).map((value) => value.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let value = Math.min(start, end); value <= Math.max(start, end); value++) {
        if (value >= 1 && value <= max) indexes.add(value - 1);
      }
      continue;
    }
    const value = Number(part);
    if (Number.isInteger(value) && value >= 1 && value <= max) indexes.add(value - 1);
  }
  return [...indexes].sort((a, b) => a - b);
}

function parseMessageChatIdsArg() {
  return parseAllowedChatIds(args["messages-chat-ids"] ?? args["message-chat-ids"] ?? args["messages-chats"]);
}

function parseAllowedChatIds(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const values = raw.map((chatId) => String(chatId).trim()).filter(Boolean);
  if (values.some((chatId) => chatId.toLowerCase() === "all" || chatId === ALL_MESSAGES_CHATS)) {
    return [ALL_MESSAGES_CHATS];
  }
  return [...new Set(values)];
}

function selectedChatIdsIncludeAll(chatIds) {
  return Array.isArray(chatIds) && chatIds.includes(ALL_MESSAGES_CHATS);
}

function html(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlAttr(value) {
  return html(value).replace(/"/g, "&quot;");
}

function codingSessionsScanOptions(command, previousState) {
  if (command) return codingSessionsCommandScanOptions(command);
  if (codingSessionsStateIsEmpty(previousState)) return { exhaustive: true };
  return {};
}

function codingSessionsStateIsEmpty(previousState) {
  const hashes = previousState && typeof previousState === "object" ? previousState.hashes : null;
  return !hashes || typeof hashes !== "object" || Object.keys(hashes).length === 0;
}

function codingSessionsCommandScanOptions(command) {
  if (!command) return {};
  const payload = objectValue(command.payload) ?? {};
  const maxFiles = positiveCommandInteger(payload.maxFiles);
  const providers = Array.isArray(payload.providers)
    ? payload.providers.map((provider) => stringValue(provider)).filter(Boolean)
    : [];
  const type = stringValue(command.type);
  if (type === "source_sync") {
    // procmem: a source_sync is a full local inventory (gigabrain d6561caf semantics). maxFiles bounds rescans,
    // not the inventory; a sync is bounded only when the command explicitly sets fullInventory: false, and its
    // receipt then reports capHit/fullInventory: false so coverage stays partial.
    return {
      exhaustive: true,
      ...(payload.fullInventory === false
        ? { maxFiles: maxFiles ?? DEFAULT_CODING_SESSION_FILES_PER_PROVIDER }
        : { fullInventory: true }),
      ...(providers.length ? { providers } : {}),
    };
  }
  return {
    ...(maxFiles ? { maxFiles } : {}),
    ...(providers.length ? { providers } : {}),
  };
}

function codingSessionsCommandPlan(command, scan, previousState) {
  const base = codingSessionsCommandDiagnostics(scan, previousState);
  if (!command) return { sessions: [], force: false, exactSelection: false, result: base };
  const payload = objectValue(command.payload) ?? {};
  const type = stringValue(command.type);
  const maxFiles = positiveCommandInteger(payload.maxFiles) ?? DEFAULT_CODING_SESSION_FILES_PER_PROVIDER;
  const force = type === "force_rescan" ? true : payload.force === false ? false : true;

  if (type === "source_sync") {
    const sourceSyncRunId = stringValue(payload.sourceSyncRunId);
    const coverageTo = stringValue(payload.coverageTo);
    const coverageFromProvided = Object.prototype.hasOwnProperty.call(payload, "coverageFrom");
    const coverageFrom = stringValue(payload.coverageFrom);
    if (!sourceSyncRunId) {
      return codingSessionsCommandErrorPlan(base, type, "sourceSyncRunId is required for source_sync", payload);
    }
    if (!dateFromCommand(coverageTo)) {
      return codingSessionsCommandErrorPlan(base, type, "valid coverageTo is required for source_sync", payload);
    }
    if (coverageFromProvided && payload.coverageFrom !== null && !dateFromCommand(coverageFrom)) {
      return codingSessionsCommandErrorPlan(base, type, "valid coverageFrom is required for source_sync", payload);
    }
    return {
      sessions: scan.sessions,
      force: true,
      exactSelection: true,
      sourceSync: true,
      payload,
      result: {
        commandType: type,
        selectedForUpload: scan.sessions.length,
      },
    };
  }

  if (type === "force_rescan" || type === "backfill_recent") {
    const sessions = selectCodingSessionsPerProvider(scan.sessions, maxFiles);
    return {
      sessions,
      force,
      exactSelection: true,
      result: {
        ...base,
        commandType: type,
        force,
        selectedForUpload: sessions.length,
        maxFiles,
      },
    };
  }

  if (type === "repair_status" || type === "upload_diagnostics") {
    return {
      sessions: [],
      force: false,
      exactSelection: false,
      result: {
        ...base,
        commandType: type,
        selectedForUpload: 0,
      },
    };
  }

  return codingSessionsCommandErrorPlan(
    base,
    type,
    `Unsupported Coding Sessions agent command: ${type ?? "unknown"}`,
    payload,
  );
}

function codingSessionsCommandErrorPlan(base, type, error, payload = {}) {
  return {
    sessions: [],
    force: false,
    exactSelection: true,
    sourceSync: type === "source_sync",
    payload,
    error,
    result: {
      ...base,
      commandType: type,
      selectedForUpload: 0,
      error,
    },
  };
}

function codingSessionsSourceSyncReceipt({
  command,
  commandPlan,
  scan,
  sendResult,
  uploadQueued,
  remainingQueueDepth,
  startedAt,
  finishedAt,
}) {
  const payload = objectValue(command.payload) ?? {};
  const sentStored = countValue(sendResult.stored);
  const sentUpdated = countValue(sendResult.updated);
  const sentSkipped = countValue(sendResult.skipped);
  const pendingUploads = Math.max(countValue(sendResult.queued), countValue(remainingQueueDepth));
  const uploadFailures = uploadQueued ? Math.max(1, pendingUploads) : 0;
  const inventoryFailures = (Array.isArray(scan.errors) ? scan.errors.length : 0) + (scan.capped === true ? 1 : 0);
  const failedCount = uploadFailures + inventoryFailures;
  const sessionsSeen = scan.sessions.length;
  const highWatermark = maxIso(scan.sessions.map((session) => session.lastUpdatedAt).filter(Boolean))
    ?? stringValue(payload.coverageTo)
    ?? finishedAt;

  return {
    receiptVersion: 1,
    sourceSyncRunId: stringValue(payload.sourceSyncRunId),
    commandId: command.id,
    provider: "coding_sessions",
    agentVersion: PACKAGE_VERSION,
    parserVersion: CODING_SESSION_PARSER_VERSION,
    startedAt,
    finishedAt,
    coverageFrom: Object.prototype.hasOwnProperty.call(payload, "coverageFrom") ? stringValue(payload.coverageFrom) : null,
    coverageTo: stringValue(payload.coverageTo) ?? finishedAt,
    fullInventory: scan.capped !== true,
    maxFilesPerProvider: payload.fullInventory === false
      ? positiveCommandInteger(payload.maxFiles) ?? DEFAULT_CODING_SESSION_FILES_PER_PROVIDER
      : null,
    exhausted: failedCount === 0 && pendingUploads === 0,
    capHit: scan.capped === true,
    highWatermark,
    rootProbes: sanitizeCodingSessionProbes(scan.probes),
    filesDiscovered: countValue(scan.filesDiscovered),
    filesParsed: countValue(scan.filesParsed),
    parseErrors: Array.isArray(scan.errors) ? scan.errors.length : 0,
    sessionsSeen,
    sessionsEligible: sessionsSeen,
    localFilesSeen: countValue(scan.filesDiscovered),
    sessionsUploaded: sentStored + sentUpdated + sentSkipped,
    uploadedSessions: sentStored + sentUpdated + sentSkipped,
    sessionsSkippedUnchanged: sentSkipped,
    pendingUploads,
    failedUploads: uploadFailures,
    pendingCount: pendingUploads,
    failedCount,
    queueDepth: pendingUploads,
    manifestHash: codingSessionsManifestHash(scan.sessions, stringValue(payload.sourceSyncRunId)),
    selectedForUpload: commandPlan.sessions.length,
    sent: sendResult,
  };
}

function selectCodingSessionsPerProvider(sessions, maxFilesPerProvider) {
  const counts = {};
  const selected = [];
  for (const session of sessions) {
    const provider = session.provider ?? "unknown";
    const count = counts[provider] ?? 0;
    if (count >= maxFilesPerProvider) continue;
    counts[provider] = count + 1;
    selected.push(session);
  }
  return selected;
}

function codingSessionsCommandDiagnostics(scan, previousState) {
  const providerCounts = {};
  const providerStatus = codingSessionsProviderStatus(scan, previousState, []);
  let userMessages = 0;
  let agentResponses = 0;
  let sessionsWithVisibleTranscript = 0;
  let unchanged = 0;
  for (const session of scan.sessions) {
    providerCounts[session.provider] = (providerCounts[session.provider] ?? 0) + 1;
    const sessionUserMessages = Array.isArray(session.userMessages) ? session.userMessages.length : 0;
    const sessionAgentResponses = Array.isArray(session.agentResponses) ? session.agentResponses.length : 0;
    userMessages += sessionUserMessages;
    agentResponses += sessionAgentResponses;
    if (sessionUserMessages > 0 || sessionAgentResponses > 0) sessionsWithVisibleTranscript++;
    if (previousState.hashes?.[session.sourcePathHash] === session.contentHash) unchanged++;
  }
  return {
    parserVersion: CODING_SESSION_PARSER_VERSION,
    scanned: scan.sessions.length,
    uploadable: scan.sessions.length,
    filesDiscovered: scan.filesDiscovered ?? scan.sessions.length,
    filesSelected: scan.filesSelected ?? scan.sessions.length,
    filesIgnored: Math.max(0, Number(scan.filesDiscovered ?? scan.sessions.length) - scan.sessions.length),
    filesParsed: scan.filesParsed ?? scan.sessions.length,
    capped: scan.capped === true,
    unchanged,
    changed: scan.sessions.length - unchanged,
    sessionsWithVisibleTranscript,
    userMessages,
    agentResponses,
    providerCounts,
    providerStatus,
    probes: sanitizeCodingSessionProbes(scan.probes),
    errors: sanitizeCodingSessionErrors(scan.errors),
  };
}

function codingSessionsProviderStatus(scan, previousState, selectedSessions = []) {
  const status = {};
  const inventory = scan.providerStatus && typeof scan.providerStatus === "object" && !Array.isArray(scan.providerStatus)
    ? scan.providerStatus
    : {};
  for (const provider of ["codex", "claude"]) {
    const providerSessions = scan.sessions.filter((session) => session.provider === provider);
    const selected = selectedSessions.filter((session) => session.provider === provider);
    const unchanged = providerSessions.filter((session) => previousState.hashes?.[session.sourcePathHash] === session.contentHash).length;
    const raw = inventory[provider] && typeof inventory[provider] === "object" && !Array.isArray(inventory[provider])
      ? inventory[provider]
      : {};
    const filesDiscovered = countValue(raw.filesDiscovered);
    const filesSelected = countValue(raw.filesSelected);
    const uploadable = providerSessions.length;
    status[provider] = {
      filesDiscovered,
      filesSelected,
      filesIgnored: Math.max(0, filesDiscovered - uploadable),
      uploadable,
      scanned: uploadable,
      unchanged,
      changed: Math.max(0, uploadable - unchanged),
      selected: selected.length,
      capped: raw.capped === true,
    };
  }
  return status;
}

function sanitizeCodingSessionProbes(probes) {
  if (!Array.isArray(probes)) return [];
  return probes.map((probe) => ({
    provider: stringValue(probe?.provider),
    readable: probe?.readable === true,
    directory: probe?.directory === true,
  }));
}

function sanitizeCodingSessionErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => ({
    provider: stringValue(error?.provider),
    pathHash: stringValue(error?.pathHash),
    ...(error?.error ? { errorHash: receiptWatermark(String(error.error)) } : {}),
  }));
}

function codingSessionsManifestHash(sessions, sourceSyncRunId = null) {
  const manifest = sessions
    .map((session) => ({
      provider: session.provider,
      sourcePathHash: session.sourcePathHash,
      contentHash: session.contentHash,
      lastUpdatedAt: session.lastUpdatedAt,
    }))
    .sort((a, b) => String(a.sourcePathHash ?? "").localeCompare(String(b.sourcePathHash ?? "")));
  return receiptWatermark(`${sourceSyncRunId ?? "unknown-source-sync-run"}:${hashObject(manifest)}`);
}

function countValue(value) {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dedupeCodingSessions(sessions) {
  const byPath = new Map();
  for (const session of sessions) {
    byPath.set(session.sourcePathHash, session);
  }
  return [...byPath.values()];
}

function positiveCommandInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function scanCodingSessions(config, previousState = { hashes: {} }, options = {}) {
  const probes = await probeCodingSessionPaths(config);
  const errors = [];
  const sessions = [];
  const providers = codingSessionProvidersFromConfig(config, options);
  const codexDirs = providers.openai ? codingSessionCodexDirs(config) : [];
  const claudeDir = providers.anthropic ? codingSessionClaudeDir(config) : null;
  const maxFilesPerProvider = codingSessionMaxFilesPerProvider(config, options);
  const inventory = await codingSessionJsonlFiles({ codexDirs, claudeDir, errors, maxFilesPerProvider });
  const files = inventory.files;

  for (const file of files) {
    const parsed = await parseCodingSessionFile(file, config).catch((err) => {
      errors.push({ provider: file.provider, pathHash: hashString(file.path), error: safeError(err) });
      return null;
    });
    if (parsed) sessions.push(parsed);
  }

  return {
    probes,
    errors,
    filesDiscovered: inventory.filesDiscovered,
    filesSelected: files.length,
    filesParsed: sessions.length,
    providerStatus: inventory.providerStatus,
    capped: inventory.capped,
    sessions,
    previousState,
  };
}

function codingSessionMaxFilesPerProvider(config, options = {}) {
  if (options.fullInventory === true) return Number.MAX_SAFE_INTEGER;
  return positiveCommandInteger(options.maxFiles)
    ?? positiveCommandInteger(config.maxFilesPerProvider)
    ?? DEFAULT_CODING_SESSION_FILES_PER_PROVIDER;
}

async function probeCodingSessionPaths(config) {
  const probes = [];
  const providers = codingSessionProvidersFromConfig(config);
  const codexDirs = providers.openai ? codingSessionCodexDirs(config) : [];
  for (const path of codexDirs) probes.push(await probePath("codex", path));
  const claudeDir = providers.anthropic ? codingSessionClaudeDir(config) : null;
  if (claudeDir) probes.push(await probePath("claude", claudeDir));
  return probes;
}

function codingSessionProvidersFromConfig(config, options = {}) {
  const providers = config?.providers && typeof config.providers === "object" && !Array.isArray(config.providers)
    ? config.providers
    : null;
  const filter = codingSessionProviderFilter(options.providers);
  return {
    openai: filter.openai && (providers?.openai === false ? false : codingSessionCodexDirs(config).length > 0),
    anthropic: filter.anthropic && (providers?.anthropic === false ? false : Boolean(codingSessionClaudeDir(config))),
  };
}

function codingSessionProviderFilter(value) {
  if (!Array.isArray(value) || value.length === 0) return { openai: true, anthropic: true };
  const normalized = new Set(value.map((provider) => String(provider).trim().toLowerCase()).filter(Boolean));
  return {
    openai: normalized.has("codex") || normalized.has("openai"),
    anthropic: normalized.has("claude") || normalized.has("anthropic"),
  };
}

function codingSessionCodexDirs(config) {
  return Array.isArray(config?.codexDirs) ? config.codexDirs : [CODEX_SESSIONS_DIR, CODEX_ARCHIVED_SESSIONS_DIR];
}

function codingSessionClaudeDir(config) {
  if (config && Object.prototype.hasOwnProperty.call(config, "claudeProjectsDir")) {
    return typeof config.claudeProjectsDir === "string" && config.claudeProjectsDir.trim()
      ? config.claudeProjectsDir
      : null;
  }
  return CLAUDE_PROJECTS_DIR;
}

async function probePath(provider, path) {
  try {
    await access(path, fsConstants.R_OK);
    const info = await stat(path);
    return { provider, path, readable: true, directory: info.isDirectory() };
  } catch (err) {
    return { provider, path, readable: false, reason: err?.code ?? safeError(err) };
  }
}

async function codingSessionJsonlFiles({ codexDirs, claudeDir, errors, maxFilesPerProvider }) {
  const codexFiles = [];
  const claudeFiles = [];
  for (const dir of codexDirs) {
    await walkJsonl(dir, "codex", codexFiles, errors).catch((err) => {
      if (err?.code !== "ENOENT") errors.push({ provider: "codex", pathHash: hashString(dir), error: safeError(err) });
    });
  }
  if (claudeDir) {
    await walkJsonl(claudeDir, "claude", claudeFiles, errors).catch((err) => {
      if (err?.code !== "ENOENT") errors.push({ provider: "claude", pathHash: hashString(claudeDir), error: safeError(err) });
    });
  }
  const files = [
    ...newestCodingSessionFiles(codexFiles, maxFilesPerProvider),
    ...newestCodingSessionFiles(claudeFiles, maxFilesPerProvider),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs || a.provider.localeCompare(b.provider) || a.path.localeCompare(b.path));
  const filesDiscovered = codexFiles.length + claudeFiles.length;
  const providerStatus = {
    codex: {
      filesDiscovered: codexFiles.length,
      filesSelected: Math.min(codexFiles.length, maxFilesPerProvider),
      capped: codexFiles.length > maxFilesPerProvider,
    },
    claude: {
      filesDiscovered: claudeFiles.length,
      filesSelected: Math.min(claudeFiles.length, maxFilesPerProvider),
      capped: claudeFiles.length > maxFilesPerProvider,
    },
  };
  return {
    files,
    filesDiscovered,
    filesSelected: files.length,
    providerStatus,
    capped: files.length < filesDiscovered,
  };
}

function newestCodingSessionFiles(files, maxFiles) {
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    .slice(0, maxFiles);
}

async function walkJsonl(dir, provider, files, errors = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(path, provider, files, errors).catch((err) => {
        errors.push({ provider, pathHash: hashString(path), error: safeError(err) });
      });
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const info = await stat(path).catch(() => null);
      if (info) files.push({ provider, path, mtimeMs: info.mtimeMs });
    }
  }
}

async function parseCodingSessionFile(file, config) {
  if (file.provider === "codex") return parseCodexSessionFile(file.path, config);
  if (file.provider === "claude") return parseClaudeSessionFile(file.path, config);
  return null;
}

async function parseCodexSessionFile(path, config) {
  const lines = await readJsonlRecords(path);
  if (lines.length === 0) return null;
  const meta = codexSessionMeta(lines);
  const sessionId = stringValue(meta?.session_id);
  if (!meta || !sessionId) return null;
  if (codexSessionMetaIsChildAgent(meta)) return null;
  const timestamps = lines.map(codexRecordTimestamp).filter(Boolean);
  const cwd = stringValue(meta.cwd);
  const repo = await repoMetadata(cwd);
  const actor = await actorMetadata(cwd, config);
  const transcript = parseCodexTranscript(lines);
  const title = stringValue(meta.title);
  const lastTimestamp = maxIso(timestamps);
  const session = {
    schemaVersion: 2,
    parserVersion: CODING_SESSION_PARSER_VERSION,
    provider: "codex",
    sessionId: cleanSessionId(sessionId),
    startedAt: isoDate(meta.timestamp),
    endedAt: lastTimestamp,
    lastUpdatedAt: lastTimestamp,
    status: "unknown",
    actor,
    repo,
    cwdHash: cwd ? hashString(cwd) : null,
    cwdBasename: cwd ? basename(cwd) : null,
    title: title ? redactText(title, 180) : null,
    userMessages: transcript.userMessages,
    agentResponses: transcript.agentResponses,
    sourcePathHash: hashString(path),
  };
  session.contentHash = hashObject(session);
  return session;
}

async function parseClaudeSessionFile(path, config) {
  const lines = await readJsonlRecords(path);
  if (lines.length === 0) return null;
  const timestamps = lines.map((line) => isoDate(line.timestamp)).filter(Boolean);
  const sessionId = claudeSessionId(lines);
  if (!sessionId) return null;
  if (claudeSessionIsSidechain(lines)) return null;
  const cwd = claudeCwd(lines);
  const repo = await repoMetadata(cwd);
  const actor = await actorMetadata(cwd, config);
  const title = claudeTitle(lines);
  const transcript = parseClaudeTranscript(lines);
  const lastTimestamp = maxIso(timestamps);
  const session = {
    schemaVersion: 2,
    parserVersion: CODING_SESSION_PARSER_VERSION,
    provider: "claude",
    sessionId: cleanSessionId(sessionId),
    startedAt: minIso(timestamps),
    endedAt: lastTimestamp,
    lastUpdatedAt: lastTimestamp,
    status: "unknown",
    actor,
    repo: {
      ...repo,
      branch: repo.branch ?? claudeGitBranch(lines),
    },
    cwdHash: cwd ? hashString(cwd) : null,
    cwdBasename: cwd ? basename(cwd) : null,
    title: title ? redactText(title, 180) : null,
    userMessages: transcript.userMessages,
    agentResponses: transcript.agentResponses,
    sourcePathHash: hashString(path),
  };
  session.contentHash = hashObject(session);
  return session;
}

async function readJsonlRecords(path) {
  const raw = await readFile(path, "utf8");
  const rawLines = raw
    .split("\n")
    .filter((line) => line.trim());
  const records = rawLines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error("Invalid JSONL record");
    }
  });
  return records;
}

async function repoMetadata(cwd) {
  const base = { fullName: null, remote: null, branch: null, commit: null };
  if (!cwd) return base;
  const remote = await gitValue(cwd, ["config", "--get", "remote.origin.url"]);
  const branch = await gitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = await gitValue(cwd, ["rev-parse", "--short", "HEAD"]);
  return {
    fullName: null,
    remote: remote ? redactCredentialUrl(remote) : null,
    branch,
    commit,
  };
}

async function actorMetadata(cwd, config) {
  const email = config.actorEmail ?? await gitValue(cwd, ["config", "user.email"]) ?? await gitValue(null, ["config", "--global", "user.email"]);
  const name = config.actorName ?? await gitValue(cwd, ["config", "user.name"]) ?? await gitValue(null, ["config", "--global", "user.name"]);
  return { email: email ?? null, name: name ?? null };
}

async function gitValue(cwd, argv) {
  return new Promise((resolve) => {
    execFile("git", argv, { cwd: cwd || undefined, timeout: 2000, windowsHide: true }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(String(stdout).trim() || null);
    });
  });
}

function parseCodexTranscript(records) {
  const userMessages = [];
  const agentResponses = [];
  const seen = new Set();
  let order = 0;
  for (const record of records) {
    const timestamp = codexRecordTimestamp(record);
    const item = codexResponseItem(record);
    if (!item) continue;
    const role = item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : null;
    if (!role) continue;
    const phase = role === "assistant" ? codexAgentPhase(item) : null;
    if (phase === "commentary") continue;
    const text = cleanTranscriptText(codexMessageText(item, role));
    if (!text) continue;
    const providerItemId = stringValue(item.id);
    if (providerItemId) {
      const dedupeKey = `${role}:${providerItemId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }
    const message = {
      id: providerItemId,
      order,
      role,
      text,
      timestamp,
      providerType: stringValue(item.type),
      phase,
      source: "response_item",
    };
    order++;
    if (role === "user") userMessages.push(message);
    else agentResponses.push(message);
  }
  return { userMessages, agentResponses };
}

function codexSessionMeta(records) {
  for (const record of records) {
    if (record?.type === "session_meta" && objectValue(record.payload)) return record.payload;
  }
  return null;
}

function codexSessionMetaIsChildAgent(meta) {
  return Boolean(stringValue(meta?.parent_thread_id) || codexAgentPathPresent(meta?.agent_path));
}

function codexAgentPathPresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(stringValue(value));
}

function codexResponseItem(record) {
  if (record?.type !== "response_item") return null;
  const item = objectValue(record.payload);
  if (!item || item.type !== "message") return null;
  return item;
}

function codexRecordTimestamp(record) {
  return isoDate(record?.timestamp);
}

function codexMessageText(item, role) {
  return codexTextParts(item.content, role).join("\n\n");
}

function codexTextParts(value, role) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => codexTextParts(item, role));
  if (!value || typeof value !== "object") return [];
  const expected = role === "user" ? "input_text" : "output_text";
  if (value.type !== expected) return [];
  return typeof value.text === "string" ? [value.text] : [];
}

function codexAgentPhase(item) {
  if (item.phase === "final_answer" || item.phase === "commentary") return item.phase;
  return null;
}

function parseClaudeTranscript(records) {
  const userMessages = [];
  const agentResponses = [];
  let order = 0;
  for (const record of records) {
    if (record?.isSidechain === true) continue;
    const message = record?.message;
    if (!message || typeof message !== "object") continue;
    const role = record.type === "user" && message.role === "user"
      ? "user"
      : record.type === "assistant" && message.role === "assistant"
        ? "assistant"
        : null;
    if (!role) continue;
    if (claudeMessageHasToolResult(message)) continue;
    const text = cleanTranscriptText(claudeMessageText(message.content));
    if (!role || !text) continue;
    const messageId = stringValue(record.uuid) ?? stringValue(message.id);
    const transcriptMessage = {
      id: messageId,
      order,
      role,
      text,
      timestamp: isoDate(record.timestamp),
      providerType: stringValue(record.type),
      phase: null,
      source: "claude_message",
    };
    order++;
    if (role === "user") userMessages.push(transcriptMessage);
    else agentResponses.push(transcriptMessage);
  }
  return { userMessages, agentResponses };
}

function claudeSessionIsSidechain(records) {
  let hasTranscriptRecords = false;
  for (const record of records) {
    const message = record?.message;
    if (!message || typeof message !== "object") continue;
    const isTranscriptRecord = (record.type === "user" && message.role === "user")
      || (record.type === "assistant" && message.role === "assistant");
    if (!isTranscriptRecord) continue;
    hasTranscriptRecords = true;
    if (record.isSidechain !== true) return false;
  }
  return hasTranscriptRecords;
}

function claudeMessageHasToolResult(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => item && typeof item === "object" && item.type === "tool_result");
}

function claudeMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n\n");
}

function cleanTranscriptText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return redactText(trimmed, CODING_SESSION_MESSAGE_TEXT_MAX_CHARS);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseJsonValue(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function claudeSessionId(records) {
  for (const record of records) {
    const value = stringValue(record?.sessionId);
    if (value) return value;
  }
  return null;
}

function claudeCwd(records) {
  for (const record of records) {
    const value = stringValue(record?.cwd);
    if (value) return value;
  }
  return null;
}

function claudeGitBranch(records) {
  for (const record of records) {
    const value = stringValue(record?.gitBranch);
    if (value) return value;
  }
  return null;
}

function claudeTitle(records) {
  for (const record of records) {
    if (record?.type !== "custom-title" && record?.type !== "ai-title") continue;
    const value = stringValue(record.title);
    if (value) return value;
  }
  return null;
}

function minIso(values) {
  return values.length ? values.sort()[0] : null;
}

function maxIso(values) {
  return values.length ? values.sort().at(-1) : null;
}

function cleanSessionId(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 200) || hashString(value).slice(0, 16);
}

function redactCredentialUrl(value) {
  return String(value).replace(/:\/\/[^/@]+@/g, "://[redacted]@");
}

function redactText(value, maxLength = 1000) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_=-]{12,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/g, "[redacted-credentials]@")
    .replace(/\b(authorization|x-api-key|api[_-]?key|token|secret|password)(\s*[:=]\s*)['"]?[^'"\s]+/gi, "$1$2[redacted]")
    .replace(/(OPENAI_API_KEY|FIREWORKS_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL|REDIS_URL)=\S+/g, "$1=[redacted]")
    .replace(new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "~")
    .slice(0, maxLength);
}

function hashString(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function hashObject(value) {
  return hashString(JSON.stringify(value));
}

function readCodingSessionsState(path) {
  const value = readJsonOptional(path);
  return value && typeof value === "object" && !Array.isArray(value)
    ? { hashes: value.hashes && typeof value.hashes === "object" ? value.hashes : {} }
    : { hashes: {} };
}

function codingSessionsStateFile(userId, channel = cliChannel()) {
  const path = join(homedir(), ".shepherd", "coding-sessions", `${channelFilePrefix(channel)}${safeFileId(userId)}-state.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function codingSessionsStatusFile(userId, channel = cliChannel()) {
  const path = join(homedir(), ".shepherd", "coding-sessions", `${channelFilePrefix(channel)}${safeFileId(userId)}-status.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

async function messagesConfigPathForUser(userId) {
  if (!userId) return null;
  const path = join(homedir(), ".shepherd", "raw-messages", `${channelFilePrefix(cliChannel())}${sanitizeUserFileId(userId)}.json`);
  return existsSync(path) ? path : null;
}

async function codingSessionsConfigPathForUser(userId) {
  if (!userId) return null;
  const path = join(homedir(), ".shepherd", "coding-sessions", `${channelFilePrefix(cliChannel())}${safeFileId(userId)}.json`);
  return existsSync(path) ? path : null;
}

async function latestMessagesConfigPath() {
  const dir = join(homedir(), ".shepherd", "raw-messages");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || isGeneratedMessagesAgentJson(entry.name)) continue;
      const path = join(dir, entry.name);
      const parsed = readJsonOptional(path);
      if (!parsed?.userId || !parsed?.agentToken) continue;
      if (normalizeLaunchAgentChannel(parsed?.channel) !== cliChannel()) continue;
      const info = await stat(path).catch(() => null);
      if (info) files.push({ path, mtimeMs: info.mtimeMs });
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
  } catch {
    return null;
  }
}

function isGeneratedMessagesAgentJson(fileName) {
  return /-(?:queue|state|status|complete|command-state|message-state|contacts-status|backfill-status)\.json$/.test(fileName)
    || fileName.includes("-backfill-progress-")
    || fileName.includes("-backfill-complete-");
}

async function latestCodingSessionsConfigPath() {
  const dir = join(homedir(), ".shepherd", "coding-sessions");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes("-state") || entry.name.includes("-status") || entry.name.includes("-queue")) continue;
      const path = join(dir, entry.name);
      const parsed = readJsonOptional(path);
      if (normalizeLaunchAgentChannel(parsed?.channel) !== cliChannel()) continue;
      const info = await stat(path).catch(() => null);
      if (info) files.push({ path, mtimeMs: info.mtimeMs });
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
  } catch {
    return null;
  }
}

async function productionOnboardingStatusForCodingSessions(config) {
  if (!config?.userId || !config?.apiUrl) return null;
  const local = await readOptionalAgentState().catch(() => null);
  if (!local?.sessionToken || local.sessionId !== config.userId) return null;
  return getJson(
    `${trimTrailingSlash(config.apiUrl)}/onboarding/raw/session/${encodeURIComponent(config.userId)}/status`,
    { token: local.sessionToken },
  );
}

function readJsonOptional(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

class CodingSessionsBatchSender {
  constructor(apiUrl, agentToken, userId, channel = cliChannel()) {
    this.apiUrl = trimTrailingSlash(apiUrl);
    this.agentToken = agentToken;
    this.userId = userId;
    this.channel = normalizeLaunchAgentChannel(channel);
    this.queueFile = join(homedir(), ".shepherd", "coding-sessions", `${channelFilePrefix(this.channel)}${safeFileId(userId)}-queue.json`);
  }

  async send(sessions, options = {}) {
    const bypassQueue = options.bypassQueue === true;
    const queueStatus = bypassQueue ? { ok: true, sessions: [] } : this.loadQueueStatus();
    if (!queueStatus.ok) {
      return {
        stored: 0,
        updated: 0,
        skipped: 0,
        queued: 1,
        error: queueStatus.error,
      };
    }
    const queued = queueStatus.sessions;
    const all = [...queued, ...sessions];
    if (!all.length) return { stored: 0, updated: 0, skipped: 0, queued: 0 };

    let totalStored = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    for (let i = 0; i < all.length; i += MAX_BATCH_SIZE) {
      const batch = all.slice(i, i + MAX_BATCH_SIZE);
      try {
        const result = await this.postBatch(batch, options);
        totalStored += result.stored ?? 0;
        totalUpdated += result.updated ?? 0;
        totalSkipped += result.skipped ?? 0;
      } catch (err) {
        if (options.queueOnFailure !== false) this.saveQueue(all.slice(i));
        console.error("Coding sessions batch send failed:", safeError(err));
        return {
          stored: totalStored,
          updated: totalUpdated,
          skipped: totalSkipped,
          queued: all.length - i,
          error: safeError(err),
        };
      }
    }

    if (!bypassQueue) this.clearQueue();
    return { stored: totalStored, updated: totalUpdated, skipped: totalSkipped, queued: 0 };
  }

  async postBatch(sessions, options = {}) {
    const res = await codingSessionsAgentFetch(`${this.apiUrl}/api/coding-sessions/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
      body: JSON.stringify({ userId: this.userId, sessions, ...(options.force ? { force: true } : {}) }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Coding sessions ingest failed (${res.status})`);
    return json;
  }

  async fetchCommand() {
    const res = await codingSessionsAgentFetch(`${this.apiUrl}/api/coding-sessions/ingest/command`, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
        "x-shepherd-agent-version": PACKAGE_VERSION,
        "x-shepherd-agent-capabilities": "source_sync_receipts",
      },
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Coding sessions command fetch failed (${res.status})`);
    return json.command ?? null;
  }

  async ackCommand(id, { status = "completed", result, error } = {}) {
    const res = await codingSessionsAgentFetch(`${this.apiUrl}/api/coding-sessions/ingest/command/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
      body: JSON.stringify({ id, status, result, error }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Coding sessions command ack failed (${res.status})`);
    return json;
  }

  loadQueue() {
    const queueStatus = this.loadQueueStatus();
    return queueStatus.ok ? queueStatus.sessions : [];
  }

  loadQueueStatus() {
    try {
      const queue = JSON.parse(readFileSync(this.queueFile, "utf8"));
      if (!Array.isArray(queue)) {
        return { ok: false, sessions: [], error: "Coding sessions retry queue is invalid" };
      }
      return { ok: true, sessions: queue };
    } catch (err) {
      if (err?.code === "ENOENT") return { ok: true, sessions: [] };
      return { ok: false, sessions: [], error: "Coding sessions retry queue could not be read" };
    }
  }

  queueDepth() {
    const queueStatus = this.loadQueueStatus();
    return queueStatus.ok ? queueStatus.sessions.length : 1;
  }

  saveQueue(sessions) {
    mkdirSync(dirname(this.queueFile), { recursive: true });
    writeFileSync(this.queueFile, JSON.stringify(sessions.slice(-MAX_QUEUE_MESSAGES)), { mode: 0o600 });
  }

  clearQueue() {
    try {
      unlinkSync(this.queueFile);
    } catch {
      // Queue is already empty.
    }
  }
}

function codingSessionsAgentFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(CODING_SESSIONS_HTTP_TIMEOUT_MS),
  });
}

class OfficeAudioBatchSender {
  constructor(apiUrl, agentToken, userId) {
    this.apiUrl = trimTrailingSlash(apiUrl);
    this.agentToken = agentToken;
    this.userId = userId;
  }

  async send(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return { stored: 0, updated: 0, skipped: 0 };
    const res = await fetch(`${this.apiUrl}/api/office-audio/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
      body: JSON.stringify({ userId: this.userId, sessions }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Office Audio ingest failed (${res.status})`);
    return json;
  }
}

class MessagesBatchSender {
  constructor(apiUrl, agentToken, userId, channel = cliChannel(), options = {}) {
    this.apiUrl = trimTrailingSlash(apiUrl);
    this.agentToken = agentToken;
    this.userId = userId;
    this.channel = normalizeLaunchAgentChannel(channel);
    this.deviceId = typeof options.deviceId === "string" && options.deviceId.trim() ? options.deviceId.trim() : null;
    this.agentVersion = typeof options.agentVersion === "string" && options.agentVersion.trim() ? options.agentVersion.trim() : PACKAGE_VERSION;
    this.agentChannel = typeof options.agentChannel === "string" && options.agentChannel.trim()
      ? normalizeLaunchAgentChannel(options.agentChannel)
      : this.channel;
    this.queueFile = join(homedir(), ".shepherd", "raw-messages", `${channelFilePrefix(this.channel)}${safeFileId(userId)}-queue.json`);
    this.sendChain = Promise.resolve();
    this.batchSize = clampInt(Number(options.batchSize ?? MESSAGES_UPLOAD_BATCH_SIZE), 1, 10_000);
    this.uploadConcurrency = clampInt(Number(options.uploadConcurrency ?? MESSAGES_UPLOAD_CONCURRENCY), 1, 32);
    this.maxQueueMessages = clampInt(Number(options.maxQueueMessages ?? MESSAGES_MAX_QUEUE_MESSAGES), 1, 1_000_000);
  }

  async send(messages) {
    const run = () => this.sendUnlocked(messages);
    const next = this.sendChain.then(run, run);
    this.sendChain = next.catch(() => undefined);
    return next;
  }

  async sendUnlocked(messages) {
    const queueStatus = this.loadQueueStatus();
    if (!queueStatus.ok) {
      return {
        stored: 0,
        updated: 0,
        skipped: 0,
        queued: 1,
        error: queueStatus.error,
      };
    }
    const queued = queueStatus.messages;
    const all = dedupeMessagePayloads([...queued, ...messages]);
    if (!all.length) return { stored: 0, updated: 0, skipped: 0, queued: 0 };

    let totalStored = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    const batches = [];
    for (let i = 0; i < all.length; i += this.batchSize) {
      batches.push({ start: i, messages: all.slice(i, i + this.batchSize) });
    }
    const results = await mapWithConcurrency(batches, this.uploadConcurrency, async (batch) => {
      try {
        return { batch, result: await this.postBatchAdaptive(batch.messages) };
      } catch (err) {
        return { batch, error: err };
      }
    });

    const firstFailure = results
      .filter((entry) => entry.error)
      .sort((a, b) => a.batch.start - b.batch.start)[0];
    const successfulBeforeFailure = results.filter((entry) =>
      !entry.error && (!firstFailure || entry.batch.start < firstFailure.batch.start));
    for (const entry of successfulBeforeFailure) {
      totalStored += countValue(entry.result?.stored);
      totalUpdated += countValue(entry.result?.updated);
      totalSkipped += countValue(entry.result?.skipped);
    }
    if (firstFailure) {
      const partial = messagesBatchPartialFailure(firstFailure.error);
      if (partial) {
        totalStored += countValue(partial.result?.stored);
        totalUpdated += countValue(partial.result?.updated);
        totalSkipped += countValue(partial.result?.skipped);
      }
      // Retry from the earliest failed batch so no later message is lost. Later
      // batches that already reached the backend may be resent; iMessage ingest
      // dedupes by canonical source id and skips unchanged duplicates.
      const remaining = all.slice(firstFailure.batch.start + (partial?.failedOffset ?? 0));
      this.saveQueue(remaining);
      console.error("Messages batch send failed:", safeError(firstFailure.error));
      return { stored: totalStored, updated: totalUpdated, skipped: totalSkipped, queued: remaining.length };
    }

    this.clearQueue();
    return { stored: totalStored, updated: totalUpdated, skipped: totalSkipped, queued: 0 };
  }

  async postBatch(messages) {
    const messagesWithMetadata = messages.map((message) => this.withAgentMetadata(message));
    const res = await messagesAgentFetch(`${this.apiUrl}/api/imessage/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
      body: JSON.stringify({ userId: this.userId, messages: messagesWithMetadata }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Messages ingest failed (${res.status})`);
    return json;
  }

  async postBatchAdaptive(messages) {
    try {
      return await this.postBatch(messages);
    } catch (err) {
      const minBatchSize = Math.max(1, Math.min(this.batchSize, MESSAGES_UPLOAD_SPLIT_MIN_BATCH_SIZE));
      if (messages.length <= minBatchSize || !isMessagesIngestRetryableError(err)) throw err;
      const midpoint = Math.ceil(messages.length / 2);
      console.warn(`Messages batch of ${messages.length} failed; retrying as ${midpoint} + ${messages.length - midpoint}: ${safeError(err)}`);
      let first;
      try {
        first = await this.postBatchAdaptive(messages.slice(0, midpoint));
      } catch (firstErr) {
        const partial = messagesBatchPartialFailure(firstErr);
        if (partial) throw new MessagesBatchPartialFailure(firstErr, partial.result, partial.failedOffset);
        throw firstErr;
      }
      try {
        const second = await this.postBatchAdaptive(messages.slice(midpoint));
        return mergeMessagesBatchResults(first, second);
      } catch (secondErr) {
        const partial = messagesBatchPartialFailure(secondErr);
        const partialResult = partial ? mergeMessagesBatchResults(first, partial.result) : first;
        throw new MessagesBatchPartialFailure(secondErr, partialResult, midpoint + (partial?.failedOffset ?? 0));
      }
    }
  }

  async syncContacts(contacts) {
    const res = await messagesAgentFetch(`${this.apiUrl}/api/imessage/ingest/sync-contacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
      body: JSON.stringify({ userId: this.userId, contacts }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Messages contact sync failed (${res.status})`);
    return json;
  }

  async postLocalStatus(status) {
    const statusWithMetadata = this.withAgentMetadata(publicMessagesBackfillStatus(status) ?? status);
    const res = await messagesAgentFetch(`${this.apiUrl}/api/imessage/ingest/local-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
      body: JSON.stringify({ status: statusWithMetadata }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Messages local status update failed (${res.status})`);
    return json;
  }

  withAgentMetadata(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return {
      ...value,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      agentVersion: this.agentVersion,
      agentChannel: this.agentChannel,
    };
  }

  async fetchCommand() {
    const res = await messagesAgentFetch(`${this.apiUrl}/api/imessage/ingest/command`, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Messages command fetch failed (${res.status})`);
    return json.command ?? null;
  }

  async ackCommand(id, { status = "completed", result, error } = {}) {
    const res = await messagesAgentFetch(`${this.apiUrl}/api/imessage/ingest/command/ack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.agentToken,
      },
      body: JSON.stringify({ id, status, result, error }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Messages command ack failed (${res.status})`);
    return json;
  }

  loadQueue() {
    const queueStatus = this.loadQueueStatus();
    return queueStatus.ok ? queueStatus.messages : [];
  }

  loadQueueStatus() {
    try {
      const queue = JSON.parse(readFileSync(this.queueFile, "utf8"));
      if (!Array.isArray(queue)) {
        return { ok: false, messages: [], error: "Messages retry queue is invalid" };
      }
      return { ok: true, messages: queue };
    } catch (err) {
      if (err?.code === "ENOENT") return { ok: true, messages: [] };
      return { ok: false, messages: [], error: "Messages retry queue could not be read" };
    }
  }

  queueDepth() {
    const queueStatus = this.loadQueueStatus();
    return queueStatus.ok ? queueStatus.messages.length : 1;
  }

  saveQueue(messages) {
    const capped = messages.slice(-this.maxQueueMessages);
    mkdirSync(dirname(this.queueFile), { recursive: true });
    const tmpFile = `${this.queueFile}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpFile, JSON.stringify(capped), { mode: 0o600 });
    renameSync(tmpFile, this.queueFile);
    if (capped.length < messages.length) {
      console.warn(`Messages queue trimmed from ${messages.length} to ${this.maxQueueMessages} messages`);
    }
  }

  clearQueue() {
    try {
      unlinkSync(this.queueFile);
    } catch {
      // Queue is already empty.
    }
  }
}

class MessagesBatchPartialFailure extends Error {
  constructor(cause, result, failedOffset) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "MessagesBatchPartialFailure";
    this.cause = cause;
    this.result = result;
    this.failedOffset = failedOffset;
  }
}

function messagesBatchPartialFailure(err) {
  return err instanceof MessagesBatchPartialFailure
    ? { result: err.result, failedOffset: Math.max(0, countValue(err.failedOffset)) }
    : null;
}

function mergeMessagesBatchResults(first, second) {
  return {
    stored: countValue(first?.stored) + countValue(second?.stored),
    updated: countValue(first?.updated) + countValue(second?.updated),
    skipped: countValue(first?.skipped) + countValue(second?.skipped),
    total: countValue(first?.total) + countValue(second?.total),
    processingEnqueueFailed: countValue(first?.processingEnqueueFailed) + countValue(second?.processingEnqueueFailed),
    chatTrackingFailed: countValue(first?.chatTrackingFailed) + countValue(second?.chatTrackingFailed),
    duplicateArchiveFailed: countValue(first?.duplicateArchiveFailed) + countValue(second?.duplicateArchiveFailed),
  };
}

function messagesAgentFetch(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(MESSAGES_HTTP_TIMEOUT_MS),
  });
}

function dedupeMessagePayloads(messages) {
  const entries = [];
  const keyed = new Map();
  for (const message of messages) {
    const key = messagePayloadIdentity(message);
    if (!key) {
      entries.push({ message });
      continue;
    }

    let entry = keyed.get(key);
    if (!entry) {
      entry = { key, message };
      keyed.set(key, entry);
      entries.push(entry);
    } else {
      entry.message = message;
    }
  }
  return entries.map((entry) => entry.message);
}

function messagePayloadIdentity(message) {
  const messageId = message?.messageId == null ? null : String(message.messageId);
  const providerMessageGuid = message?.providerMessageGuid == null ? null : String(message.providerMessageGuid).trim();
  if (providerMessageGuid && !/^[0-9]+$/.test(providerMessageGuid)) return `guid:${providerMessageGuid}`;
  const rowId = Number(message?.rowId);
  const chatId = message?.chatId == null ? null : String(message.chatId);
  if (Number.isFinite(rowId) && rowId > 0 && chatId) return `local:${chatId}:${rowId}`;
  if (messageId && chatId) return `local:${chatId}:${messageId}`;
  if (messageId) return `local:${messageId}`;
  return Number.isFinite(rowId) && rowId > 0 ? `row:${rowId}` : null;
}

function loadMessagesWatermark(userId, channel = cliChannel()) {
  try {
    const raw = readFileSync(messagesWatermarkFile(userId, channel), "utf8").trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function loadMessagesBackfillComplete(userId, scope, channel = cliChannel()) {
  const record = readJsonOptional(messagesBackfillCompleteFile(userId, scope, channel));
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  return record;
}

function saveMessagesBackfillComplete(userId, scope, result = {}, channel = cliChannel()) {
  const record = {
    completedAt: new Date().toISOString(),
    scope,
    ...result,
  };
  writeJsonAtomic(messagesBackfillCompleteFile(userId, scope, channel), record);
  return record;
}

function clearMessagesBackfillComplete(userId, scope, channel = cliChannel()) {
  try {
    unlinkSync(messagesBackfillCompleteFile(userId, scope, channel));
    return true;
  } catch {
    // Missing completion records are fine; explicit backfills should proceed.
    return false;
  }
}

function loadMessagesBackfillProgress(userId, scope, channel = cliChannel()) {
  const record = readJsonOptional(messagesBackfillProgressFile(userId, scope, channel));
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { version: 1, scope, cursors: {} };
  }
  const cursors = record.cursors && typeof record.cursors === "object" && !Array.isArray(record.cursors)
    ? record.cursors
    : {};
  return { ...record, version: 1, scope: record.scope ?? scope, cursors };
}

function loadMessagesBackfillProgressCursor(userId, scope, key, channel = cliChannel()) {
  const progress = loadMessagesBackfillProgress(userId, scope, channel);
  const value = Number(progress.cursors?.[key] ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function saveMessagesBackfillProgressCursor(userId, scope, key, rowId, channel = cliChannel()) {
  const numericRowId = Number(rowId);
  if (!Number.isFinite(numericRowId) || numericRowId <= 0) return;

  const progress = loadMessagesBackfillProgress(userId, scope, channel);
  const previous = Number(progress.cursors?.[key] ?? 0);
  progress.cursors = {
    ...progress.cursors,
    [key]: Math.max(Number.isFinite(previous) ? previous : 0, Math.floor(numericRowId)),
  };
  progress.updatedAt = new Date().toISOString();
  writeJsonAtomic(messagesBackfillProgressFile(userId, scope, channel), progress);
}

function clearMessagesBackfillProgress(userId, scope, channel = cliChannel()) {
  try {
    unlinkSync(messagesBackfillProgressFile(userId, scope, channel));
    return true;
  } catch {
    return false;
  }
}

function loadMessagesAgentCommandState(userId, channel = cliChannel()) {
  const record = readJsonOptional(messagesAgentCommandStateFile(userId, channel));
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  return record;
}

function saveMessagesAgentCommandState(userId, state, channel = cliChannel()) {
  writeJsonAtomic(messagesAgentCommandStateFile(userId, channel), state);
}

function clearMessagesAgentCommandState(userId, channel = cliChannel()) {
  try {
    unlinkSync(messagesAgentCommandStateFile(userId, channel));
  } catch {
    // Missing command state is fine.
  }
}

function messagesBackfillProgressKey(chatId) {
  return chatId == null ? "__all__" : `chat:${chatId}`;
}

function saveMessagesWatermark(userId, rowId, channel = cliChannel()) {
  const numericRowId = Number(rowId);
  if (!Number.isFinite(numericRowId) || numericRowId <= 0) return;

  try {
    const path = messagesWatermarkFile(userId, channel);
    const next = Math.max(loadMessagesWatermark(userId, channel), Math.floor(numericRowId));
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, String(next), { mode: 0o600 });
    renameSync(tmpPath, path);
  } catch (err) {
    console.error("Could not save Messages watermark:", safeError(err));
  }
}

function messagesWatermarkFile(userId, channel = cliChannel()) {
  const path = join(messagesRawMessagesDir(), `${channelFilePrefix(channel)}${safeFileId(userId)}-watermark`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function messagesBackfillCompleteFile(userId, scope, channel = cliChannel()) {
  const path = join(messagesRawMessagesDir(), `${channelFilePrefix(channel)}${safeFileId(userId)}-backfill-${hashObject(scope).slice(0, 24)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function messagesBackfillProgressFile(userId, scope, channel = cliChannel()) {
  const path = join(messagesRawMessagesDir(), `${channelFilePrefix(channel)}${safeFileId(userId)}-backfill-progress-${hashObject(scope).slice(0, 24)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function messagesAgentCommandStateFile(userId, channel = cliChannel()) {
  const path = join(messagesRawMessagesDir(), `${channelFilePrefix(channel)}${safeFileId(userId)}-command-state.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function messagesStateFile(userId, channel = cliChannel()) {
  const path = join(messagesRawMessagesDir(), `${channelFilePrefix(channel)}${safeFileId(userId)}-message-state.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function saveMessagesState(userId, state, channel = cliChannel()) {
  try {
    writeJsonAtomic(messagesStateFile(userId, channel), state);
  } catch (err) {
    console.error("Could not save Messages state:", safeError(err));
  }
}

function messagesContactStatusFile(userId, channel = cliChannel()) {
  const path = join(messagesRawMessagesDir(), `${channelFilePrefix(channel)}${safeFileId(userId)}-contacts-status.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function saveMessagesContactStatus(userId, status, channel = cliChannel()) {
  try {
    writeJsonAtomic(messagesContactStatusFile(userId, channel), status);
  } catch (err) {
    console.error("Could not save Messages contact status:", safeError(err));
  }
}

function messagesBackfillStatusFile(userId, channel = cliChannel()) {
  const path = join(messagesRawMessagesDir(), `${channelFilePrefix(channel)}${safeFileId(userId)}-backfill-status.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function saveMessagesBackfillStatus(userId, status, channel = cliChannel()) {
  try {
    writeJsonAtomic(messagesBackfillStatusFile(userId, channel), status);
  } catch (err) {
    console.error("Could not save Messages backfill status:", safeError(err));
  }
}

function messagesRawMessagesDir() {
  const path = join(homedir(), ".shepherd", "raw-messages");
  mkdirSync(path, { recursive: true });
  return path;
}

function writeJsonAtomic(path, value) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmpPath, path);
}

function maxRowId(messages) {
  return Math.max(0, ...messages.map((msg) => Number(msg.rowId ?? 0)).filter(Number.isFinite));
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stringArg(name) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredConfigString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Messages config missing ${label}`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function execFileQuiet(file, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, argv, { windowsHide: true }, (error) => {
      if (error && !opts.ignoreError) reject(error);
      else resolve(opts.captureError ? { error } : undefined);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${remainingSeconds}s`;
  return `${hours}h ${remainingMinutes}m`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeFileId(value) {
  return String(value).replace(/[^a-zA-Z0-9.-]/g, "-");
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function expandHomePath(value) {
  if (value === "~") return homedir();
  if (typeof value === "string" && value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function positiveIntFromEnv(name, defaultValue) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.floor(parsed);
}

function boundedIntFromEnv(name, defaultValue, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return defaultValue;
  return clampInt(parsed, min, max);
}

function parseMessagesInitialBackfillDays(value) {
  if (value === undefined || value === "") return null;
  if (value === null) return null;
  return parseBackfillDays(value, null);
}

function messagesBackfillDaysFromConfig(config) {
  if (config?.backfillAllHistory === true) return null;
  return parseBackfillDays(config?.backfillDays, null);
}

function parseBackfillDays(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "string" && value.trim().toLowerCase() === "all") return null;
  return clampInt(Number(value), 0, 36500);
}

function safeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/token|secret|key|database|postgres|redis|railway/i.test(message)) {
    return "source authorization did not validate; reconnect the source and retry";
  }
  return redactText(message, 1000);
}

function isMessagesIngestRetryableError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /aborted|timeout|timed out|fetch failed|econnreset|socket|network|502|503|504|429/i.test(message);
}

function rawErrorDetails(err) {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

export const __test = {
  messageChatKind,
  messageParticipant,
  messageState,
  sameMessageState,
  runMessagesBackfill,
  messagesBackfillScope,
  loadMessagesBackfillComplete,
  saveMessagesBackfillComplete,
  clearMessagesBackfillComplete,
  clearMessagesBackfillProgress,
  messagesBackfillProgressKey,
  loadMessagesBackfillProgressCursor,
  saveMessagesBackfillProgressCursor,
  messagesBackfillStatusFile,
  publicMessagesBackfillStatus,
  latestMessagesConfigPath,
  parseMessagesInitialBackfillDays,
  messagesBackfillDaysFromConfig,
  createMessagesBackfillGate,
  runWithMessagesBackfillGate,
  loadMessagesAgentCommandState,
  startMessagesBackfillMaintenance,
  startMessagesCommandPoller,
  MessagesBatchSender,
  enrichMessageChat,
  enrichMessageChatCandidates,
  routingErrorMessage,
};
