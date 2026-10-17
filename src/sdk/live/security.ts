/**
 * Credential hygiene for the live tool runtime.
 *
 *  - Every URL that receives a credential must be https, or http on a loopback host when the caller opted
 *    in with `allowInsecureLocalhost` (tests and local dev only).
 *  - Credentials are bound to one origin: `originBoundFetch` refuses any request whose URL is not on the
 *    expected origin and sets `redirect: "error"`, so a redirect can never carry a bearer elsewhere.
 *  - `scrubSecrets` removes bearer tokens, JWTs, procmem keys and any currently known secret values from text
 *    before it reaches a model, a trace, a log or an error message.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class UntrustedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedUrlError";
  }
}

export interface UrlPolicy {
  /** Allow http:// on localhost/127.0.0.1/[::1]. Never enable in production. */
  allowInsecureLocalhost?: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/** Parse and validate a URL that will receive credentials. Throws UntrustedUrlError (message has no secrets). */
export function trustedUrl(raw: string, policy: UrlPolicy, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UntrustedUrlError(`${what} is not a valid URL`);
  }
  if (url.username || url.password) throw new UntrustedUrlError(`${what} must not embed credentials`);
  if (url.hash) throw new UntrustedUrlError(`${what} must not have a fragment`);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && policy.allowInsecureLocalhost && isLoopbackHost(url.hostname)) return url;
  throw new UntrustedUrlError(
    url.protocol === "http:" && isLoopbackHost(url.hostname)
      ? `${what} uses http on loopback; set allowInsecureLocalhost for local testing only`
      : `${what} must use https (got ${url.protocol}//${url.host})`,
  );
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

/**
 * A fetch that only talks to `origin`, never follows redirects, and adds `authorization` from `bearer()`
 * (called per request so rotated credentials apply immediately). Any caller-supplied authorization header is
 * replaced, never forwarded.
 */
export function originBoundFetch(origin: string, bearer: () => Promise<string>, base: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.origin !== origin) throw new UntrustedUrlError(`Refusing to send credentials to ${url.origin} (bound to ${origin})`);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    headers.set("authorization", `Bearer ${await bearer()}`);
    const req = input instanceof Request ? input : url.toString();
    return base(req, { ...init, headers, redirect: "error" });
  }) as typeof fetch;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /\bpmk_[A-Za-z0-9_-]{8,}/g,
];

/** Remove secrets from free text. `known` are exact secret values currently in use (tokens, keys). */
export function scrubSecrets(text: string, known: Iterable<string> = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 8) out = out.split(k).join("[REDACTED]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, scheme?: string) => (typeof scheme === "string" && /^bearer$/i.test(scheme) ? `${scheme} [REDACTED]` : "[REDACTED]"));
  return out;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error && cause.message && !error.message.includes(cause.message) ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

/**
 * Deep copy of a JSON value with every occurrence of a KNOWN secret value (exact match, length >= 8) replaced by
 * "[REDACTED]" in every string value AND every object key. No field is exempt. Only exact known values are removed, so
 * ordinary data that merely looks like a token is untouched, and binary payloads (image/audio `data`, resource `blob`)
 * stay byte-identical unless they literally contain a secret. A media block whose bytes contain a secret is replaced by
 * a text notice (redacted bytes would be corrupt anyway). Returns the input itself when nothing matched.
 */
export function scrubKnownDeep<T>(value: T, known: readonly string[]): T {
  const secrets = known.filter((k) => typeof k === "string" && k.length >= 8);
  if (secrets.length === 0) return value;
  let changed = false;
  const str = (v: string): string => {
    let out = v;
    for (const k of secrets) if (out.includes(k)) out = out.split(k).join("[REDACTED]");
    if (out !== v) changed = true;
    return out;
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if ((o.type === "image" || o.type === "audio") && typeof o.data === "string" && secrets.some((k) => (o.data as string).includes(k))) {
        changed = true;
        return { type: "text", text: `[REDACTED ${o.type} content: it contained a credential]` };
      }
      // Define OWN data properties: a parsed "__proto__" key must stay JSON data, never become the clone's prototype.
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) Object.defineProperty(out, str(k), { value: visit(x), enumerable: true, writable: true, configurable: true });
      return out;
    }
    return v;
  };
  const result = visit(value);
  return (changed ? result : value) as T;
}
