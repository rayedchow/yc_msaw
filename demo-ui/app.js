// Live trace viewer for the real procmem demo.
//
// A standalone port of AEye's build trace workbench
// (askshepherd/aeye-shepherd web/components/build-trace-workbench.tsx and
// agent-activity/*): the main agent thread on the left, Files / Diff /
// Agents on the right. It reads only GET /api/poll (the demo's sanitized
// event log and state) and renders what those files say, nothing more.
//
// Every untrusted string reaches the DOM through text nodes; nothing from the
// API is ever assigned to innerHTML.

/* ------------------------------------------------------------------ */
/* DOM helpers.                                                        */
/* ------------------------------------------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "style") for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

/** Rebuild `el` only when `signature` changes, so polling never resets focus or scroll. */
function memo(el, signature, build) {
  if (el.__signature === signature) return;
  el.__signature = signature;
  build();
}

/** A duration that the ticker keeps current while it runs. */
function liveSpan(since, prefix = "") {
  return h("span", { "data-since-span": since, "data-prefix": prefix }, `${prefix}${formatSpan(Math.max(0, now() - (ms(since) ?? now()))) ?? ""}`);
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

// Lucide icons (ISC), as fixed path data.
const ICONS = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  filePen: '<path d="M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v10"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10.4 12.6a2 2 0 1 1 3 3L8 21l-4 1 1-4Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  diff: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  stepBack: '<line x1="18" x2="18" y1="20" y2="4"/><polygon points="14,20 4,12 14,4"/>',
  stepForward: '<line x1="6" x2="6" y1="4" y2="20"/><polygon points="10,4 20,12 10,20"/>',
};

const iconTemplate = document.createElement("template");
function icon(name, size = 14, extraClass = "activity-icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (extraClass) svg.setAttribute("class", extraClass);
  // ICONS are constants defined above, never data from the API.
  iconTemplate.innerHTML = `<svg xmlns="${SVG_NS}">${ICONS[name] ?? ICONS.info}</svg>`;
  for (const child of [...iconTemplate.content.firstChild.childNodes]) svg.appendChild(child);
  return svg;
}
const spinner = (size = 14) => icon("loader", size, "activity-icon activity-spin");
const chevron = () => icon("chevron", 14, "activity-chevron");

/* ------------------------------------------------------------------ */
/* Formatting.                                                         */
/* ------------------------------------------------------------------ */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function ms(at) {
  const value = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}
function formatTime(at) {
  const value = ms(at);
  return value === null ? "—" : timeFormat.format(value);
}
function formatDateTime(at) {
  const value = ms(at);
  return value === null ? "—" : dateTimeFormat.format(value);
}
function formatSpan(span) {
  if (span === null || !Number.isFinite(span) || span < 0) return null;
  if (span < 1_000) return `${Math.round(span)} ms`;
  if (span < 60_000) return `${(span / 1_000).toFixed(span < 10_000 ? 1 : 0)} s`;
  const totalSeconds = Math.round(span / 1_000);
  if (totalSeconds < 3_600) return `${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`;
  return `${Math.floor(totalSeconds / 3_600)} h ${Math.floor((totalSeconds % 3_600) / 60)} min`;
}
function formatClock(span) {
  if (span === null || !Number.isFinite(span) || span < 0) return "0:00";
  const seconds = Math.floor(span / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
function spanBetween(from, to) {
  const a = ms(from);
  const b = ms(to);
  return a === null || b === null ? null : Math.max(0, b - a);
}
function plural(count, word, many = `${word}s`) {
  return `${count.toLocaleString()} ${count === 1 ? word : many}`;
}
function valueText(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function shortModel(model) {
  if (typeof model !== "string" || !model) return null;
  return model.split("/").pop();
}

/** Status words as a dot / pill modifier. */
function statusTone(status) {
  if (status === "succeeded" || status === "passed" || status === "ok" || status === true) return "done";
  if (status === "failed" || status === false) return "failed";
  if (status === "running" || status === "waiting" || status === "partial") return status;
  return "";
}
function statusWord(status) {
  if (status === true) return "passed";
  if (status === false) return "failed";
  return typeof status === "string" && status ? status : "unknown";
}

/* ------------------------------------------------------------------ */
/* Store and polling.                                                  */
/* ------------------------------------------------------------------ */

const store = {
  connected: false,
  firstPollDone: false,
  pollError: null,
  failures: 0,
  offset: 0,
  key: null,
  events: [],
  indexById: new Map(),
  version: 0,
  state: null,
  stateHash: null,
  stateVersion: 0,
  stateRedacted: 0,
  stateError: null,
  runId: null,
  eventsFile: { exists: false, size: 0 },
  sources: null,
  redacted: 0,
  skew: 0,
  report: undefined,
};

function now() {
  return Date.now() + store.skew;
}

function resetEvents() {
  store.events = [];
  store.indexById = new Map();
  store.offset = 0;
  store.key = null;
  store.version++;
  store.redacted = 0;
  views.main.reset();
  views.panel.reset();
  ui.replayIndex = null;
  stopReplay();
}

function applyPoll(body) {
  if (body.stateUnchanged) body.state = store.state;
  else {
    store.stateHash = body.stateHash ?? null;
    store.stateVersion++;
  }
  const nextRunId = isObject(body.state) && typeof body.state.runId === "string" ? body.state.runId : null;
  if (store.runId !== null && nextRunId !== null && nextRunId !== store.runId) {
    // A new run: drop everything from the old one and read its log afresh.
    store.runId = nextRunId;
    store.state = body.state;
    resetEvents();
    store.report = undefined;
    store.stateHash = null;
    return { again: true };
  }
  if (nextRunId !== null) store.runId = nextRunId;
  store.state = body.state ?? null;
  store.stateError = body.stateError ?? null;
  store.sources = body.sources ?? store.sources;
  store.eventsFile = body.eventsFile ?? store.eventsFile;
  const serverNow = ms(body.now);
  if (serverNow !== null) store.skew = serverNow - Date.now();
  if (body.reset) resetEvents();
  store.redacted += Number(body.redacted?.events) || 0;
  if (!body.stateUnchanged) store.stateRedacted = Number(body.redacted?.state) || 0;
  let changed = false;
  for (const event of body.events ?? []) {
    if (!isObject(event) || typeof event.id !== "string") continue;
    const index = store.indexById.get(event.id);
    if (index === undefined) {
      store.indexById.set(event.id, store.events.length);
      store.events.push(event);
    } else store.events[index] = event;
    changed = true;
  }
  if (changed) store.version++;
  store.offset = typeof body.offset === "number" ? body.offset : store.offset;
  store.key = body.key ?? null;
  return { again: Boolean(body.more) };
}

let pollTimer = 0;
async function poll() {
  clearTimeout(pollTimer);
  let delay = 1_000;
  try {
    const query = new URLSearchParams({ offset: String(store.offset), key: store.key ?? "", state: store.stateHash ?? "" });
    const response = await fetch(`/api/poll?${query}`, { cache: "no-store", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`The trace server answered ${response.status}.`);
    const body = await response.json();
    const { again } = applyPoll(body);
    store.connected = true;
    store.pollError = null;
    store.failures = 0;
    if (again) delay = 0;
    else if (runPhase() === "ended") delay = 4_000;
    if (store.report === undefined && runPhase() === "ended") void loadReport();
  } catch (error) {
    store.failures++;
    store.pollError = error instanceof Error ? error.message : String(error);
    delay = Math.min(5_000, 1_000 * store.failures);
  }
  store.firstPollDone = true;
  if (document.hidden && delay > 0) delay = Math.max(delay, 4_000);
  scheduleRender();
  pollTimer = setTimeout(poll, delay);
}

async function loadReport() {
  store.report = null;
  try {
    const response = await fetch("/api/report", { cache: "no-store" });
    if (response.ok) store.report = await response.json();
    else store.report = { missing: true };
  } catch {
    store.report = { missing: true };
  }
  scheduleRender();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void poll();
});

/** "waiting" (nothing yet), "live", or "ended", from state and events only. */
function runPhase() {
  const status = isObject(store.state) ? store.state.status : undefined;
  // A run_end in the log is the run's own last word, even if the state file lags behind it.
  if (lastRunEnd()) return "ended";
  if (status === "running" || status === "waiting") return "live";
  if (typeof status === "string") return "ended";
  if (store.events.length > 0) return "live";
  return "waiting";
}

let runEndCache = { version: -1, event: null };
function lastRunEnd() {
  if (runEndCache.version !== store.version) {
    runEndCache = { version: store.version, event: store.events.findLast((event) => event.kind === "run_end") ?? null };
  }
  return runEndCache.event;
}

/* ------------------------------------------------------------------ */
/* Model derived from events and state.                                */
/* ------------------------------------------------------------------ */

let modelCache = { key: "", model: null };

function deriveModel() {
  const cacheKey = `${store.version}|${store.stateVersion}`;
  if (modelCache.key === cacheKey && modelCache.model) return modelCache.model;
  const agents = new Map();
  const ensure = (id) => {
    let agent = agents.get(id);
    if (!agent) {
      agent = { id, parentId: null, name: null, title: null, model: null, status: null, stateStatus: null, startedAt: null, endedAt: null, lastAt: null, objective: null, failure: null, events: 0, firstSeq: Number.POSITIVE_INFINITY };
      agents.set(id, agent);
    }
    return agent;
  };
  for (const raw of Array.isArray(store.state?.agents) ? store.state.agents : []) {
    if (!isObject(raw) || typeof raw.id !== "string") continue;
    const agent = ensure(raw.id);
    if (typeof raw.parentId === "string" && raw.parentId !== raw.id) agent.parentId = raw.parentId;
    if (typeof raw.name === "string") agent.name = raw.name;
    if (typeof raw.model === "string") agent.model = raw.model;
    if (typeof raw.status === "string") agent.stateStatus = raw.status;
  }
  const phases = [];
  const eventFileLists = [];
  const phaseByKey = new Map();
  const files = new Map();
  let runEnd = null;
  for (const event of store.events) {
    if (event.kind === "invalid_line") continue;
    const agent = ensure(event.agentId);
    agent.events++;
    agent.firstSeq = Math.min(agent.firstSeq, event.seq ?? 0);
    if (event.at) {
      if (!agent.startedAt || event.at < agent.startedAt) agent.startedAt = event.at;
      if (!agent.lastAt || event.at > agent.lastAt) agent.lastAt = event.at;
    }
    if (event.parentId && event.parentId !== event.agentId && !agent.parentId) agent.parentId = event.parentId;
    const data = isObject(event.data) ? event.data : {};
    if (agent.endedAt && event.kind !== "agent_end") {
      // The agent worked again after it ended (a retry in the same session).
      agent.endedAt = null;
      agent.failure = null;
      agent.status = "running";
    }
    if (event.kind === "agent_start") {
      if (event.at) agent.startedAt = event.at;
      if (!agent.name && typeof data.name === "string") agent.name = data.name;
      if (!agent.model && typeof data.model === "string") agent.model = data.model;
      if (event.title) agent.title = event.title;
      if (event.text) agent.objective = event.text;
      agent.status = event.status ?? "running";
    } else if (event.kind === "agent_end") {
      agent.endedAt = event.at;
      agent.status = event.status ?? "ended";
      if (event.status === "failed") agent.failure = event.text || event.title || "This agent ended with a failure.";
    } else if (event.kind === "phase") {
      const key = typeof data.phase === "string" ? data.phase : event.title || event.id;
      let phase = phaseByKey.get(key);
      if (!phase) {
        phase = { key, title: event.title || key, status: event.status ?? null, startedAt: event.at, endedAt: null, firstEventId: event.id, agentId: event.agentId };
        phaseByKey.set(key, phase);
        phases.push(phase);
      }
      if (event.title) phase.title = event.title;
      if (event.status) phase.status = event.status;
      if (event.status && event.status !== "running" && event.status !== "waiting") phase.endedAt = event.at;
    } else if (event.kind === "files" || event.kind === "memory_diff" || event.kind === "source_diff") {
      eventFileLists.push(...eventFiles(event));
    } else if (event.kind === "run_end") {
      runEnd = event;
    }
  }
  for (const file of eventFileLists) {
    if (file.pathOnly) continue;
    const prior = files.get(file.path);
    const merged = { ...prior };
    for (const [key, value] of Object.entries(file)) if (value !== null && value !== undefined) merged[key] = value;
    files.set(file.path, { before: null, after: null, diff: null, ...merged });
  }
  for (const raw of Array.isArray(store.state?.files) ? store.state.files : []) {
    if (!isObject(raw) || typeof raw.path !== "string") continue;
    const prior = files.get(raw.path);
    files.set(raw.path, {
      ...prior,
      path: raw.path,
      kind: raw.kind ?? prior?.kind ?? null,
      before: typeof raw.before === "string" ? raw.before : prior?.before ?? null,
      after: typeof raw.after === "string" ? raw.after : prior?.after ?? null,
      diff: prior?.diff ?? null,
      beforeSha256: typeof raw.beforeSha256 === "string" ? raw.beforeSha256 : null,
      afterSha256: typeof raw.afterSha256 === "string" ? raw.afterSha256 : null,
      truncated: raw.truncated === true,
      at: prior?.at ?? null,
      agentId: prior?.agentId ?? null,
      fromState: true,
    });
  }
  // Paths an event only names: shown when no recorded file matches them.
  for (const file of eventFileLists) {
    if (!file.pathOnly || resolveFile(files, file)) continue;
    files.set(file.path, { ...file, before: null, after: null, diff: null });
  }
  // Parents named by events but never seen themselves still appear, honestly unnamed.
  for (const agent of [...agents.values()]) if (agent.parentId && !agents.has(agent.parentId)) ensure(agent.parentId);
  // Depth, guarding against cycles.
  for (const agent of agents.values()) {
    let depth = 0;
    const seen = new Set([agent.id]);
    let parent = agent.parentId ? agents.get(agent.parentId) : null;
    while (parent && !seen.has(parent.id)) {
      depth++;
      seen.add(parent.id);
      parent = parent.parentId ? agents.get(parent.parentId) : null;
    }
    if (parent) agent.parentId = null; // a cycle: show it as a root
    agent.depth = depth;
  }
  const live = runPhase() === "live";
  for (const agent of agents.values()) {
    agent.effectiveStatus = agent.stateStatus ?? agent.status ?? (live && agent.events > 0 ? "running" : null);
  }
  // Tree order: roots by first appearance, children under their parent.
  const children = new Map();
  for (const agent of [...agents.values()].sort((a, b) => a.firstSeq - b.firstSeq)) {
    const key = agent.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(agent);
  }
  const ordered = [];
  const walk = (parentId, level) => {
    for (const agent of children.get(parentId) ?? []) {
      ordered.push({ agent, level });
      walk(agent.id, level + 1);
    }
  };
  walk(null, 0);
  const model = { key: cacheKey, agents, ordered, phases, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), runEnd };
  modelCache = { key: cacheKey, model };
  return model;
}

/** A recorded file for a path an event names: exact, else the one path that ends with it (same kind). */
function resolveFile(files, file) {
  const exact = files.get(file.path);
  if (exact && !exact.pathOnly) return exact;
  const suffix = `/${file.path.replace(/^\/+/, "")}`;
  const matches = [...files.values()].filter((candidate) => !candidate.pathOnly && candidate.path.endsWith(suffix) && (!file.kind || !candidate.kind || candidate.kind === file.kind));
  if (matches.length === 1) return matches[0];
  const fromState = matches.filter((candidate) => candidate.fromState);
  return fromState.length === 1 ? fromState[0] : null;
}

function eventFiles(event) {
  const data = event.data;
  const fallbackKind = event.kind === "memory_diff" ? "memory" : event.kind === "source_diff" ? "source" : null;
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.files) ? data.files
    : isObject(data) && typeof data.path === "string" ? [data]
    : Array.isArray(data?.changed) ? data.changed
    : [];
  const out = [];
  for (const raw of list) {
    if (typeof raw === "string") {
      out.push({ path: raw, kind: fallbackKind, pathOnly: true, at: event.at, agentId: event.agentId, eventId: event.id });
      continue;
    }
    if (!isObject(raw) || typeof raw.path !== "string") continue;
    const hasContent = typeof raw.before === "string" || typeof raw.after === "string" || typeof raw.content === "string" || typeof raw.diff === "string" || typeof raw.patch === "string";
    out.push({
      path: raw.path,
      pathOnly: !hasContent,
      kind: typeof raw.kind === "string" ? raw.kind : fallbackKind,
      before: typeof raw.before === "string" ? raw.before : null,
      after: typeof raw.after === "string" ? raw.after : typeof raw.content === "string" ? raw.content : null,
      diff: typeof raw.diff === "string" ? raw.diff : typeof raw.patch === "string" ? raw.patch : null,
      change: typeof raw.change === "string" ? raw.change : typeof raw.status === "string" ? raw.status : null,
      at: event.at,
      agentId: event.agentId,
      eventId: event.id,
    });
  }
  return out;
}

function agentName(agent) {
  if (!agent) return "Unknown agent";
  return agent.name || agent.id;
}

/* ------------------------------------------------------------------ */
/* Line diff (bounded LCS), shown read-only.                           */
/* ------------------------------------------------------------------ */

function splitLines(text) {
  if (text === null || text === undefined || text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: " ", text: a[i], a: i + 1, b: i + 1 });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) {
    midA.forEach((text, i) => ops.push({ t: "-", text, a: start + i + 1 }));
    midB.forEach((text, j) => ops.push({ t: "+", text, b: start + j + 1 }));
  } else {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { ops.push({ t: " ", text: midA[i], a: start + i + 1, b: start + j + 1 }); i++; j++; }
      else if (j < m && (i === n || table[i * width + j + 1] >= table[(i + 1) * width + j])) { ops.push({ t: "+", text: midB[j], b: start + j + 1 }); j++; }
      else { ops.push({ t: "-", text: midA[i], a: start + i + 1 }); i++; }
    }
  }
  const tailA = endA;
  const tailB = endB;
  for (let k = 0; k < a.length - endA; k++) ops.push({ t: " ", text: a[tailA + k], a: tailA + k + 1, b: tailB + k + 1 });
  return ops;
}

