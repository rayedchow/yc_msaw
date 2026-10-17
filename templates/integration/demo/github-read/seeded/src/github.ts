/** Client for the GitHub REST "Get repository content" endpoint (public repositories, no credentials). */
const DEFAULT_API = "https://api.github.com";
const DEFAULT_REF = "master";
const MAX_TEXT_CHARS = 24_000;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._@+ -]{1,255}$/;

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly documentationUrl: string | null,
    readonly requestId: string | null,
    readonly request: string,
  ) {
    super(message);
  }
}

export interface GithubFile {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  sha: string;
  size: number;
  text: string;
  truncated: boolean;
  htmlUrl: string | null;
  github: { status: number; requestId: string | null; rateLimitRemaining: string | null };
}

/** Only the real API or a loopback test fixture; never an arbitrary URL. */
export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.GITHUB_API_BASE_URL || DEFAULT_API;
  if (base === DEFAULT_API || /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(base)) return base;
  throw new GithubError(0, "GITHUB_API_BASE_URL must be https://api.github.com or a loopback test fixture", null, null, "config");
}

export async function readFile(input: { owner: string; repo: string; path: string }, opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<GithubFile> {
  if (!NAME_RE.test(input.owner) || !NAME_RE.test(input.repo)) throw new GithubError(0, "owner and repo must be plain GitHub names", null, null, "validation");
  const segments = input.path.split("/");
  if (segments.some((s) => !PATH_SEGMENT_RE.test(s) || s === "." || s === "..")) throw new GithubError(0, "path must be a repository-relative file path", null, null, "validation");
  const base = opts.baseUrl ?? apiBase();
  const route = `/repos/${input.owner}/${input.repo}/contents/${segments.map(encodeURIComponent).join("/")}?ref=${DEFAULT_REF}`;
  const res = await (opts.fetchImpl ?? fetch)(`${base}${route}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "procmem-github-read" },
  });
  const requestId = res.headers.get("x-github-request-id");
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GithubError(res.status, String(body.message ?? `HTTP ${res.status}`), typeof body.documentation_url === "string" ? body.documentation_url : null, requestId, `GET ${route}`);
  }
  if (body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
    throw new GithubError(res.status, `Not a file (type ${String(body.type)})`, null, requestId, `GET ${route}`);
  }
  const full = Buffer.from(body.content, "base64").toString("utf8");
  return {
    owner: input.owner,
    repo: input.repo,
    path: input.path,
    ref: DEFAULT_REF,
    sha: String(body.sha),
    size: Number(body.size),
    text: full.slice(0, MAX_TEXT_CHARS),
    truncated: full.length > MAX_TEXT_CHARS,
    htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
    github: { status: res.status, requestId, rateLimitRemaining: res.headers.get("x-ratelimit-remaining") },
  };
}
