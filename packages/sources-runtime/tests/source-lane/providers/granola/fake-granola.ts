/**
 * Local fake of Granola's public REST API (https://public-api.granola.ai/v1), as the donor poller
 * uses it: GET /notes (updated_after, created_after, folder_id, cursor, page_size; its own page size
 * forces pagination) and GET /notes/:id (?include=transcript). Notes are visible per API key, so a
 * second key is a different account. Failures, 403 transcript refusals and 429s are scriptable.
 * Synthetic data only.
 */

export interface FakeNote {
  id: string;
  object?: "note";
  title: string | null;
  owner?: { name?: string | null; email?: string | null } | null;
  created_at: string;
  updated_at: string;
  web_url?: string;
  calendar_event?: Record<string, unknown> | null;
  attendees?: Array<{ name?: string | null; email?: string | null }>;
  folder_membership?: Array<{ id: string; object?: "folder"; name?: string | null }>;
  summary_text?: string | null;
  summary_markdown?: string | null;
  transcript?: Array<Record<string, unknown>> | null;
  [key: string]: unknown;
}

export interface FakeCall {
  url: URL;
  status: number;
}

type Scripted = (url: URL) => Response | null;

export class FakeGranola {
  readonly notes = new Map<string, FakeNote>();
  /** API key -> visible note ids (an account). */
  readonly accounts = new Map<string, Set<string>>();
  readonly transcriptForbidden = new Set<string>();
  /** Notes whose transcript Granola has not produced yet (include=transcript returns transcript: []). */
  readonly transcriptPending = new Set<string>();
  readonly calls: FakeCall[] = [];
  pageSize = 3;
  private scripted: Scripted[] = [];

  account(apiKey: string, noteIds: string[] = []): void {
    this.accounts.set(apiKey, new Set(noteIds));
  }

  put(apiKey: string, note: FakeNote): void {
    this.notes.set(note.id, { object: "note", ...note });
    this.accounts.get(apiKey)!.add(note.id);
  }

  delete(noteId: string): void {
    this.notes.delete(noteId);
  }

  /** One-shot scripted responses, consulted in order before normal handling. */
  script(fn: Scripted): void {
    this.scripted.push(fn);
  }

  listCalls(): URL[] {
    return this.calls.filter((c) => c.url.pathname === "/v1/notes").map((c) => c.url);
  }

  detailCalls(id?: string): URL[] {
    return this.calls.filter((c) => c.url.pathname.startsWith("/v1/notes/") && (!id || c.url.pathname === `/v1/notes/${encodeURIComponent(id)}`)).map((c) => c.url);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "public-api.granola.ai") throw new Error(`unexpected host ${url.host}`);
    const res = this.handle(url, init);
    this.calls.push({ url, status: res.status });
    return res;
  };

  private handle(url: URL, init?: RequestInit): Response {
    for (let i = 0; i < this.scripted.length; i++) {
      const r = this.scripted[i]!(url);
      if (r) {
        this.scripted.splice(i, 1);
        return r;
      }
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const key = auth.replace(/^Bearer /, "");
    const visible = this.accounts.get(key);
    if (!visible) return new Response("invalid api key", { status: 401 });

    if (url.pathname === "/v1/notes") {
      const updatedAfter = url.searchParams.get("updated_after");
      const createdAfter = url.searchParams.get("created_after");
      const folder = url.searchParams.get("folder_id");
      const all = [...visible]
        .map((id) => this.notes.get(id))
        .filter((n): n is FakeNote => Boolean(n))
        .filter((n) => !updatedAfter || n.updated_at > updatedAfter)
        .filter((n) => !createdAfter || n.created_at > createdAfter)
        .filter((n) => !folder || (n.folder_membership ?? []).some((f) => f.id === folder))
        .sort((a, b) => (a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at < b.created_at ? -1 : 1));
      const cursor = url.searchParams.get("cursor");
      const offset = cursor ? Number(/^c(\d+)$/.exec(cursor)?.[1] ?? NaN) : 0;
      if (!Number.isFinite(offset)) return new Response("invalid cursor", { status: 400 });
      const size = Math.min(this.pageSize, Number(url.searchParams.get("page_size") ?? this.pageSize));
      const page = all.slice(offset, offset + size);
      const hasMore = offset + size < all.length;
      return Response.json({
        notes: page.map((n) => ({ id: n.id, object: "note", title: n.title, owner: n.owner ?? null, created_at: n.created_at, updated_at: n.updated_at })),
        hasMore,
        cursor: hasMore ? `c${offset + size}` : null,
      });
    }
    const m = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const note = visible.has(id) ? this.notes.get(id) : undefined;
      if (!note) return new Response(JSON.stringify({ error: "Note not found" }), { status: 404 });
      const withTranscript = url.searchParams.get("include") === "transcript";
      if (withTranscript && this.transcriptForbidden.has(id)) return new Response("transcripts are not available on this plan", { status: 403 });
      const { transcript, ...rest } = note;
      if (!withTranscript) return Response.json(rest);
      return Response.json({ ...rest, transcript: this.transcriptPending.has(id) ? [] : transcript ?? null });
    }
    return new Response("not found", { status: 404 });
  }
}

export function note(id: string, at: string, extra: Partial<FakeNote> = {}): FakeNote {
  return {
    id,
    title: `Meeting ${id}`,
    owner: { name: "Owner One", email: "owner@example.test" },
    created_at: at,
    updated_at: at,
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: {
      event_title: `Meeting ${id}`,
      organiser: "organiser@example.test",
      calendar_event_id: `cal-${id}`,
      scheduled_start_time: at,
      scheduled_end_time: at,
      invitees: [{ email: "guest@example.test" }],
    },
    attendees: [{ name: "Guest Two", email: "guest@example.test" }],
    folder_membership: [],
    summary_text: `summary of ${id}`,
    summary_markdown: `## Summary of ${id}`,
    transcript: [
      { speaker: { source: "microphone" }, text: `hello from owner in ${id}`, start_time: "2027-01-01T10:00:00.000Z", end_time: "2027-01-01T10:00:04.250Z", confidence: 0.93 },
      { speaker: { source: "speaker", diarization_label: "Speaker B" }, text: `reply in ${id}`, start_time: "2027-01-01T10:00:05.000Z", end_time: "2027-01-01T10:00:09.000Z" },
    ],
    ...extra,
  };
}