function diffStat(file) {
  if (file.before === null && file.after === null) {
    if (!file.diff) return null;
    let added = 0;
    let removed = 0;
    for (const line of file.diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return { added, removed };
  }
  const ops = fileOps(file);
  return { added: ops.filter((op) => op.t === "+").length, removed: ops.filter((op) => op.t === "-").length };
}

const opsCache = new WeakMap();
function fileOps(file) {
  let ops = opsCache.get(file);
  if (!ops) {
    ops = lineDiff(file.before ?? "", file.after ?? "");
    opsCache.set(file, ops);
  }
  return ops;
}

function renderDiff(file) {
  const rows = [];
  const MAX = 2_000;
  if (file.before === null && file.after === null) {
    if (!file.diff) return h("div", { class: "activity-diff" }, h("p", { class: "activity-diff-note" }, "No contents were recorded for this file."));
    for (const line of file.diff.split("\n").slice(0, MAX)) {
      const kind = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "gap" : "";
      rows.push(h("li", { class: `activity-diff-row${kind ? ` activity-diff-row--${kind}` : ""}` }, h("code", null, line)));
    }
    return h("div", { class: "activity-diff" }, h("ol", { class: "activity-diff-rows" }, rows));
  }
  const ops = fileOps(file);
  if (!ops.some((op) => op.t !== " ")) {
    return h("div", { class: "activity-diff" }, h("p", { class: "activity-diff-note" }, file.before === file.after ? "No change in contents." : "Only line endings differ."));
  }
  // Hunks: changed lines with three lines of context, gaps elided.
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, index) => {
    if (op.t === " ") return;
    for (let k = Math.max(0, index - 3); k <= Math.min(ops.length - 1, index + 3); k++) keep[k] = 1;
  });
  let skipped = 0;
  let shown = 0;
  const flushGap = () => {
    if (skipped === 0) return;
    rows.push(h("li", { class: "activity-diff-row activity-diff-row--gap" }, h("span", { class: "activity-diff-sign" }, ""), h("code", null, `⋯ ${plural(skipped, "unchanged line")}`)));
    skipped = 0;
  };
  for (let index = 0; index < ops.length; index++) {
    if (!keep[index]) { skipped++; continue; }
    flushGap();
    if (shown++ >= MAX) { rows.push(h("li", { class: "activity-diff-row activity-diff-row--gap" }, h("code", null, `Diff cut at ${MAX.toLocaleString()} lines.`))); break; }
    const op = ops[index];
    const kind = op.t === "+" ? " activity-diff-row--add" : op.t === "-" ? " activity-diff-row--del" : "";
    rows.push(h("li", { class: `activity-diff-row${kind}` },
      h("span", { class: "activity-diff-number" }, op.t === "+" ? "" : String(op.a ?? "")),
      h("span", { class: "activity-diff-number" }, op.t === "-" ? "" : String(op.b ?? "")),
      h("span", { class: "activity-diff-sign" }, op.t === " " ? "" : op.t),
      h("code", null, highlight(op.text))));
  }
  flushGap();
  return h("div", { class: "activity-diff" }, h("ol", { class: "activity-diff-rows", "aria-label": `Changes to ${file.path}` }, rows));
}

function diffStatNode(file) {
  const stat = diffStat(file);
  if (!stat) return null;
  return h("span", { class: "activity-file-change-stat" }, h("ins", null, `+${stat.added}`), " ", h("del", null, `−${stat.removed}`));
}

function kindTag(kind) {
  if (!kind) return null;
  return h("span", { class: `trace-kind-tag${kind === "memory" ? " trace-kind-tag--memory" : ""}` }, kind);
}

/* ------------------------------------------------------------------ */
/* UI state.                                                           */
/* ------------------------------------------------------------------ */

const ui = {
  mainAgent: null,
  tab: "agents",
  panelAgent: null,
  follow: true,
  query: "",
  replayIndex: null,
  replayTimer: 0,
  selectedFile: null,
  fileMode: "contents",
  reportOpen: false,
};

(function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("view")) ui.mainAgent = params.get("view");
  if (["files", "diff", "agents"].includes(params.get("tab"))) ui.tab = params.get("tab");
  if (params.get("file")) ui.selectedFile = params.get("file");
  if (params.get("agent")) ui.panelAgent = params.get("agent");
})();

