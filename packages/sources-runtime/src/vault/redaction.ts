const CONTENT_URI_REDACTION = "[redacted: ephemeral requester-scoped URL]";
const CREDENTIAL_URL_REDACTION = "[redacted: credentialed ephemeral URL]";
const CONFERENCE_CREDENTIAL_REDACTION = "[redacted: google-calendar conference credential]";

type ProviderRedactionKey = "global" | "gmail" | "google-calendar" | "google-docs" | "granola" | "notion" | "slack" | "atlassian" | "bitbucket" | "github";

export function redactProviderPayload(provider: string, value: unknown): unknown {
  return redactValue(providerRedactionKey(provider), value, []);
}

export function redactEphemeralUris(value: unknown): unknown {
  return redactProviderPayload("global", value);
}

function redactValue(provider: ProviderRedactionKey, value: unknown, path: string[]): unknown {
  if (typeof value === "string") return redactStringValue(provider, "", value, path) ?? value;
  if (Array.isArray(value)) return value.map((item) => redactValue(provider, item, path));
  if (value instanceof Date) return new Date(value.getTime());
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const redacted = typeof child === "string"
      ? redactStringValue(provider, key, child, path)
      : redactNonStringValue(provider, key, child, path);
    out[key] = redacted ?? redactValue(provider, child, [...path, key]);
  }
  return out;
}

function redactStringValue(provider: ProviderRedactionKey, key: string, value: string, path: string[]): string | null {
  if (key === "contentUri") return CONTENT_URI_REDACTION;
  // SOURCE-LANE PATCH (google-docs request 2): Slides image.contentUrl is requester-scoped like Docs contentUri.
  if (provider === "google-docs" && key === "contentUrl") return CONTENT_URI_REDACTION;
  if (isSignedCredentialUrl(value)) return CREDENTIAL_URL_REDACTION;

  switch (provider) {
    case "notion":
      if (isNotionRedactedUrlField(key, path) || normalizeKey(key) === "signedurl" || isNotionSecureAssetUrl(value)) {
        return CREDENTIAL_URL_REDACTION;
      }
      return null;
    case "google-calendar":
      if (isGoogleCalendarConferenceCredential(key, path)) return CONFERENCE_CREDENTIAL_REDACTION;
      return null;
    case "slack":
      if (isSlackCredentialUrlField(key)) return CREDENTIAL_URL_REDACTION;
      return null;
    case "granola":
      if (isGranolaAssetUrlField(key, path)) return CREDENTIAL_URL_REDACTION;
      return null;
    case "atlassian":
      if (isAtlassianCredentialUrlField(key, path, value)) return CREDENTIAL_URL_REDACTION;
      return null;
    case "github":
      // SOURCE-LANE PATCH (github request 4): private repository payloads carry a short-lived clone credential.
      if (key === "temp_clone_token" && value !== "") return "[redacted: github credential]";
      return redactGithubCredentialUrls(key, value);
    case "bitbucket":
      return null;
    default:
      return null;
  }
}

function redactNonStringValue(provider: ProviderRedactionKey, key: string, value: unknown, path: string[]): string | null {
  if (provider !== "google-calendar") return null;
  if (value === null || value === undefined) return null;
  return isGoogleCalendarConferenceCredential(key, path) ? CONFERENCE_CREDENTIAL_REDACTION : null;
}

function providerRedactionKey(provider: string): ProviderRedactionKey {
  const normalized = provider.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "calendar" || normalized === "google-calendar") return "google-calendar";
  if (normalized === "gdocs" || normalized === "google-docs") return "google-docs";
  if (normalized === "jira" || normalized === "confluence" || normalized === "atlassian") return "atlassian";
  if (normalized === "bitbucket" || normalized === "github") return normalized;
  if (normalized === "gmail" || normalized === "granola" || normalized === "notion" || normalized === "slack") return normalized;
  return "global";
}

export function isSignedCredentialUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const query = url.search.toLowerCase();
  const href = url.href.toLowerCase();
  const credentialParams = [
    "token",
    "access_token",
    "signature",
    "x-amz-signature",
    "x-goog-signature",
    "jwt",
    "sig",
  ];
  return query.includes("x-amz-signature=")
    || query.includes("x-goog-signature=")
    || query.includes("?token=")
    || query.includes("&token=")
    || credentialParams.some((param) => url.searchParams.has(param))
    || href.includes("pub_secret");
}

function isNotionRedactedUrlField(key: string, path: string[]): boolean {
  if (normalizeKey(key) !== "url") return false;
  const parent = normalizeKey(path[path.length - 1] ?? "");
  return parent === "file" || parent === "external";
}

function isNotionSecureAssetUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const href = url.href.toLowerCase();
  return href.includes("prod-files-secure.s3") || href.includes("secure.notion-static.com");
}

function isGoogleCalendarConferenceCredential(key: string, path: string[]): boolean {
  if (!path.some((part) => normalizeKey(part) === "conferencedata")) return false;
  return new Set(["uri", "accesscode", "passcode", "password", "signature"]).has(normalizeKey(key));
}

function isSlackCredentialUrlField(key: string): boolean {
  const normalized = normalizeKey(key);
  const lower = key.toLowerCase();
  return normalized.startsWith("urlprivate")
    || normalized === "permalinkpublic"
    || lower.startsWith("thumb_")
    || lower.startsWith("thumb-");
}

function isGranolaAssetUrlField(key: string, path: string[]): boolean {
  const normalized = normalizeKey(key);
  const parent = normalizeKey(path[path.length - 1] ?? "");
  return ((normalized.includes("asset") || normalized.includes("download")) && (normalized.endsWith("url") || normalized.endsWith("uri")))
    || ((parent.includes("asset") || parent.includes("download")) && (normalized === "url" || normalized === "uri"));
}

function isAtlassianCredentialUrlField(key: string, path: string[], value: string): boolean {
  const normalized = normalizeKey(key);
  const parent = normalizeKey(path[path.length - 1] ?? "");
  if (parent === "avatarurls") return true;
  if (!isUrlLikeKey(normalized)) return false;
  if (isAtlassianMediaUrl(value)) return true;
  return path.some((part) => {
    const value = normalizeKey(part);
    return value.includes("media")
      || value.includes("file")
      || value.includes("attachment")
      || value.includes("thumbnail")
      || value.includes("avatar");
  });
}

function isUrlLikeKey(normalizedKey: string): boolean {
  return normalizedKey === "url"
    || normalizedKey === "uri"
    || normalizedKey === "href"
    || normalizedKey.endsWith("url")
    || normalizedKey.endsWith("uri");
}

function isAtlassianMediaUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return host.includes("media.atlassian.com")
    || host.includes("atlassian.net") && (path.includes("/secure/attachment/") || path.includes("/file/"));
}

function redactGithubCredentialUrls(key: string, value: string): string | null {
  const normalized = normalizeKey(key);
  const scanEmbedded = normalized === "bodyhtml" || value.includes("private-user-images.githubusercontent.com");
  if (!scanEmbedded) return null;
  const redacted = value.replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) =>
    isGithubCredentialAssetUrl(candidate) ? CREDENTIAL_URL_REDACTION : candidate
  );
  return redacted === value ? null : redacted;
}

function isGithubCredentialAssetUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host === "private-user-images.githubusercontent.com"
    || host.endsWith(".private-user-images.githubusercontent.com")
    || isSignedCredentialUrl(value);
}

function parseHttpUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!/^https?:\/\//iu.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function normalizeKey(key: string): string {
  return key.replace(/[-_]/gu, "").toLowerCase();
}
