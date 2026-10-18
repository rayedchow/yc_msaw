import type {
  GranolaListResponse,
  GranolaNote,
  GranolaNoteListItem,
  GranolaTranscriptItem,
} from "./poller.js";

const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRecord = Record<string, unknown>;

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
};

export type GranolaMcpClient = {
  token: string;
  sessionId: string | null;
  tools: McpTool[] | null;
};

type ToolSpec = {
  tool: McpTool;
  idArg: "note_id" | "noteId" | "id";
};

export async function listGranolaNotesViaMcp(
  token: string,
  opts: {
    createdAfter?: string;
    updatedAfter?: string;
    folderId?: string;
    cursor?: string;
    pageSize?: number;
  } = {},
): Promise<GranolaListResponse> {
  const client = await createGranolaMcpClient(token);
  return listGranolaNotesWithMcpClient(client, opts);
}

export async function fetchGranolaNoteViaMcp(
  token: string,
  noteId: string,
  includeTranscript = true,
): Promise<{ note: GranolaNote; transcriptIncluded: boolean; transcriptError?: string; apiSource?: string }> {
  const client = await createGranolaMcpClient(token);
  return fetchGranolaNoteWithMcpClient(client, noteId, includeTranscript);
}

export async function createGranolaMcpClient(token: string): Promise<GranolaMcpClient> {
  return createMcpSession(token);
}

export async function listGranolaNotesWithMcpClient(
  client: GranolaMcpClient,
  opts: {
    createdAfter?: string;
    updatedAfter?: string;
    folderId?: string;
    cursor?: string;
    pageSize?: number;
  } = {},
): Promise<GranolaListResponse> {
  const tools = await listMcpTools(client);
  const tool = selectListNotesTool(tools);
  const payload = await callMcpTool(client, tool.name, listArgsForTool(tool, opts));
  return normalizeListResponse(payload);
}

export async function fetchGranolaNoteWithMcpClient(
  client: GranolaMcpClient,
  noteId: string,
  includeTranscript = true,
): Promise<{ note: GranolaNote; transcriptIncluded: boolean; transcriptError?: string; apiSource?: string }> {
  const tools = await listMcpTools(client);
  const detail = selectNoteTool(tools, includeTranscript);
  const notePayload = await callMcpTool(client, detail.tool.name, { [detail.idArg]: noteId });
  const note = normalizeNoteResponse(notePayload, noteId, null);
  if (includeTranscript && (!Array.isArray(note.transcript) || note.transcript.length === 0)) {
    note.transcript = await maybeFetchTranscript(client, tools, noteId);
  }
  return { note, transcriptIncluded: Array.isArray(note.transcript), apiSource: "granola_oauth_mcp" };
}

async function createMcpSession(token: string): Promise<GranolaMcpClient> {
  const session: GranolaMcpClient = { token, sessionId: null, tools: null };
  const initialized = await mcpRequest(session, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "shepherd-brain", version: "0.1.0" },
  });
  session.sessionId = initialized.sessionId ?? session.sessionId;
  await mcpNotification(session, "notifications/initialized", {});
  return session;
}

async function listMcpTools(session: GranolaMcpClient): Promise<McpTool[]> {
  if (session.tools) return session.tools;
  const response = await mcpRequest(session, "tools/list", {});
  const result = asRecord(response.result);
  const tools = Array.isArray(result.tools) ? result.tools.filter(isMcpTool) : [];
  session.tools = tools;
  return tools;
}

async function callMcpTool(session: GranolaMcpClient, name: string, args: JsonRecord): Promise<unknown> {
  const response = await mcpRequest(session, "tools/call", {
    name,
    arguments: args,
  });
  const result = asRecord(response.result);
  if (result.isError === true) {
    // Tool-level errors (e.g. "note not found" for a deleted note) must throw
    // instead of normalizing into a shell note with epoch timestamps.
    throw new Error(`Granola MCP tool ${name} failed: ${mcpToolErrorText(result).slice(0, 500)}`);
  }
  return extractMcpToolPayload(response.result);
}

function mcpToolErrorText(result: JsonRecord): string {
  if (Array.isArray(result.content)) {
    const texts = result.content
      .map((item) => {
        const content = asRecord(item);
        return content.type === "text" && typeof content.text === "string" ? content.text : null;
      })
      .filter((text): text is string => Boolean(text));
    if (texts.length > 0) return texts.join("; ");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "unknown tool error";
  }
}

async function mcpNotification(session: GranolaMcpClient, method: string, params: JsonRecord): Promise<void> {
  await postMcp(session, { jsonrpc: "2.0", method, params }, false);
}