function writeHash() {
  const params = new URLSearchParams();
  if (ui.mainAgent) params.set("view", ui.mainAgent);
  params.set("tab", ui.tab);
  if (ui.selectedFile && ui.tab === "files") params.set("file", ui.selectedFile);
  if (ui.panelAgent && ui.tab === "agents") params.set("agent", ui.panelAgent);
  history.replaceState(null, "", `#${params}`);
}

function highlight(text) {
  const value = String(text ?? "");
  const query = ui.query.trim().toLowerCase();
  if (!query || value.length > 200_000) return value;
  const lower = value.toLowerCase();
  const parts = [];
  let from = 0;
  let at = lower.indexOf(query, from);
  if (at === -1) return value;
  while (at !== -1 && parts.length < 400) {
    if (at > from) parts.push(value.slice(from, at));
    parts.push(h("mark", { class: "trace-hit" }, value.slice(at, at + query.length)));
    from = at + query.length;
    at = lower.indexOf(query, from);
  }
  parts.push(value.slice(from));
  return parts;
}

/* ------------------------------------------------------------------ */
/* Rows: events of one view, merged like traceActivityEntries.         */
/* ------------------------------------------------------------------ */

const FILE_KINDS = new Set(["files", "memory_diff", "source_diff"]);

function eventHaystack(event, model) {
  const agent = model.agents.get(event.agentId);
  let data = "";
  if (event.data !== undefined) {
    data = valueText(event.data);
    if (data.length > 50_000) data = data.slice(0, 50_000);
  }
  return `${event.kind}\n${event.title}\n${event.text ?? ""}\n${data}\n${agentName(agent)}`.toLowerCase();
}

function callIdOf(event) {
  const data = isObject(event.data) ? event.data : {};
  const id = data.callId ?? data.toolCallId;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

function visibleEvents() {
  return ui.replayIndex === null ? store.events : store.events.slice(0, ui.replayIndex);
}

function buildRows(model, viewAgent) {
  let events = visibleEvents();
  if (viewAgent) {
    events = events.filter((event) => event.agentId === viewAgent
      || (event.kind === "agent_start" && model.agents.get(event.agentId)?.parentId === viewAgent));
  }
  const query = ui.query.trim().toLowerCase();
  if (query) {
    const matchedCalls = new Set();
    const hits = new Set();
    for (const event of events) {
      if (eventHaystack(event, model).includes(query)) {
        hits.add(event);
        const callId = callIdOf(event);
        if (callId && (event.kind === "tool_call" || event.kind === "tool_result")) matchedCalls.add(callId);
      }
    }
    events = events.filter((event) => hits.has(event)
      || ((event.kind === "tool_call" || event.kind === "tool_result") && matchedCalls.has(callIdOf(event) ?? "")));
  }
  const live = runPhase() === "live" && ui.replayIndex === null;
  const rows = [];
  const calls = new Map();
  const toolKeys = new Set();
  const openUnkeyed = new Map();
  let lastAuthor = null;
  for (const event of events) {
    if (!viewAgent && event.kind !== "phase" && event.kind !== "run_end" && event.kind !== "invalid_line" && event.agentId !== lastAuthor) {
      rows.push({ type: "author", key: `a:${event.id}`, agentId: event.agentId, event });
      lastAuthor = event.agentId;
    }
    switch (event.kind) {
      case "phase":
        rows.push({ type: "phase", key: `e:${event.id}`, event });
        lastAuthor = null;
        break;
      case "message":
        rows.push({ type: "message", key: `e:${event.id}`, event });
        break;
      case "tool_call": {
        const callId = callIdOf(event);
        let key = `t:${event.agentId}:${callId ?? event.id}`;
        if (toolKeys.has(key)) key = `${key}#${event.id}`;
        toolKeys.add(key);
        const row = { type: "tool", key, call: event, result: null, more: [] };
        if (callId) calls.set(`${event.agentId}:${callId}`, row);
        else openUnkeyed.set(event.agentId, row);
        rows.push(row);
        break;
      }
      case "tool_result": {
        const callId = callIdOf(event);
        let row = callId ? calls.get(`${event.agentId}:${callId}`) : undefined;
        if (!row && !callId) {
          // A call and result without ids pair when they are adjacent for one agent and name the same tool.
          const open = openUnkeyed.get(event.agentId);
          const tool = isObject(event.data) ? event.data.tool : undefined;
          const callTool = isObject(open?.call?.data) ? open.call.data.tool : undefined;
          if (open && !open.result && (tool === undefined || callTool === undefined || tool === callTool)) row = open;
          openUnkeyed.delete(event.agentId);
        }
        if (row && !row.result) row.result = event;
        else if (row) row.more.push(event);
        else rows.push({ type: "tool", key: `t:${event.agentId}:${event.id}`, call: null, result: event, more: [], orphanCallId: callId });
        break;
      }
      case "agent_start":
        rows.push({ type: viewAgent === event.agentId ? "task" : "subagent", key: `e:${event.id}`, event });
        break;
      case "agent_end":
        rows.push({ type: "agent-end", key: `e:${event.id}`, event });
        break;
      case "check":
        rows.push({ type: "check", key: `e:${event.id}`, event });
        break;
      case "run_end":
        rows.push({ type: "run-end", key: `e:${event.id}`, event });
        break;
      default:
        rows.push({ type: FILE_KINDS.has(event.kind) ? "files" : "generic", key: `e:${event.id}`, event });
    }
  }
  for (const row of rows) {
    if (row.type !== "tool") continue;
    row.status = toolStatus(row, model, live);
  }
  return rows;
}

function toolStatus(row, model, live) {
  const result = row.result;
  if (result) {
    const data = isObject(result.data) ? result.data : {};
    if (result.status === "failed" || data.isError === true || data.ok === false || data.error !== undefined && data.error !== null && data.error !== false) return "failed";
    return result.status ?? "succeeded";
  }
  if (row.call?.status === "failed") return "failed";
  if (row.call?.status === "succeeded") return "succeeded";
  const agent = model.agents.get(row.call?.agentId);
  const agentDone = agent && agent.status && agent.status !== "running" && agent.status !== "waiting";
  return live && !agentDone ? "running" : "unfinished";
}

function rowSignature(row, model) {
  const ev = row.event ?? row.call ?? row.result;
  const base = `${row.type}|${ev?.id}|${ev?.seq}|${ui.query}`;
  if (row.type === "tool") return `${base}|${row.result?.id ?? ""}|${row.result?.seq ?? ""}|${row.more.map((event) => event.id).join(",")}|${row.status}`;
  if (row.type === "files") return `${base}|${store.stateVersion}`;
  if (row.type === "author") {
    const agent = model.agents.get(row.agentId);
    return `${base}|${agentName(agent)}|${agent?.model ?? ""}|${agent?.depth ?? 0}`;
  }
  if (row.type === "subagent") {
    const agent = model.agents.get(row.event.agentId);
    return `${base}|${agentName(agent)}|${agent?.effectiveStatus ?? ""}|${ui.panelAgent === row.event.agentId}`;
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Row rendering.                                                      */
/* ------------------------------------------------------------------ */

function toolCategory(name) {
  const value = String(name ?? "").toLowerCase();
  if (/wait/.test(value)) return "hourglass";
  if (/(spawn|delegate|subagent|agent|task)/.test(value)) return "users";
  if (/(memory|recall|remember|wiki|procedur)/.test(value)) return "database";
  if (/(deploy|publish|handoff|complete|release|submit)/.test(value)) return "send";
  if (/(write|edit|patch|apply|create_file|replace|str_replace)/.test(value)) return "filePen";
  if (/(bash|exec|shell|command|run|sandbox|terminal|npm|test)/.test(value)) return "terminal";
  if (/(search|grep|find|query|glob)/.test(value)) return "search";
  if (/(read|cat|view|open|list|ls|get|fetch)/.test(value)) return "eye";
  return "wrench";
}

function toolSummary(input) {
  if (typeof input === "string") return input.split("\n")[0].slice(0, 120);
  if (!isObject(input)) return "";
  for (const key of ["path", "file", "filePath", "file_path", "command", "cmd", "query", "pattern", "url", "name", "target", "id"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value.split("\n")[0].slice(0, 120);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ").slice(0, 120);
  }
  return "";
}

const PAYLOAD_PREVIEW = 8_000;

function payloadBlock(label, value, { failed = false, truncatedFrom = null } = {}) {
  const text = valueText(value);
  const pre = h("pre", null, text.length > PAYLOAD_PREVIEW ? highlight(text.slice(0, PAYLOAD_PREVIEW)) : highlight(text || "(empty)"));
  const actions = [];
  if (text.length > PAYLOAD_PREVIEW) {
    const button = h("button", { type: "button" }, `Show all ${text.length.toLocaleString()} characters`);
    button.addEventListener("click", () => {
      pre.replaceChildren(...[highlight(text)].flat().map((part) => (part instanceof Node ? part : document.createTextNode(part))));
      button.remove();
    });
    actions.push(button);
  }
  if (navigator.clipboard && text) {
    const copy = h("button", { type: "button" }, "Copy");
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1_200); }, () => { copy.textContent = "Copy failed"; });
    });
    actions.push(copy);
  }
  return h("section", { class: `activity-payload${failed ? " activity-payload--failed" : ""}` },
    h("header", null, h("span", null, label), actions.length ? h("span", { style: { display: "inline-flex", gap: "10px" } }, actions) : null),
    pre,
    truncatedFrom ? h("p", { class: "activity-diff-note" }, `The server cut this payload from ${truncatedFrom.toLocaleString()} characters.`) : null);
}

function restOf(data, omit) {
  if (!isObject(data)) return data;
  const rest = {};
  let any = false;
  for (const [key, value] of Object.entries(data)) {
    if (omit.includes(key)) continue;
    rest[key] = value;
    any = true;
  }
  return any ? rest : undefined;
}

/** A collapsible line: the AEye ActivityToolLine shape. */
function collapsibleLine(view, key, { iconNode, label, labelTitle, trailing, failed, details, className = "" }) {
  const open = view.isOpen(key);
  const inner = h("div", { class: "activity-collapse-inner" });
  const collapse = h("div", { class: "activity-collapse", "data-expanded": open || undefined }, inner);
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    append(inner, [details()]);
  };
  if (open) fill();
  const button = h("button", { type: "button", class: "activity-toggle", "aria-expanded": String(open), "data-focus": key },
    iconNode,
    h("span", { class: "activity-label", title: labelTitle }, label),
    h("span", { class: "activity-trailing" }, trailing, chevron()));
  button.addEventListener("click", () => {
    const next = !view.isOpen(key);
    view.setOpen(key, next);
    if (next) fill();
    button.setAttribute("aria-expanded", String(next));
    if (next) collapse.setAttribute("data-expanded", "");
    else collapse.removeAttribute("data-expanded");
  });
  return h("li", { class: `activity-line${failed ? " activity-line--failed" : ""}${className ? ` ${className}` : ""}` }, button, collapse);
}

function trailingFor(startAt, endAt, status, badges = []) {
  const nodes = [...badges];
  if (status === "running" && startAt) {
    nodes.push(h("span", { class: "activity-duration activity-elapsed", "data-since": startAt, title: `Started ${formatTime(startAt)}` }, formatClock(now() - (ms(startAt) ?? now()))));
  } else {
    const span = spanBetween(startAt, endAt);
    if (span !== null) nodes.push(h("span", { class: "activity-duration", title: startAt ? `Started ${formatTime(startAt)}` : undefined }, formatSpan(span)));
    if (startAt) nodes.push(h("time", { datetime: startAt }, formatTime(startAt)));
  }
  return nodes;
}

