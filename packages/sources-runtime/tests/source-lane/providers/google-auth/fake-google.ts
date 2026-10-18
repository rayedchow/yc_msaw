import { createHash } from "node:crypto";

/**
 * Synthetic Google OAuth endpoints for tests (no network, no real credentials).
 * Records every request so tests can assert PKCE verifiers, refresh counts and
 * that no call happened at all.
 */
export const TEST_CLIENT_ID = "test-client.apps.googleusercontent.com";

export function idToken(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.c2ln`;
}

export interface FakeGoogleOptions {
  email?: string;
  sub?: string;
  hd?: string | null;
  scope?: string;
  refreshResponses?: Array<{ status: number; body: Record<string, unknown>; headers?: Record<string, string> }>;
  idTokenOverride?: (claims: Record<string, unknown>) => Record<string, unknown>;
}

export interface RecordedCall {
  url: string;
  method: string;
  body: URLSearchParams | null;
  headers: Headers;
}

export function fakeGoogle(options: FakeGoogleOptions = {}) {
  const calls: RecordedCall[] = [];
  let nonce: string | null = null;
  let issued = 0;
  const refreshQueue = [...(options.refreshResponses ?? [])];

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : init.body instanceof URLSearchParams ? init.body : null;
    calls.push({ url, method: init.method ?? "GET", body, headers: new Headers(init.headers) });

    if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "authorization_code") {
      issued += 1;
      const claims: Record<string, unknown> = {
        iss: "https://accounts.google.com",
        aud: TEST_CLIENT_ID,
        azp: TEST_CLIENT_ID,
        sub: options.sub ?? "1100000000000000001",
        email: options.email ?? "ada@corp.example",
        email_verified: true,
        ...(options.hd === null ? {} : { hd: options.hd ?? "corp.example" }),
        nonce,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      return Response.json({
        access_token: `ya29.synthetic-access-${issued}`,
        refresh_token: `1//synthetic-refresh-${issued}`,
        expires_in: 3599,
        scope: options.scope ?? [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/drive.activity.readonly",
          "https://www.googleapis.com/auth/contacts.readonly",
          "https://www.googleapis.com/auth/contacts.other.readonly",
          "https://www.googleapis.com/auth/directory.readonly",
        ].join(" "),
        token_type: "Bearer",
        id_token: idToken(options.idTokenOverride ? options.idTokenOverride(claims) : claims),
      });
    }
    if (url === "https://oauth2.googleapis.com/token" && body?.get("grant_type") === "refresh_token") {
      const next = refreshQueue.shift();
      if (next) return Response.json(next.body, { status: next.status, headers: next.headers });
      issued += 1;
      return Response.json({ access_token: `ya29.synthetic-access-${issued}`, expires_in: 3599, token_type: "Bearer" });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    /** The fake authorization server echoes the nonce from the authorize URL into the ID token. */
    authorize(authorizeUrl: string): { state: string; challenge: string } {
      const u = new URL(authorizeUrl);
      nonce = u.searchParams.get("nonce");
      return { state: u.searchParams.get("state")!, challenge: u.searchParams.get("code_challenge")! };
    },
    tokenCalls(grantType: string): RecordedCall[] {
      return calls.filter((c) => c.url === "https://oauth2.googleapis.com/token" && c.body?.get("grant_type") === grantType);
    },
  };
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