async function mcpRequest(
  session: GranolaMcpClient,
  method: string,
  params: JsonRecord,
): Promise<{ result: unknown; sessionId: string | null }> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const data = await postMcp(session, { jsonrpc: "2.0", id, method, params }, true);
  const record = asRecord(data);
  if (record.error) {
    const error = asRecord(record.error);
    throw new Error(`Granola MCP ${method} failed: ${String(error.message ?? "unknown error")}`);
  }
  return {
    result: record.result,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
  };
}

async function postMcp(session: GranolaMcpClient, body: JsonRecord, expectResponse: boolean): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (session.sessionId) headers["MCP-Session-Id"] = session.sessionId;

  const res = await fetch(GRANOLA_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const nextSessionId = res.headers.get("mcp-session-id");
  if (nextSessionId) session.sessionId = nextSessionId;

  if (res.status === 202 && !expectResponse) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Granola MCP request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  if (!text.trim()) return null;
  const parsed = parseMcpResponseText(text, res.headers.get("content-type") ?? "");
  if (parsed && typeof parsed === "object" && nextSessionId) {
    (parsed as JsonRecord).sessionId = nextSessionId;
  }
  return parsed;
}

function parseMcpResponseText(text: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream") || text.trimStart().startsWith("event:") || text.trimStart().startsWith("data:")) {
    const payloads = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line && line !== "[DONE]");
    const last = payloads.at(-1);
    return last ? JSON.parse(last) : null;
  }
  return JSON.parse(text);
}