function statusBadge(status) {
  if (status === "failed") return h("span", { class: "activity-badge activity-badge--failed" }, "Failed");
  if (status === "running") return h("span", { class: "activity-badge activity-badge--running" }, "Running…");
  if (status === "waiting") return h("span", { class: "activity-badge activity-badge--running" }, "Waiting");
  if (status === "partial") return h("span", { class: "activity-badge activity-badge--running" }, "Partial");
  if (status === "unfinished") return h("span", { class: "activity-badge" }, "No result");
  return null;
}

function renderRow(row, view, model) {
  switch (row.type) {
    case "author": return renderAuthor(row, model);
    case "phase": return renderPhase(row);
    case "message": return renderMessage(row, model);
    case "tool": return renderTool(row, view);
    case "subagent": return renderSubagent(row, model);
    case "task": return renderTask(row, view);
    case "agent-end": return renderAgentEnd(row, model);
    case "files": return renderFilesRow(row, view, model);
    case "check": return renderCheck(row, view);
    case "run-end": return renderRunEnd(row, view);
    default: return renderGeneric(row, view);
  }
}

function renderAuthor(row, model) {
  const agent = model.agents.get(row.agentId);
  const parent = agent?.parentId ? model.agents.get(agent.parentId) : null;
  return h("li", { class: "trace-author" },
    h("span", { class: `trace-dot${statusTone(agent?.effectiveStatus) ? ` trace-dot--${statusTone(agent?.effectiveStatus)}` : ""}` }),
    h("button", { type: "button", class: "trace-link-button", onclick: () => openAgentInPanel(row.agentId), title: `Open ${agentName(agent)} in the Agents panel` }, highlight(agentName(agent))),
    parent ? h("small", null, `subagent of ${agentName(parent)}`) : null,
    agent?.model ? h("small", { title: agent.model }, shortModel(agent.model)) : null);
}

function renderPhase(row) {
  const event = row.event;
  const tone = statusTone(event.status);
  return h("li", { class: "trace-phase-row", id: `phase-${CSS.escape(event.id)}` },
    icon("flag", 13),
    h("span", { class: `trace-dot${tone ? ` trace-dot--${tone}` : ""}` }),
    h("strong", null, highlight(event.title || "Phase")),
    event.status ? h("span", null, event.status) : null,
    event.text ? h("p", { title: event.text }, highlight(event.text)) : null,
    h("time", { datetime: event.at ?? "" }, formatTime(event.at)));
}

function renderMessage(row, model) {
  const event = row.event;
  const data = isObject(event.data) ? event.data : {};
  const role = typeof data.role === "string" ? data.role : null;
  const agent = model.agents.get(event.agentId);
  const body = event.text ?? "";
  return h("li", { class: "trace-row trace-message" },
    h("time", { class: "trace-message-time", datetime: event.at ?? "", title: agentName(agent) }, formatTime(event.at)),
    body && (event.title || role) ? h("div", { class: "trace-row-meta" }, icon("message", 12), role ? `${role} · ` : null, highlight(event.title || ""), event.status === "failed" ? h("span", { class: "activity-badge activity-badge--failed" }, "Failed") : null) : null,
    h("p", { class: "trace-prose" }, highlight(body || event.title || "(empty message)")),
    event.textTruncated ? h("p", { class: "trace-muted" }, `The server cut this message from ${event.textTruncated.toLocaleString()} characters.`) : null);
}

function renderTool(row, view) {
  const call = row.call;
  const result = row.result;
  const source = call ?? result;
  const data = isObject(source?.data) ? source.data : {};
  const toolName = String(data.tool ?? data.toolName ?? source?.title ?? "tool");
  const input = call ? (data.args ?? data.input ?? data.arguments ?? data.params ?? restOf(call.data, ["callId", "toolCallId", "tool", "toolName", "source"])) : undefined;
  const summary = toolSummary(input);
  const failed = row.status === "failed";
  const startAt = call?.at ?? result?.at ?? null;
  const label = [h("strong", null, highlight(toolName.replaceAll("_", " "))), summary ? [" ", h("code", null, highlight(summary))] : null];
  const extraTitle = source?.title && source.title !== toolName ? (source.title.startsWith(toolName) ? source.title.slice(toolName.length).trim() : source.title) : "";
  if (extraTitle && !summary) label.push(" ", h("code", null, highlight(extraTitle)));
  const iconNode = row.status === "running" ? spinner() : failed ? icon("alert", 14, "activity-icon activity-icon--failed") : icon(toolCategory(toolName));
  const details = () => {
    const blocks = [];
    if (call) {
      if (call.title && call.title !== toolName) blocks.push(h("p", { class: "activity-muted" }, highlight(call.title)));
      if (input !== undefined) blocks.push(payloadBlock(`Input · ${toolName}`, input, { truncatedFrom: call.dataTruncated }));
      if (call.text) blocks.push(payloadBlock("Note", call.text));
    } else if (row.orphanCallId) blocks.push(h("p", { class: "activity-muted" }, `No call with id ${row.orphanCallId} is in the log for this result.`));
    const resultBlocks = (event, extra) => {
      const resultData = isObject(event.data) ? event.data : null;
      const bad = event.status === "failed" || resultData?.isError === true;
      const prefix = extra ? `${event.title || "Result"} · ` : "";
      if (extra) blocks.push(h("p", { class: "activity-muted" }, `Also recorded at ${formatTime(event.at)}: ${event.title || event.kind}`));
      if (event.text) blocks.push(payloadBlock(`${prefix}${bad ? "Error" : "Output"}`, event.text, { failed: bad }));
      const payload = resultData ? (resultData.result ?? resultData.output ?? resultData.details ?? restOf(resultData, ["callId", "toolCallId", "tool", "toolName"])) : event.data;
      if (payload !== undefined) blocks.push(payloadBlock(`${prefix}${bad && !event.text ? "Error" : "Result"}`, payload, { failed: bad && !event.text, truncatedFrom: event.dataTruncated }));
      if (!event.text && payload === undefined) blocks.push(h("p", { class: "activity-muted" }, `${event.title || "Result"} (no payload recorded)`));
    };
    if (result) {
      resultBlocks(result, false);
      for (const event of row.more) resultBlocks(event, true);
    } else {
      blocks.push(h("p", { class: "activity-muted" }, row.status === "running" ? "Waiting for the result…" : "No result was recorded for this call."));
    }
    return h("div", { class: "activity-details" }, blocks);
  };
  return h("li", { class: "activity-row activity-work" },
    h("ul", { class: "activity-lines" },
      collapsibleLine(view, row.key, {
        iconNode,
        label,
        labelTitle: call?.title || toolName,
        failed,
        trailing: trailingFor(startAt, result?.at ?? null, row.status, [statusBadge(row.status)]),
        details,
      })));
}

function renderSubagent(row, model) {
  const event = row.event;
  const agent = model.agents.get(event.agentId);
  const status = agent?.effectiveStatus;
  return h("li", { class: `activity-row activity-card${status === "failed" ? " activity-card--failed" : ""}` },
    h("header", null,
      status === "running" && runPhase() === "live" ? spinner(15) : icon("users", 15),
      h("strong", null, highlight(`Started ${agentName(agent)}`)),
      status ? h("span", { class: `trace-pill${statusTone(status) ? ` trace-pill--${statusTone(status)}` : ""}` }, statusWord(status)) : null,
      h("time", { datetime: event.at ?? "" }, formatTime(event.at))),
    event.text ? h("p", { class: "activity-card-body" }, highlight(event.text.length > 600 ? `${event.text.slice(0, 600)}…` : event.text)) : null,
    h("ul", { class: "activity-agent-chips" },
      h("li", null, h("button", { type: "button", class: "activity-agent-chip", onclick: () => openAgentInPanel(event.agentId), "aria-current": ui.panelAgent === event.agentId ? "true" : undefined },
        h("span", { class: "activity-agent-chip-name" }, agentName(agent)),
        h("span", { class: "activity-agent-chip-title" }, highlight(event.title || agent?.model || "")),
        h("span", { class: "activity-agent-chip-open" }, "Open")))));
}

function renderTask(row, view) {
  const event = row.event;
  const key = `${row.key}:task`;
  if (!view.openState.has(key)) view.openState.set(key, true);
  const open = view.isOpen(key);
  const body = h("div", { class: "activity-task-body" }, highlight(event.text || event.title || "No task text was recorded."));
  const collapse = h("div", { class: "activity-collapse", "data-expanded": open || undefined }, h("div", { class: "activity-collapse-inner" }, body));
  const button = h("button", { type: "button", class: "activity-toggle", "aria-expanded": String(open), "data-focus": key },
    icon("flag"), h("span", { class: "activity-label" }, h("strong", null, "Task"), " ", highlight(event.title || "")),
    h("span", { class: "activity-trailing" }, h("time", { datetime: event.at ?? "" }, formatTime(event.at)), chevron()));
  button.addEventListener("click", () => {
    const next = !view.isOpen(key);
    view.setOpen(key, next);
    button.setAttribute("aria-expanded", String(next));
    if (next) collapse.setAttribute("data-expanded", "");
    else collapse.removeAttribute("data-expanded");
  });
  return h("li", { class: "activity-task" }, button, collapse);
}

function renderAgentEnd(row, model) {
  const event = row.event;
  const agent = model.agents.get(event.agentId);
  const span = spanBetween(agent?.startedAt, event.at);
  const failed = event.status === "failed";
  const line = h("li", { class: "activity-resumption" },
    h("span", { class: `trace-dot${statusTone(event.status) ? ` trace-dot--${statusTone(event.status)}` : ""}` }),
    h("span", null, `${agentName(agent)} ended${event.status ? ` · ${event.status}` : ""}${span !== null ? ` · ran ${formatSpan(span)}` : ""}`),
    h("time", { datetime: event.at ?? "" }, formatTime(event.at)));
  if (!event.text && !failed) return line;
  return h("li", { style: { "list-style": "none" } },
    h("ol", { class: "activity-rows" }, line),
    event.text ? (failed
      ? h("div", { class: "trace-failure" }, icon("alert", 14, ""), h("div", null, h("p", null, highlight(event.text))))
      : h("p", { class: "trace-muted" }, highlight(event.text))) : null);
}

function looksLikeUnifiedDiff(text) {
  return typeof text === "string" && (/^diff --git /m.test(text) || /^@@ -\d/m.test(text));
}

