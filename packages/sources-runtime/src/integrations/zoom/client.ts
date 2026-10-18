const ZOOM_API = "https://api.zoom.us/v2";

export type ZoomRecordingFile = {
  id: string;
  file_type?: string;
  file_extension?: string;
  file_size?: number;
  recording_start?: string;
  recording_end?: string;
  status?: string;
  download_url?: string;
  play_url?: string;
};

export type ZoomRecordingMeeting = {
  uuid: string;
  id: number | string;
  host_id?: string;
  host_email?: string;
  topic?: string;
  type?: number | string;
  start_time?: string;
  duration?: number;
  timezone?: string;
  recording_count?: number;
  total_size?: number;
  share_url?: string;
  auto_delete?: boolean;
  auto_delete_date?: string;
  recording_files?: ZoomRecordingFile[];
};

export type ZoomParticipant = {
  id?: string;
  user_id?: string;
  name?: string;
  user_email?: string;
  join_time?: string;
  leave_time?: string;
  duration?: number;
};

// SOURCE-LANE PATCH (coordinator): no in-process sleep (the donor slept up to 30 s, three times) - a 429 or 5xx
// surfaces as ZoomApiError with its Retry-After for the caller to persist on the cursor; redirects are
// followed manually and the bearer is sent only to Zoom hosts (transcript downloads redirect to a CDN).
export class ZoomApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds: number | null) {
    super(message);
    this.name = "ZoomApiError";
  }
}

export type ZoomFetch = (url: string, init?: RequestInit) => Promise<Response>;
let zoomFetch: ZoomFetch = (url, init) => fetch(url, init);
/** Test seam: the transport used by every Zoom request. */
export function setZoomFetchForTests(impl: ZoomFetch | null): void {
  zoomFetch = impl ?? ((url, init) => fetch(url, init));
}
export function zoomTransport(): ZoomFetch {
  return zoomFetch;
}

const ZOOM_HOSTS = /(^|\.)zoom\.us$/u;

async function zoomRequest(token: string, pathOrUrl: string): Promise<Response> {
  let url = pathOrUrl.startsWith("http") ? pathOrUrl : `${ZOOM_API}${pathOrUrl}`;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(url);
    if (host.protocol !== "https:") throw new ZoomApiError(0, `Zoom request to non-https URL refused`, null);
    const authorized = ZOOM_HOSTS.test(host.hostname);
    let response: Response;
    try {
      response = await zoomFetch(url, {
        headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json, text/vtt, text/plain" },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new ZoomApiError(0, `Zoom request failed: ${err instanceof Error ? err.message : String(err)}`, 30);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      url = new URL(response.headers.get("location")!, url).toString();
      await response.body?.cancel().catch(() => {});
      continue;
    }
    if (!response.ok) {
      const ra = response.headers.get("retry-after");
      const seconds = ra == null ? null : Number.isFinite(Number(ra)) ? Math.ceil(Number(ra)) : Math.max(0, Math.ceil((Date.parse(ra) - Date.now()) / 1000));
      const body = await response.text().catch(() => "");
      throw new ZoomApiError(response.status, `Zoom API failed (${response.status}): ${body.slice(0, 300)}`, response.status === 429 ? seconds ?? 60 : response.status >= 500 ? 30 : null);
    }
    return response;
  }
  throw new ZoomApiError(0, "Zoom request redirected too many times", null);
}

export async function listZoomRecordings(token: string, input: { from: string; to: string; nextPageToken?: string }): Promise<{ meetings: ZoomRecordingMeeting[]; next_page_token?: string }> {
  const params = new URLSearchParams({ from: input.from, to: input.to, page_size: "300" });
  if (input.nextPageToken) params.set("next_page_token", input.nextPageToken);
  return zoomRequest(token, `/users/me/recordings?${params}`).then((response) => response.json());
}

/** Zoom requires UUIDs beginning with / or containing // to be double encoded. */
export function encodeZoomMeetingUuid(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

export async function listZoomParticipants(token: string, uuid: string): Promise<ZoomParticipant[]> {
  const participants: ZoomParticipant[] = [];
  let nextPageToken: string | undefined;
  do {
    const params = new URLSearchParams({ page_size: "300" });
    if (nextPageToken) params.set("next_page_token", nextPageToken);
    const page = await zoomRequest(token, `/past_meetings/${encodeZoomMeetingUuid(uuid)}/participants?${params}`).then((response) => response.json()) as { participants?: ZoomParticipant[]; next_page_token?: string };
    participants.push(...(page.participants ?? []));
    nextPageToken = page.next_page_token || undefined;
  } while (nextPageToken);
  return participants;
}

export async function downloadZoomTranscript(token: string, url: string): Promise<string> {
  return zoomRequest(token, url).then((response) => response.text());
}