function selectListNotesTool(tools: McpTool[]): McpTool {
  const scored = tools
    .map((tool) => ({ tool, score: listToolScore(tool) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].tool;
  throw new Error("Granola MCP server does not expose a compatible note list tool.");
}

function listToolScore(tool: McpTool): number {
  const name = tool.name.toLowerCase();
  const props = schemaProps(tool);
  let score = 0;
  if (name === "granola_list_notes" || name === "list_notes") score += 100;
  if (name.includes("list") && name.includes("note")) score += 40;
  if (name.includes("search") && name.includes("note")) score += 20;
  if (props.has("updated_after") || props.has("updatedAfter")) score += 20;
  if (props.has("created_after") || props.has("createdAfter")) score += 15;
  if (props.has("cursor")) score += 15;
  if (props.has("page_size") || props.has("pageSize") || props.has("limit")) score += 10;
  if (name.includes("recent")) score -= 30;
  return score;
}

function selectNoteTool(tools: McpTool[], includeTranscript: boolean): ToolSpec {
  const scored = tools
    .map((tool) => ({ tool, idArg: noteIdArg(tool), score: noteToolScore(tool, includeTranscript) }))
    .filter((entry): entry is { tool: McpTool; idArg: ToolSpec["idArg"]; score: number } =>
      entry.score > 0 && entry.idArg !== null,
    )
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) throw new Error("Granola MCP server does not expose a compatible note detail tool.");
  return { tool: best.tool, idArg: best.idArg };
}

function noteToolScore(tool: McpTool, includeTranscript: boolean): number {
  const name = tool.name.toLowerCase();
  let score = 0;
  if (name === "granola_get_note_with_transcript") score += includeTranscript ? 120 : 90;
  if (name === "granola_get_note" || name === "get_note") score += 90;
  if (name.includes("get") && name.includes("note")) score += 45;
  if (name.includes("read") && name.includes("note")) score += 35;
  if (name.includes("summary")) score -= includeTranscript ? 30 : 0;
  if (name.includes("transcript")) score += includeTranscript ? 35 : -40;
  return score;
}

async function maybeFetchTranscript(
  session: GranolaMcpClient,
  tools: McpTool[],
  noteId: string,
): Promise<GranolaTranscriptItem[] | null> {
  const transcriptTool = tools
    .map((tool) => ({ tool, idArg: noteIdArg(tool), score: transcriptToolScore(tool) }))
    .filter((entry): entry is { tool: McpTool; idArg: ToolSpec["idArg"]; score: number } =>
      entry.score > 0 && entry.idArg !== null,
    )
    .sort((a, b) => b.score - a.score)[0];
  if (!transcriptTool) return null;
  const payload = await callMcpTool(session, transcriptTool.tool.name, { [transcriptTool.idArg]: noteId });
  const transcript = normalizeTranscript(payload);
  return transcript.length > 0 ? transcript : null;
}

function transcriptToolScore(tool: McpTool): number {
  const name = tool.name.toLowerCase();
  if (!name.includes("transcript")) return 0;
  let score = 50;
  if (name.includes("text")) score += 20;
  if (name.includes("note")) score += 10;
  return score;
}

function noteIdArg(tool: McpTool): ToolSpec["idArg"] | null {
  const props = schemaProps(tool);
  if (props.has("note_id")) return "note_id";
  if (props.has("noteId")) return "noteId";
  if (props.has("id")) return "id";
  return null;
}

function listArgsForTool(
  tool: McpTool,
  opts: {
    createdAfter?: string;
    updatedAfter?: string;
    folderId?: string;
    cursor?: string;
    pageSize?: number;
  },
): JsonRecord {
  const props = schemaProps(tool);
  const args: JsonRecord = {};
  setIfSupported(args, props, ["created_after", "createdAfter"], opts.createdAfter);
  setIfSupported(args, props, ["updated_after", "updatedAfter"], opts.updatedAfter);
  setIfSupported(args, props, ["folder_id", "folderId"], opts.folderId);
  setIfSupported(args, props, ["cursor"], opts.cursor);
  setIfSupported(args, props, ["page_size", "pageSize", "limit"], opts.pageSize);
  return args;
}

function setIfSupported(args: JsonRecord, props: Set<string>, names: string[], value: unknown): void {
  if (value === undefined || value === null) return;
  const name = names.find((candidate) => props.has(candidate));
  if (name) args[name] = value;
}

function normalizeListResponse(payload: unknown): GranolaListResponse {
  const record = asRecord(payload);
  const notesValue = Array.isArray(payload)
    ? payload
    : Array.isArray(record.notes)
      ? record.notes
      : Array.isArray(record.results)
        ? record.results
        : Array.isArray(record.data)
          ? record.data
          : [];
  const notes = notesValue.map(normalizeListItem).filter((item): item is GranolaNoteListItem => item !== null);
  return {
    notes,
    hasMore: record.hasMore === true || record.has_more === true,
    cursor: typeof record.cursor === "string" ? record.cursor : typeof record.next_cursor === "string" ? record.next_cursor : null,
  };
}

function normalizeListItem(value: unknown): GranolaNoteListItem | null {
  const record = asRecord(value);
  const id = stringValue(record.id ?? record.note_id ?? record.noteId);
  if (!id) return null;
  return {
    id,
    title: stringValue(record.title) ?? null,
    owner: normalizePerson(record.owner) ?? ownerFromFlat(record),
    created_at: stringValue(record.created_at ?? record.createdAt) ?? new Date(0).toISOString(),
    updated_at: stringValue(record.updated_at ?? record.updatedAt) ?? stringValue(record.created_at ?? record.createdAt) ?? new Date(0).toISOString(),
  };
}

/**
 * Keys the normalizer maps onto the typed note shape (including alternate
 * spellings). Anything else the MCP tool returns is preserved verbatim so
 * max capture is not lossy on the OAuth/MCP transport.
 */
const NORMALIZED_NOTE_KEYS = new Set([
  "id", "note_id", "noteId", "object", "title",
  "owner", "owner_name", "ownerName", "owner_email", "ownerEmail",
  "created_at", "createdAt", "updated_at", "updatedAt",
  "web_url", "webUrl", "calendar_event", "calendarEvent",
  "attendees", "folder_membership", "folderMembership",
  "summary_text", "summaryText", "summary", "summary_markdown", "summaryMarkdown",
  "transcript", "transcript_entries",
]);

function normalizeNoteResponse(payload: unknown, fallbackNoteId: string, transcriptOverride: GranolaTranscriptItem[] | null): GranolaNote {
  const record = asRecord(payload);
  const noteRecord = asRecord(record.note ?? record.result ?? record.data ?? record);
  const id = stringValue(noteRecord.id ?? noteRecord.note_id ?? noteRecord.noteId) ?? fallbackNoteId;
  const transcript = transcriptOverride ?? normalizeTranscript(noteRecord.transcript ?? noteRecord.transcript_entries);
  const extras: JsonRecord = {};
  for (const [key, value] of Object.entries(noteRecord)) {
    if (!NORMALIZED_NOTE_KEYS.has(key)) extras[key] = value;
  }
  return {
    ...extras,
    id,
    object: "note",
    title: stringValue(noteRecord.title) ?? null,
    owner: normalizePerson(noteRecord.owner) ?? ownerFromFlat(noteRecord),
    created_at: stringValue(noteRecord.created_at ?? noteRecord.createdAt) ?? new Date(0).toISOString(),
    updated_at: stringValue(noteRecord.updated_at ?? noteRecord.updatedAt)
      ?? stringValue(noteRecord.created_at ?? noteRecord.createdAt)
      ?? new Date(0).toISOString(),
    web_url: stringValue(noteRecord.web_url ?? noteRecord.webUrl) ?? undefined,
    calendar_event: normalizeCalendarEvent(noteRecord.calendar_event ?? noteRecord.calendarEvent),
    attendees: normalizePeopleArray(noteRecord.attendees),
    folder_membership: normalizeFolderMembership(noteRecord.folder_membership ?? noteRecord.folderMembership),
    summary_text: stringValue(noteRecord.summary_text ?? noteRecord.summaryText ?? noteRecord.summary) ?? null,
    summary_markdown: stringValue(noteRecord.summary_markdown ?? noteRecord.summaryMarkdown) ?? null,
    transcript,
  };
}

function normalizeTranscript(value: unknown): GranolaTranscriptItem[] {
  const items = Array.isArray(value) ? value : [];
  return items.flatMap((item): GranolaTranscriptItem[] => {
    const record = asRecord(item);
    const speakerRecord = asRecord(record.speaker);
    const diarization = stringValue(record.diarization_label ?? speakerRecord.diarization_label ?? speakerRecord.name);
    const source = stringValue(speakerRecord.source ?? record.source ?? speakerRecord.name);
    const text = stringValue(record.text) ?? "";
    if (!text) return [];
    const transcriptItem: GranolaTranscriptItem = {
      speaker: {
        source: source ?? undefined,
        diarization_label: diarization ?? undefined,
      },
      text,
    };
    const startTime = stringValue(record.start_time ?? record.startTime);
    const endTime = stringValue(record.end_time ?? record.endTime);
    if (startTime) transcriptItem.start_time = startTime;
    if (endTime) transcriptItem.end_time = endTime;
    return [transcriptItem];
  });
}

function normalizeCalendarEvent(value: unknown): GranolaNote["calendar_event"] {
  if (!value || typeof value !== "object") return null;
  const record = value as JsonRecord;
  return {
    event_title: stringValue(record.event_title ?? record.eventTitle ?? record.title) ?? null,
    invitees: Array.isArray(record.invitees) ? record.invitees.map((invitee) => ({
      email: stringValue(asRecord(invitee).email),
    })) : [],
    organiser: stringValue(record.organiser ?? record.organizer) ?? null,
    calendar_event_id: stringValue(record.calendar_event_id ?? record.calendarEventId ?? record.id) ?? null,
    scheduled_start_time: stringValue(record.scheduled_start_time ?? record.scheduledStartTime ?? record.start_at ?? record.startAt) ?? null,
    scheduled_end_time: stringValue(record.scheduled_end_time ?? record.scheduledEndTime ?? record.end_at ?? record.endAt) ?? null,
  };
}

function normalizePeopleArray(value: unknown): NonNullable<GranolaNote["attendees"]> {
  return Array.isArray(value)
    ? value.map(normalizePerson).filter((person): person is { name?: string | null; email?: string | null } => person !== null)
    : [];
}

function normalizePerson(value: unknown): { name?: string | null; email?: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as JsonRecord;
  return {
    name: stringValue(record.name) ?? null,
    email: stringValue(record.email) ?? null,
  };
}

function ownerFromFlat(record: JsonRecord): { name?: string | null; email?: string | null } | null {
  const name = stringValue(record.owner_name ?? record.ownerName);
  const email = stringValue(record.owner_email ?? record.ownerEmail);
  return name || email ? { name, email } : null;
}

function normalizeFolderMembership(value: unknown): NonNullable<GranolaNote["folder_membership"]> {
  if (!Array.isArray(value)) return [];
  const folders: NonNullable<GranolaNote["folder_membership"]> = [];
  for (const folder of value) {
    const record = asRecord(folder);
    const id = stringValue(record.id);
    if (!id) continue;
    folders.push({
      id,
      object: "folder" as const,
      name: stringValue(record.name) ?? null,
      parent_folder_id: stringValue(record.parent_folder_id ?? record.parentFolderId) ?? null,
    });
  }
  return folders;
}

function extractMcpToolPayload(result: unknown): unknown {
  const record = asRecord(result);
  if ("structuredContent" in record) return record.structuredContent;
  if ("content" in record && Array.isArray(record.content)) {
    for (const item of record.content) {
      const content = asRecord(item);
      if (content.type === "text" && typeof content.text === "string") {
        const parsed = tryParseJson(content.text);
        if (parsed !== null) return parsed;
      }
    }
  }
  return result;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function schemaProps(tool: McpTool): Set<string> {
  return new Set(Object.keys(tool.inputSchema?.properties ?? {}));
}

function isMcpTool(value: unknown): value is McpTool {
  const record = asRecord(value);
  return typeof record.name === "string";
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