function renderFilesRow(row, view, model) {
  const event = row.event;
  const byPath = new Map(model.files.map((file) => [file.path, file]));
  const files = eventFiles(event).map((file) => resolveFile(byPath, file) ?? file);
  const unified = looksLikeUnifiedDiff(event.text) ? event.text : null;
  const label = event.kind === "memory_diff" ? "Memory changed" : event.kind === "source_diff" ? "Source changed" : "Files";
  const shown = files.slice(0, 8);
  return h("li", { class: "activity-row activity-card" },
    h("header", null,
      icon(event.kind === "memory_diff" ? "database" : "filePen", 15),
      h("strong", null, highlight(event.title || label)),
      event.status ? h("span", { class: `trace-pill${statusTone(event.status) ? ` trace-pill--${statusTone(event.status)}` : ""}` }, event.status) : null,
      h("time", { datetime: event.at ?? "" }, formatTime(event.at))),
    event.text && !unified ? h("p", { class: "activity-card-body" }, highlight(event.text)) : null,
    files.length === 0
      ? (event.data !== undefined ? h("div", { class: "activity-details" }, payloadBlock("Data", event.data)) : unified ? null : h("p", { class: "activity-muted" }, "No file list was recorded with this event."))
      : h("div", { style: { display: "grid", gap: "10px", "margin-top": "8px" } }, shown.map((file) => {
        const key = `${row.key}:${file.path}`;
        if (file.pathOnly) {
          return h("div", { class: "activity-file-change" }, h("header", null,
            h("span", { class: "activity-file-change-path", title: file.path }, highlight(file.path)), kindTag(file.kind),
            h("span", { class: "activity-file-change-meta" }, "contents not in the run state yet")));
        }
        const open = view.isOpen(key);
        const holder = h("div", null, open ? renderDiff(file) : null);
        const toggle = h("button", { type: "button", class: "activity-link-button", "aria-expanded": String(open), style: { margin: 0 }, "data-focus": key }, open ? "Hide diff" : "Show diff");
        toggle.addEventListener("click", () => {
          const next = !view.isOpen(key);
          view.setOpen(key, next);
          toggle.setAttribute("aria-expanded", String(next));
          toggle.textContent = next ? "Hide diff" : "Show diff";
          holder.replaceChildren(...(next ? [renderDiff(file)] : []));
        });
        return h("div", { class: "activity-file-change" },
          h("header", null,
            h("span", { class: "activity-file-change-path", title: file.path }, highlight(file.path)),
            kindTag(file.kind),
            diffStatNode(file),
            file.change ? h("span", { class: "activity-file-change-meta" }, file.change) : null,
            h("span", { class: "activity-card-actions", style: { "margin-left": "auto" } },
              toggle,
              h("button", { type: "button", class: "activity-link-button", style: { margin: 0 }, onclick: () => openFile(file.path) }, "Open in Files"))),
          holder);
      })),
    files.length > shown.length ? h("p", { class: "activity-muted" }, `${plural(files.length - shown.length, "more file")} in the Diff tab.`) : null,
    unified ? unifiedToggle(view, `${row.key}:unified`, unified) : null);
}

function unifiedToggle(view, key, text) {
  const open = view.isOpen(key);
  const holder = h("div", { style: { "margin-top": "6px" } }, open ? renderDiff({ path: "", before: null, after: null, diff: text }) : null);
  const toggle = h("button", { type: "button", class: "activity-link-button", "aria-expanded": String(open), "data-focus": key }, open ? "Hide recorded git diff" : "Show recorded git diff");
  toggle.addEventListener("click", () => {
    const next = !view.isOpen(key);
    view.setOpen(key, next);
    toggle.setAttribute("aria-expanded", String(next));
    toggle.textContent = next ? "Hide recorded git diff" : "Show recorded git diff";
    holder.replaceChildren(...(next ? [renderDiff({ path: "", before: null, after: null, diff: text })] : []));
  });
  return h("div", null, toggle, holder);
}

function renderCheck(row, view) {
  const event = row.event;
  const status = event.status ?? (isObject(event.data) && typeof event.data.ok === "boolean" ? (event.data.ok ? "succeeded" : "failed") : null);
  const failed = status === "failed";
  const iconNode = status === "running" ? spinner()
    : failed ? icon("alert", 14, "activity-icon activity-icon--failed")
    : status === "succeeded" ? icon("circleCheck", 14, "activity-icon activity-icon--good")
    : icon("check");
  const badges = [failed ? statusBadge("failed") : status === "succeeded" ? h("span", { class: "activity-badge activity-badge--good" }, "Passed") : statusBadge(status)];
  return h("li", { class: "activity-row activity-work" },
    h("ul", { class: "activity-lines" },
      collapsibleLine(view, row.key, {
        iconNode,
        label: [h("strong", null, "Check"), " ", highlight(event.title || "")],
        labelTitle: event.title,
        failed,
        trailing: [badges, event.at ? h("time", { datetime: event.at }, formatTime(event.at)) : null],
        details: () => h("div", { class: "activity-details" },
          event.text ? payloadBlock(failed ? "Failure" : "Detail", event.text, { failed }) : null,
          event.data !== undefined ? payloadBlock("Data", event.data, { truncatedFrom: event.dataTruncated }) : null,
          !event.text && event.data === undefined ? h("p", { class: "activity-muted" }, "No detail was recorded for this check.") : null),
      })));
}

function renderRunEnd(row, view) {
  const event = row.event;
  const failed = event.status === "failed";
  const key = `${row.key}:data`;
  const open = view.isOpen(key);
  const holder = h("div", { class: "activity-details" }, open && event.data !== undefined ? payloadBlock("Data", event.data) : null);
  const toggle = event.data !== undefined ? h("button", { type: "button", class: "activity-link-button", "aria-expanded": String(open), "data-focus": key }, open ? "Hide recorded data" : "Show recorded data") : null;
  toggle?.addEventListener("click", () => {
    const next = !view.isOpen(key);
    view.setOpen(key, next);
    toggle.setAttribute("aria-expanded", String(next));
    toggle.textContent = next ? "Hide recorded data" : "Show recorded data";
    holder.replaceChildren(...(next ? [payloadBlock("Data", event.data)] : []));
  });
  return h("li", { class: `activity-row activity-card${failed ? " activity-card--failed" : ""}` },
    h("header", null,
      failed ? icon("alert", 15, "activity-icon activity-icon--failed") : event.status === "succeeded" ? icon("circleCheck", 15, "activity-icon activity-icon--good") : icon("flag", 15),
      h("strong", null, highlight(event.title || "Run ended")),
      event.status ? h("span", { class: `trace-pill${statusTone(event.status) ? ` trace-pill--${statusTone(event.status)}` : ""}` }, event.status) : null,
      h("time", { datetime: event.at ?? "" }, formatDateTime(event.at))),
    event.text ? h("p", { class: "activity-card-body" }, highlight(event.text)) : null,
    toggle,
    holder);
}

function renderGeneric(row, view) {
  const event = row.event;
  const invalid = event.kind === "invalid_line";
  const known = event.kind === "sdk_update" || event.kind === "message";
  const failed = invalid || event.status === "failed";
  return h("li", { class: "activity-row activity-work" },
    h("ul", { class: "activity-lines" },
      collapsibleLine(view, row.key, {
        iconNode: invalid ? icon("alert", 14, "activity-icon activity-icon--failed") : event.status === "running" ? spinner() : icon(event.kind === "sdk_update" ? "package" : "info"),
        label: [h("strong", null, event.kind === "sdk_update" ? "SDK update" : invalid ? "Unreadable line" : event.kind.replaceAll("_", " ")), " ", highlight(event.title || "")],
        labelTitle: known ? event.title : `Event kind “${event.kind}”`,
        failed,
        trailing: [statusBadge(event.status === "succeeded" ? null : event.status), !known && !invalid ? h("span", { class: "activity-badge", title: "This viewer has no special rendering for this kind" }, event.kind) : null, event.at ? h("time", { datetime: event.at }, formatTime(event.at)) : null],
        details: () => h("div", { class: "activity-details" },
          event.text ? payloadBlock(invalid ? "Raw line (start)" : "Text", event.text, { failed: invalid }) : null,
          event.data !== undefined ? payloadBlock("Data", event.data, { truncatedFrom: event.dataTruncated }) : null,
          !event.text && event.data === undefined ? h("p", { class: "activity-muted" }, "Nothing else was recorded with this event.") : null),
      })));
}

/* ------------------------------------------------------------------ */
/* Thread view: one keyed, scroll-following list.                      */
/* ------------------------------------------------------------------ */

class ThreadView {
  constructor({ compact }) {
    this.openState = new Map();
    this.nodes = new Map();
    this.atEnd = true;
    this.unseen = 0;
    this.header = h("header", { class: "trace-thread-header" });
    this.top = h("div");
    this.list = h("ol", { class: "activity-rows trace-rows", "aria-live": "off" });
    this.tail = h("div");
    this.column = h("div", { class: "trace-column" }, this.top, this.list, this.tail);
    this.scroll = h("div", { class: "trace-scroll", tabindex: "-1" }, this.column);
    this.jump = h("button", { type: "button", class: "trace-jump", hidden: true }, "Jump to latest");
    this.el = h("div", { class: `trace-thread activity-scope${compact ? " trace-thread--compact" : ""}` }, this.header, this.scroll, this.jump);
    this.scroll.addEventListener("scroll", () => {
      this.atEnd = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 48;
      if (this.atEnd) this.clearUnseen();
    }, { passive: true });
    this.jump.addEventListener("click", () => this.scrollToEnd(true));
    this.scope = null;
  }
  reset() {
    this.nodes.clear();
    this.list.replaceChildren();
    this.openState.clear();
    this.unseen = 0;
    this.atEnd = true;
    this.jump.hidden = true;
  }
  isOpen(key) { return this.openState.get(key) === true; }
  setOpen(key, open) { this.openState.set(key, open); }
  clearUnseen() {
    this.unseen = 0;
    this.jump.hidden = true;
  }
  scrollToEnd(smooth = false) {
    this.scroll.scrollTo({ top: this.scroll.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    this.atEnd = true;
    this.clearUnseen();
  }
  /** Show rows for `scope`; a new scope starts from its end. */
  setRows(rows, model, scope) {
    const scopeChanged = this.scope !== scope;
    if (scopeChanged) {
      this.scope = scope;
      this.nodes.clear();
      this.list.replaceChildren();
      this.unseen = 0;
      this.jump.hidden = true;
    }
    const wasAtEnd = this.atEnd;
    const focused = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement) ? document.activeElement.dataset.focus ?? null : null;
    const next = new Map();
    let added = 0;
    for (const row of rows) {
      const signature = rowSignature(row, model);
      const prior = this.nodes.get(row.key);
      let el;
      if (prior && prior.signature === signature) el = prior.el;
      else {
        el = renderRow(row, this, model);
        el.dataset.rowKey = row.key;
        if (!prior) added++;
      }
      next.set(row.key, { el, signature });
    }
    let cursor = this.list.firstChild;
    for (const { el } of next.values()) {
      if (cursor === el) cursor = cursor.nextSibling;
      else this.list.insertBefore(el, cursor);
    }
    while (cursor) {
      const after = cursor.nextSibling;
      cursor.remove();
      cursor = after;
    }
    this.nodes = next;
    if (focused) this.list.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    if (scopeChanged || (ui.follow && wasAtEnd)) {
      if (added > 0 || scopeChanged) requestAnimationFrame(() => this.scrollToEnd());
    } else if (added > 0) {
      this.unseen += added;
      this.jump.hidden = false;
      this.jump.textContent = `Jump to latest · ${plural(this.unseen, "new row")}`;
    }
  }
}

const views = { main: new ThreadView({ compact: false }), panel: new ThreadView({ compact: true }) };

/* ------------------------------------------------------------------ */
/* Actions.                                                            */
/* ------------------------------------------------------------------ */

function openAgentInPanel(id) {
  ui.panelAgent = id;
  ui.tab = "agents";
  writeHash();
  scheduleRender();
}
function openInMain(id) {
  ui.mainAgent = id;
  writeHash();
  scheduleRender();
}
function openFile(filePath) {
  ui.selectedFile = filePath;
  ui.tab = "files";
  writeHash();
  scheduleRender();
}
function setTab(tab) {
  ui.tab = tab;
  writeHash();
  scheduleRender();
}
function setFollow(follow) {
  ui.follow = follow;
  const button = document.getElementById("follow");
  button.setAttribute("aria-pressed", String(follow));
  button.textContent = follow ? "Following" : "Paused";
  button.title = follow ? "Following new activity — press f to pause" : "Auto-follow paused — press f to follow";
  if (follow) views.main.scrollToEnd();
}
function stopReplay() {
  clearInterval(ui.replayTimer);
  ui.replayTimer = 0;
}
function setReplay(index) {
  const total = store.events.length;
  ui.replayIndex = index === null || index >= total ? null : Math.max(0, index);
  scheduleRender();
}
function toggleReplayPlay() {
  if (ui.replayTimer) { stopReplay(); scheduleRender(); return; }
  if (ui.replayIndex === null) ui.replayIndex = 0;
  ui.replayTimer = setInterval(() => {
    const next = (ui.replayIndex ?? 0) + 1;
    if (next >= store.events.length) { stopReplay(); setReplay(null); return; }
    setReplay(next);
  }, 700);
  scheduleRender();
}

/* ------------------------------------------------------------------ */
/* Render: top bar.                                                    */
/* ------------------------------------------------------------------ */

function renderTopbar(model) {
  const state = isObject(store.state) ? store.state : null;
  const phase = runPhase();
  document.getElementById("run-title").textContent = state?.title || (phase === "waiting" ? "Waiting for the demo run" : "Demo run");
  document.title = `${phase === "live" ? "● " : ""}${state?.title || "Demo trace"} · procmem`;
  const mode = document.getElementById("run-mode");
  const lastActivity = [state?.updatedAt, store.events.at(-1)?.at].map(ms).filter((value) => value !== null);
  const quietFor = lastActivity.length ? now() - Math.max(...lastActivity) : null;
  if (store.pollError && store.connected) { mode.className = "trace-pill trace-pill--failed"; mode.textContent = "Disconnected"; }
  else if (!store.firstPollDone) { mode.className = "trace-pill"; mode.textContent = "Connecting"; }
  else if (store.pollError) { mode.className = "trace-pill trace-pill--failed"; mode.textContent = "Server unreachable"; }
  else if (phase === "live") { mode.className = "trace-pill trace-pill--running"; mode.replaceChildren(h("span", { class: "trace-dot trace-dot--running" }), ui.replayIndex === null ? "Live" : "Live · replaying"); }
  else if (phase === "ended") { mode.className = "trace-pill"; mode.textContent = ui.replayIndex === null ? "Recorded run" : "Replaying recorded run"; }
  else { mode.className = "trace-pill trace-pill--waiting"; mode.textContent = "Waiting for run"; }
  const status = document.getElementById("run-status");
  if (state?.status) {
    status.hidden = false;
    status.className = `trace-pill${statusTone(state.status) ? ` trace-pill--${statusTone(state.status)}` : ""}`;
    status.textContent = state.phase ? `${state.status} · ${state.phase}` : state.status;
  } else status.hidden = true;
  const meta = [];
  if (state?.runId) meta.push(h("span", { title: "runId" }, `Run ${state.runId}`));
  const started = state?.startedAt ?? store.events[0]?.at ?? null;
  if (started) meta.push(h("span", null, `Started ${formatDateTime(started)}`));
  if (started) {
    const end = phase === "live" ? new Date(now()).toISOString() : lastRunEnd()?.at ?? state?.updatedAt ?? store.events.at(-1)?.at ?? null;
    const span = spanBetween(started, end);
    if (span !== null) meta.push(h("span", null, `${phase === "live" ? "Active" : "Ran"} ${formatSpan(span)}`));
  }
  const runEnd = lastRunEnd();
  if (runEnd && (state?.status === "running" || state?.status === "waiting")) {
    meta.push(h("span", { style: { color: "var(--color-working)" }, title: "The event log has a run_end event but real-demo-state.json was not updated after it" }, `Log recorded run_end (${runEnd.status ?? "no status"}) at ${formatTime(runEnd.at)}; state file still says ${state.status}`));
  }
  if (phase === "live" && quietFor !== null && quietFor > 60_000) meta.push(h("span", { style: { color: "var(--color-working)" } }, `No new activity for ${formatSpan(quietFor)}`));
  if (state?.sessionId) meta.push(h("span", { title: "Pi session id (customer agent)" }, `Pi session ${state.sessionId}`));
  meta.push(h("span", null, `${plural(store.events.length, "event")} · ${plural(model.agents.size, "agent")}`));
  if (store.sources) meta.push(h("span", { title: "The only files this viewer reads" }, `Reading ${store.sources.events}${store.sources.fixture ? " (fixture --data-dir)" : ""}`));
  const redacted = store.redacted + store.stateRedacted;
  if (redacted > 0) meta.push(h("span", { title: "Values that looked like credentials were replaced by the trace server" }, `${plural(redacted, "value")} redacted`));
  document.getElementById("run-meta").replaceChildren(...meta);
  const exportLink = document.getElementById("export");
  exportLink.setAttribute("aria-disabled", String(phase === "waiting"));

  const banner = document.getElementById("banner");
  if (store.pollError && store.firstPollDone) {
    banner.hidden = false;
    banner.className = "trace-banner trace-banner--error";
    banner.replaceChildren(icon("alert", 14, ""), `Lost contact with the trace server (${store.pollError}). Retrying; what is shown is from the last successful read.`);
  } else if (store.stateError) {
    banner.hidden = false;
    banner.className = "trace-banner trace-banner--note";
    banner.replaceChildren(icon("alert", 14, ""), `State file: ${store.stateError}`);
  } else if (store.sources?.fixture) {
    banner.hidden = false;
    banner.className = "trace-banner trace-banner--note";
    banner.replaceChildren(icon("info", 14, ""), "Fixture data: this server was started with --data-dir, not the real demo log.");
  } else banner.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Render: main column.                                                */
/* ------------------------------------------------------------------ */

const mainEl = document.getElementById("main");
const runtimeEl = h("div", { class: "trace-runtime-progress", hidden: true });

function threadSkeleton() {
  return h("div", { class: "trace-skeleton", "aria-busy": "true", "aria-label": "Loading" },
    [72, 54, 88, 40, 66].map((width, index) => h("div", { class: "trace-skeleton-row" }, h("span", { class: "trace-skeleton-icon" }), h("span", { class: "trace-skeleton-bar", style: { width: `${width - index * 3}%` } }))));
}

function renderMain(model) {
  const phase = runPhase();
  if (!store.firstPollDone || (store.pollError && !store.connected)) {
    const content = !store.firstPollDone
      ? h("div", { class: "trace-column", style: { width: "100%" } }, threadSkeleton())
      : h("div", { class: "trace-placeholder", role: "alert" }, icon("alert", 18, "activity-icon activity-icon--failed"), h("h2", null, "Can’t reach the trace server"), h("p", null, `${store.pollError} Retrying every few seconds.`));
    mainEl.replaceChildren(content);
    return;
  }
  if (phase === "waiting" && !store.state) {
    mainEl.replaceChildren(h("div", { class: "trace-placeholder", role: "status" },
      spinner(18),
      h("h2", null, "Waiting for the demo run to start"),
      h("p", null, `This page watches ${store.sources?.events ?? "the demo event log"} and ${store.sources?.state ?? "its state file"}. It updates within a second of the run writing its first event; nothing is shown until then.`)));
    return;
  }
  if (!mainEl.contains(views.main.el)) mainEl.replaceChildren(runtimeEl, views.main.el);
  renderRuntime(model);
  const viewAgent = ui.mainAgent && model.agents.has(ui.mainAgent) ? ui.mainAgent : null;
  const agent = viewAgent ? model.agents.get(viewAgent) : null;
  renderThreadHeader(views.main, model, agent, false);
  const rows = buildRows(model, viewAgent);
  views.main.setRows(rows, model, `main:${viewAgent ?? "*"}:${store.runId ?? ""}`);
  renderThreadTop(views.main, model, agent, rows);
  renderThreadTail(views.main, model, agent, rows);
}

function viewSelect(model) {
  const select = h("select", { "aria-label": "Main view" },
    h("option", { value: "" }, "Whole run · all agents"),
    model.ordered.map(({ agent, level }) => h("option", { value: agent.id, selected: ui.mainAgent === agent.id }, `${"  ".repeat(level)}${level ? "↳ " : ""}${agentName(agent)}`)));
  select.value = ui.mainAgent && model.agents.has(ui.mainAgent) ? ui.mainAgent : "";
  select.addEventListener("change", () => openInMain(select.value || null));
  return h("label", { class: "trace-attempt" }, "View", select);
}

function renderThreadHeader(view, model, agent, compact) {
  const signature = `${model.key}|${agent?.id ?? "*"}|${ui.mainAgent}|${ui.query}|${ui.replayIndex}|${runPhase()}`;
  memo(view.header, signature, () => buildThreadHeader(view, model, agent, compact));
}

function buildThreadHeader(view, model, agent, compact) {
  const heading = [];
  if (!agent) {
    heading.push(h("p", { class: "trace-thread-subtitle" }, h("span", { class: "trace-agent-title" }, "Whole run"), h("span", { class: "trace-agent-name", style: { "font-weight": 400 } }, "every agent, in recorded order")));
    const visible = visibleEvents();
    heading.push(h("p", { class: "trace-thread-meta" },
      h("span", null, plural(visible.length, "event")),
      ui.query ? h("span", null, `filtered by “${ui.query}”`) : null));
  } else {
    const parent = agent.parentId ? model.agents.get(agent.parentId) : null;
    const tone = statusTone(agent.effectiveStatus);
    heading.push(h("p", { class: "trace-thread-subtitle" },
      h("span", { class: "trace-agent-name" }, agentName(agent)),
      agent.title ? h("span", { class: "trace-agent-title", title: agent.title }, agent.title) : null));
    const running = !agent.endedAt && agent.effectiveStatus === "running" && runPhase() === "live";
    const span = spanBetween(agent.startedAt, agent.endedAt ?? agent.lastAt);
    heading.push(h("p", { class: "trace-thread-meta" },
      agent.effectiveStatus ? h("span", { class: `trace-pill${tone ? ` trace-pill--${tone}` : ""}` }, statusWord(agent.effectiveStatus)) : null,
      agent.model ? h("span", { title: agent.model }, shortModel(agent.model)) : null,
      agent.startedAt ? h("span", null, `Started ${formatTime(agent.startedAt)}`) : null,
      running && agent.startedAt ? liveSpan(agent.startedAt, "Active ") : span !== null ? h("span", null, `Ran ${formatSpan(span)}`) : null,
      h("span", null, plural(agent.events, "event")),
      parent ? h("button", { type: "button", class: "trace-link-button", onclick: () => (compact ? openAgentInPanel(parent.id) : openInMain(parent.id)) }, `Parent: ${agentName(parent)}`) : null));
  }
  const toolbar = compact
    ? [h("button", { type: "button", class: "trace-tool-button", onclick: () => { ui.panelAgent = null; writeHash(); scheduleRender(); } }, icon("arrowLeft", 14, ""), "All agents"),
      agent && agent.id !== ui.mainAgent ? h("button", { type: "button", class: "trace-tool-button", onclick: () => { openInMain(agent.id); ui.panelAgent = null; } }, "Open in main view") : null]
    : [viewSelect(model), agent ? h("button", { type: "button", class: "trace-tool-button", onclick: () => openInMain(null) }, "Whole run") : null];
  view.header.replaceChildren(h("div", { class: "trace-thread-heading" }, heading), h("div", { class: "trace-thread-toolbar" }, toolbar));
}

function renderThreadTop(view, model, agent, rows) {
  const parts = [];
  if (agent?.failure) parts.push(h("div", { class: "trace-failure" }, icon("alert", 14, ""), h("div", null, h("p", null, agent.failure))));
  if (rows.length > 0 && !ui.query) parts.push(h("p", { class: "trace-start" }, agent ? "Start of this agent’s activity" : "Start of the run’s recorded activity"));
  view.top.replaceChildren(...parts);
}

function renderThreadTail(view, model, agent, rows) {
  const phase = runPhase();
  const parts = [];
  if (rows.length === 0) {
    parts.push(h("p", { class: "trace-muted trace-empty" },
      ui.query ? `Nothing in this view matches “${ui.query}”.`
        : agent ? (phase === "live" ? "Waiting for this agent’s first step…" : "No activity was recorded for this agent.")
        : phase === "live" ? "Waiting for the first event…" : "No events were recorded for this run."));
  }
  if (ui.replayIndex !== null) {
    parts.push(h("p", { class: "trace-live trace-live--stopped" }, `Replay: showing ${ui.replayIndex.toLocaleString()} of ${plural(store.events.length, "recorded event")}.`));
  } else if (phase === "live") {
    const working = agent ? agent.effectiveStatus === "running" : true;
    if (working) {
      const last = agent ? agent.lastAt : store.events.at(-1)?.at;
      parts.push(h("p", { class: "trace-live", role: "status" }, spinner(13), agent ? "Working…" : "Live — new events appear as the run writes them", last ? h("span", { class: "activity-duration" }, `· last event ${formatTime(last)}`) : null));
    }
  } else if (phase === "ended") {
    const state = isObject(store.state) ? store.state : null;
    const status = model.runEnd?.status ?? state?.status ?? null;
    parts.push(h("p", { class: "trace-live trace-live--stopped" },
      h("span", { class: `trace-dot${statusTone(status) ? ` trace-dot--${statusTone(status)}` : ""}` }),
      `Run ${status ? `ended · ${status}` : "ended"}${model.runEnd?.at ? ` at ${formatDateTime(model.runEnd.at)}` : state?.updatedAt ? ` at ${formatDateTime(state.updatedAt)}` : ""}. This is the retained log, shown as recorded.`));
  }
  view.tail.replaceChildren(...parts);
}

function renderRuntime(model) {
  const signature = `${model.key}|${ui.replayIndex}|${Boolean(ui.replayTimer)}|${ui.reportOpen}|${store.report ? (store.report.missing ? 0 : 1) : 0}|${runPhase()}`;
  memo(runtimeEl, signature, () => buildRuntime(model));
}

function buildRuntime(model) {
  const sections = [];
  const phase = runPhase();
  if (model.phases.length > 0) {
    const items = [];
    model.phases.forEach((item, index) => {
      if (index > 0) items.push(h("li", { class: "trace-phase-arrow", "aria-hidden": "true" }, "→"));
      const tone = statusTone(item.status);
      const running = !item.endedAt && item.status === "running" && phase === "live";
      const span = spanBetween(item.startedAt, item.endedAt);
      items.push(h("li", { "data-status": item.status ?? "" },
        h("button", { type: "button", class: "trace-link-button", style: { color: "inherit", display: "inline-flex", "align-items": "center", gap: "6px" }, title: `${item.title}${item.status ? ` · ${item.status}` : ""} — show in thread`, onclick: () => scrollToPhase(item) },
          running ? spinner(11) : h("span", { class: `trace-dot${tone ? ` trace-dot--${tone}` : ""}` }),
          item.title),
        item.status === "running" && phase !== "live" ? h("small", null, "no end recorded") : null,
        running && item.startedAt ? h("small", null, liveSpan(item.startedAt)) : span !== null ? h("small", null, formatSpan(span)) : null));
    });
    sections.push(h("div", { class: "trace-runtime-row" }, h("span", { class: "trace-runtime-label" }, "Phases"), h("ol", { class: "trace-phases", "aria-label": "Phases" }, items)));
  }
  const checks = isObject(store.state?.checks) ? Object.entries(store.state.checks) : [];
  if (checks.length > 0) {
    sections.push(h("div", { class: "trace-runtime-row" },
      h("span", { class: "trace-runtime-label" }, "Checks"),
      h("ul", { class: "trace-checks" }, checks.map(([name, value]) => {
        const status = isObject(value) ? (value.status ?? value.ok ?? value.passed) : value;
        const detail = isObject(value) ? (value.detail ?? value.message ?? value.reason ?? null) : null;
        const tone = statusTone(typeof status === "boolean" ? status : status);
        const word = typeof status === "boolean" || typeof status === "string" ? statusWord(status) : valueText(value).slice(0, 80);
        return h("li", { title: detail ? String(detail) : `${name}: ${word}` }, h("span", { class: `trace-dot${tone ? ` trace-dot--${tone}` : ""}` }), `${name}: ${word}`);
      }))));
  }
  if (phase === "ended" && store.events.length > 0) {
    const total = store.events.length;
    const index = ui.replayIndex ?? total;
    const atEvent = store.events[Math.max(0, index - 1)];
    const range = h("input", { type: "range", min: "0", max: String(total), value: String(index), "aria-label": "Replay position (event)" });
    range.addEventListener("input", () => { stopReplay(); setReplay(Number(range.value)); });
    sections.push(h("div", { class: "trace-runtime-row trace-replay" },
      h("span", { class: "trace-runtime-label" }, "Replay"),
      h("button", { type: "button", class: "trace-tool-button", "aria-label": "Previous event", onclick: () => { stopReplay(); setReplay((ui.replayIndex ?? total) - 1); } }, icon("stepBack", 12, "")),
      h("button", { type: "button", class: "trace-tool-button", onclick: toggleReplayPlay, title: "Steps through the recorded events at a fixed pace; times shown are the recorded ones" }, icon(ui.replayTimer ? "pause" : "play", 12, ""), ui.replayTimer ? "Pause" : "Play"),
      h("button", { type: "button", class: "trace-tool-button", "aria-label": "Next event", onclick: () => { stopReplay(); setReplay((ui.replayIndex ?? total) + 1); } }, icon("stepForward", 12, "")),
      range,
      h("output", null, `${index.toLocaleString()} / ${total.toLocaleString()}${atEvent?.at ? ` · ${formatTime(atEvent.at)}` : ""}`),
      ui.replayIndex !== null ? h("button", { type: "button", class: "trace-link-button", style: { "font-size": "12px" }, onclick: () => { stopReplay(); setReplay(null); } }, "Show all") : null));
  }
  if (store.report && !store.report.missing) {
    const toggle = h("button", { type: "button", class: "trace-link-button", style: { "font-size": "12px" }, "aria-expanded": String(ui.reportOpen), onclick: () => { ui.reportOpen = !ui.reportOpen; scheduleRender(); } }, ui.reportOpen ? "Hide report" : "View report");
    sections.push(h("div", { class: "trace-runtime-row" }, h("span", { class: "trace-runtime-label" }, "Report"), h("span", { class: "trace-muted" }, store.report.path), toggle));
    if (ui.reportOpen) sections.push(h("div", { class: "trace-runtime-row", style: { display: "block" } }, payloadBlock("Report", store.report.report)));
  }
  runtimeEl.hidden = sections.length === 0;
  runtimeEl.replaceChildren(...sections);
}

function scrollToPhase(phase) {
  if (ui.mainAgent) openInMain(null);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const target = views.main.list.querySelector(`[data-row-key="${CSS.escape(`e:${phase.firstEventId}`)}"]`);
    if (target) {
      setFollow(false);
      target.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }));
}

/* ------------------------------------------------------------------ */
/* Render: right panel.                                                */
/* ------------------------------------------------------------------ */

const panelBody = document.getElementById("panel-body");
let panelMode = null;

function renderTabs(model) {
  const counts = { files: model.files.length, diff: model.files.filter((file) => file.before !== file.after || file.diff).length, agents: model.agents.size };
  for (const button of document.querySelectorAll("#tabs [role=tab]")) {
    const tab = button.dataset.tab;
    const selected = tab === ui.tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const label = tab === "files" ? "Files" : tab === "diff" ? "Diff" : "Agents";
    button.replaceChildren();
    append(button, [icon(tab === "files" ? "folder" : tab === "diff" ? "diff" : "users", 14, ""), label, counts[tab] > 0 ? h("small", null, String(counts[tab])) : null]);
  }
  panelBody.setAttribute("aria-labelledby", `tab-${ui.tab}`);
}

function renderPanel(model) {
  renderTabs(model);
  if (ui.tab === "agents" && ui.panelAgent && model.agents.has(ui.panelAgent)) {
    if (panelMode !== "thread") { panelBody.replaceChildren(views.panel.el); panelMode = "thread"; panelBody.__signature = null; }
    const agent = model.agents.get(ui.panelAgent);
    renderThreadHeader(views.panel, model, agent, true);
    const rows = buildRows(model, agent.id);
    views.panel.setRows(rows, model, `panel:${agent.id}:${store.runId ?? ""}`);
    renderThreadTop(views.panel, model, agent, rows);
    renderThreadTail(views.panel, model, agent, rows);
    return;
  }
  const signature = `${model.key}|${ui.tab}|${ui.selectedFile}|${ui.fileMode}|${ui.query}|${ui.mainAgent}|${store.firstPollDone}|${ui.replayIndex}`;
  if (panelMode !== ui.tab) panelBody.__signature = null;
  panelMode = ui.tab;
  memo(panelBody, signature, () => {
    if (ui.tab === "agents") panelBody.replaceChildren(renderAgentList(model));
    else if (ui.tab === "files") renderFilesPanel(model);
    else renderDiffPanel(model);
  });
}

function renderAgentList(model) {
  if (model.ordered.length === 0) {
    return h("div", { class: "trace-placeholder" }, h("p", null, store.firstPollDone ? "No agents have reported yet. The customer agent, the builder and its subagents appear here as they start." : "Loading agents…"));
  }
  const list = h("ul", null, model.ordered.map(({ agent, level }) => {
    const tone = statusTone(agent.effectiveStatus);
    return h("li", null, h("button", {
      type: "button",
      class: "trace-agent-item",
      style: { "--trace-level": String(level) },
      "aria-current": (ui.mainAgent ?? null) === agent.id ? "true" : undefined,
      title: `${agentName(agent)}${agent.effectiveStatus ? ` · ${agent.effectiveStatus}` : ""}${agent.model ? ` · ${agent.model}` : ""}`,
      onclick: () => openAgentInPanel(agent.id),
    },
    agent.effectiveStatus === "running" && runPhase() === "live" ? spinner(12) : h("span", { class: `trace-dot${tone ? ` trace-dot--${tone}` : ""}` }),
    h("span", { class: "trace-agent-name" }, agentName(agent)),
    h("span", { class: "trace-agent-item-title" }, agent.title ?? ""),
    agent.model ? h("span", { class: "trace-agent-item-model", title: agent.model }, shortModel(agent.model)) : null,
    ui.mainAgent === agent.id ? h("small", null, "Main view") : h("small", { title: "Events recorded" }, String(agent.events))));
  }));
  return h("div", { style: { display: "flex", "flex-direction": "column", flex: "1 1 auto", "min-height": "0" } },
    h("div", { class: "trace-agent-list" }, list),
    h("p", { class: "trace-panel-hint" }, h("kbd", null, "/"), " search · ", h("kbd", null, "f"), " follow · ", h("kbd", null, "1"), h("kbd", null, "2"), h("kbd", null, "3"), " tabs · ", h("kbd", null, "Esc"), " back"));
}

function filesTree(files) {
  const groups = new Map();
  for (const file of files) {
    const group = file.kind === "memory" ? "Memory" : file.kind === "source" ? "Source" : "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(file);
  }
  const nest = (list) => {
    const root = { dirs: new Map(), files: [] };
    for (const file of list) {
      const parts = file.path.split("/").filter(Boolean);
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts.at(-1) ?? file.path, file });
    }
    return root;
  };
  const renderNode = (node) => h("ul", null,
    [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => h("li", null,
      h("details", { open: true }, h("summary", null, icon("folder", 14, ""), h("span", null, name)), renderNode(child)))),
    node.files.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, file }) => {
      const stat = diffStat(file);
      return h("li", { class: "docs-file" }, h("button", { type: "button", "aria-current": ui.selectedFile === file.path ? "page" : undefined, title: file.path, onclick: () => openFile(file.path) },
        icon("file", 14, ""), h("span", null, name),
        stat ? h("small", null, h("span", { style: { color: "var(--color-good)" } }, `+${stat.added}`), " ", h("span", { style: { color: "var(--color-danger)" } }, `−${stat.removed}`)) : null));
    }));
  return h("ul", null, ["Memory", "Source", "Other"].filter((group) => groups.has(group)).map((group) => h("li", null,
    h("details", { open: true, class: "trace-tree-group" }, h("summary", null, h("span", null, `${group} · ${groups.get(group).length}`)), renderNode(nest(groups.get(group)))))));
}

function renderFilesPanel(model) {
  if (model.files.length === 0) {
    panelBody.replaceChildren(h("div", { class: "trace-placeholder" }, icon("folder", 18, "activity-icon"), h("h2", null, "No files recorded yet"), h("p", null, "Memory pages and source files the run changes appear here, read-only, when it reports them.")));
    return;
  }
  const selected = model.files.find((file) => file.path === ui.selectedFile) ?? model.files[0];
  const toggle = h("div", { class: "live-toggle", role: "radiogroup", "aria-label": "File view" },
    ["contents", "diff"].map((mode) => h("button", { type: "button", role: "radio", "aria-checked": String(ui.fileMode === mode), onclick: () => { ui.fileMode = mode; scheduleRender(); } }, mode === "contents" ? "Contents" : "Diff")));
  const agent = selected.agentId ? model.agents.get(selected.agentId) : null;
  const content = selected.after ?? selected.before;
  const preview = h("section", { class: "build-ide-preview", "aria-label": "File preview" },
    h("div", { class: "build-file-heading" }, h("h3", { title: selected.path }, selected.path), kindTag(selected.kind), diffStatNode(selected)),
    h("p", { class: "trace-file-meta" },
      `Read-only · ${selected.at ? `recorded ${formatTime(selected.at)}` : "from run state"}${agent ? ` by ${agentName(agent)}` : ""}`,
      selected.after === null && selected.before !== null ? " · deleted (showing its last contents)" : "",
      selected.before === null && selected.after !== null && selected.fromState ? " · new file" : "",
      selected.afterSha256 ? ` · sha256 ${selected.afterSha256.slice(0, 12)}` : "",
      selected.truncated ? " · contents cut by the demo script (60,000 characters)" : ""),
    ui.fileMode === "diff" ? renderDiff(selected)
      : content !== null ? h("pre", { class: "trace-file-code" }, highlight(content))
      : selected.diff ? renderDiff(selected)
      : h("p", { class: "trace-muted" }, selected.pathOnly ? "The run named this file but has not recorded its contents yet." : "No contents were recorded for this file."));
  panelBody.replaceChildren(h("div", { class: "trace-files" },
    h("div", { class: "live-files-bar" }, toggle, h("span", { class: "live-status" }, `${plural(model.files.length, "file")} · read-only`)),
    h("div", { class: "build-ide-files-body" }, h("nav", { class: "build-ide-tree", "aria-label": "Changed files" }, filesTree(model.files)), preview)));
}

function renderDiffPanel(model) {
  const changed = model.files.filter((file) => file.before !== file.after || file.diff);
  if (changed.length === 0) {
    panelBody.replaceChildren(h("div", { class: "trace-placeholder" }, icon("diff", 18, "activity-icon"), h("h2", null, "No changes recorded yet"), h("p", null, "Source and memory diffs from the repair appear here as the run reports them.")));
    return;
  }
  const memory = changed.filter((file) => file.kind === "memory").length;
  panelBody.replaceChildren(h("div", { class: "trace-files" },
    h("div", { class: "live-files-bar" }, h("span", { class: "live-status" }, `Run-wide changes · ${plural(changed.length, "file")}${memory ? ` (${memory} memory)` : ""} · read-only`)),
    h("div", { class: "trace-diff-list" }, changed.map((file) => h("div", { class: "activity-file-change" },
      h("header", null,
        h("button", { type: "button", class: "trace-link-button activity-file-change-path", title: `Open ${file.path} in Files`, onclick: () => openFile(file.path) }, file.path),
        kindTag(file.kind),
        diffStatNode(file),
        file.at ? h("span", { class: "activity-file-change-meta" }, formatTime(file.at)) : null),
      renderDiff(file))))));
}

/* ------------------------------------------------------------------ */
/* Render loop and ticker.                                             */
/* ------------------------------------------------------------------ */

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    try {
      const model = deriveModel();
      if (ui.mainAgent && store.firstPollDone && store.events.length > 0 && !model.agents.has(ui.mainAgent)) ui.mainAgent = null;
      renderTopbar(model);
      renderMain(model);
      renderPanel(model);
    } catch (error) {
      console.error(error);
      const banner = document.getElementById("banner");
      banner.hidden = false;
      banner.className = "trace-banner trace-banner--error";
      banner.textContent = `The viewer could not render this data: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

setInterval(() => {
  for (const el of document.querySelectorAll("[data-since]")) {
    const since = ms(el.dataset.since);
    if (since !== null) el.textContent = formatClock(now() - since);
  }
  for (const el of document.querySelectorAll("[data-since-span]")) {
    const since = ms(el.dataset.sinceSpan);
    if (since !== null) el.textContent = `${el.dataset.prefix ?? ""}${formatSpan(Math.max(0, now() - since)) ?? ""}`;
  }
  if (runPhase() === "live") renderTopbar(deriveModel());
}, 1_000);

/* ------------------------------------------------------------------ */
/* Controls: follow, search, tabs, keyboard, resizable split.          */
/* ------------------------------------------------------------------ */

document.getElementById("follow").addEventListener("click", () => setFollow(!ui.follow));

const search = document.getElementById("search");
let searchTimer = 0;
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { ui.query = search.value; scheduleRender(); }, 120);
});

const tabs = document.getElementById("tabs");
tabs.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[role=tab]") : null;
  if (!button) return;
  if (button.dataset.tab === "agents" && ui.tab === "agents") ui.panelAgent = null;
  setTab(button.dataset.tab);
});
tabs.addEventListener("keydown", (event) => {
  const order = ["files", "diff", "agents"];
  const index = order.indexOf(ui.tab);
  let next = null;
  if (event.key === "ArrowRight") next = order[(index + 1) % order.length];
  else if (event.key === "ArrowLeft") next = order[(index + order.length - 1) % order.length];
  else if (event.key === "Home") next = order[0];
  else if (event.key === "End") next = order.at(-1);
  if (!next) return;
  event.preventDefault();
  setTab(next);
  requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
  if (event.key === "Escape") {
    if (target === search) {
      if (search.value) { search.value = ""; ui.query = ""; scheduleRender(); }
      else search.blur();
      return;
    }
    if (ui.panelAgent) { ui.panelAgent = null; writeHash(); scheduleRender(); return; }
    if (ui.replayTimer) { stopReplay(); scheduleRender(); return; }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "/") { event.preventDefault(); search.focus(); search.select(); }
  else if (event.key === "f") setFollow(!ui.follow);
  else if (event.key === "1") setTab("files");
  else if (event.key === "2") setTab("diff");
  else if (event.key === "3") setTab("agents");
});

const ide = document.getElementById("ide");
const separator = document.getElementById("separator");
const MIN_PANE = 24;
const MAX_PANE = 70;
let pane = Number(localStorage.getItem("procmem-trace-pane")) || 40;
function commitPane(value) {
  pane = Math.max(MIN_PANE, Math.min(MAX_PANE, value));
  ide.style.setProperty("--build-ide-right", `${pane}%`);
  separator.setAttribute("aria-valuenow", String(Math.round(pane)));
  localStorage.setItem("procmem-trace-pane", String(pane));
}
commitPane(pane);
separator.addEventListener("dblclick", () => commitPane(40));
separator.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") commitPane(pane + 2);
  else if (event.key === "ArrowRight") commitPane(pane - 2);
  else return;
  event.preventDefault();
});
separator.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  separator.setPointerCapture(event.pointerId);
  separator.dataset.dragging = "true";
  document.documentElement.setAttribute("data-workspace-resizing", "");
  const rect = ide.getBoundingClientRect();
  let pointerX = event.clientX;
  let latest = pane;
  let frame = 0;
  const paint = () => {
    frame = 0;
    latest = Math.max(MIN_PANE, Math.min(MAX_PANE, ((rect.right - pointerX) / rect.width) * 100));
    ide.style.setProperty("--build-ide-right", `${latest}%`);
  };
  const move = (moveEvent) => {
    pointerX = moveEvent.clientX;
    if (frame === 0) frame = requestAnimationFrame(paint);
  };
  const end = () => {
    separator.removeEventListener("pointermove", move);
    separator.removeEventListener("pointerup", end);
    separator.removeEventListener("pointercancel", end);
    separator.removeEventListener("lostpointercapture", end);
    if (frame !== 0) { cancelAnimationFrame(frame); paint(); }
    separator.dataset.dragging = "false";
    document.documentElement.removeAttribute("data-workspace-resizing");
    commitPane(latest);
  };
  separator.addEventListener("pointermove", move);
  separator.addEventListener("pointerup", end);
  separator.addEventListener("pointercancel", end);
  separator.addEventListener("lostpointercapture", end);
});

setFollow(true);
scheduleRender();
void poll();
