import { env } from "../../env.js";

const NANGO_API_BASE = "https://api.nango.dev";
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 45_000;
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface NangoClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface NangoConnectionTokenInput {
  providerConfigKey: string;
  connectionId: string;
}

export interface NangoListRecordsInput extends NangoConnectionTokenInput {
  model: string;
  cursor?: string | null;
}

export interface NangoListRecordsResult {
  records: Record<string, unknown>[];
  nextCursor: string | null;
}

export interface NangoConnectSessionInput {
  tenantId: string;
  allowedIntegrations: string[];
}

export interface NangoConnectSessionResult {
  sessionToken: string;
  connectLink: string | null;
  raw: Record<string, unknown>;
}

export interface NangoListConnectionsInput {
  providerConfigKey?: string;
}

export interface NangoConnection {
  connectionId: string;
  providerConfigKey: string;
  endUserId: string | null;
  raw: Record<string, unknown>;
}

export interface NangoProxyInput extends NangoConnectionTokenInput {
  /** Provider REST path relative to the provider base URL, e.g. `/repos/o/r/issues`. */
  endpoint: string;
  method?: "GET";
  params?: Record<string, string | number | undefined>;
  /**
   * HTTP statuses returned by the provider that should NOT throw (the caller
   * handles them). e.g. Bitbucket returns 404 when a repo's issue tracker is
   * disabled - that's "no tracker", not an error.
   */
  tolerateStatuses?: number[];
}

export interface NangoProxyResult {
  status: number;
  data: unknown;
}

export class NangoRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "NangoRequestError";
  }
}

export class NangoClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: NangoClientOptions = {}) {
    const apiKey = options.apiKey ?? env.NANGO_SECRET_KEY;
    if (!apiKey) throw new Error("NANGO_SECRET_KEY is required");

    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? NANGO_API_BASE).replace(/\/+$/u, "");
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? 250;
  }

  async createConnectSession(input: NangoConnectSessionInput): Promise<NangoConnectSessionResult> {
    if (input.allowedIntegrations.length === 0) {
      throw new Error("Nango connect session requires at least one allowed integration");
    }
    const data = await this.requestJson({
      method: "POST",
      path: "/connect/sessions",
      body: {
        end_user: { id: input.tenantId },
        allowed_integrations: input.allowedIntegrations,
      },
    });
    const record = asRecord(data) ?? {};
    const nested = asRecord(record.data) ?? record;
    const sessionToken =
      stringValue(nested.token)
      ?? stringValue(nested.session_token)
      ?? stringValue(nested.sessionToken)
      ?? stringValue(record.token)
      ?? stringValue(record.session_token)
      ?? stringValue(record.sessionToken);
    const connectLink =
      stringValue(nested.connect_link)
      ?? stringValue(nested.connectLink)
      ?? stringValue(record.connect_link)
      ?? stringValue(record.connectLink);
    if (!sessionToken) throw new NangoRequestError("Nango connect session response did not include a session token");
    return { sessionToken, connectLink, raw: record };
  }

  async deleteConnection(input: NangoConnectionTokenInput): Promise<void> {
    await this.requestJson({
      method: "DELETE",
      path: `/connection/${encodeURIComponent(input.connectionId)}`,
      query: { provider_config_key: input.providerConfigKey },
      allowEmpty: true,
    });
  }

  async getConnectionToken(input: NangoConnectionTokenInput): Promise<Record<string, unknown>> {
    const data = await this.requestJson({
      method: "GET",
      path: `/connection/${encodeURIComponent(input.connectionId)}`,
      query: { provider_config_key: input.providerConfigKey },
    });
    const record = asRecord(data);
    const credentials = asRecord(record?.credentials);
    return credentials ?? record ?? {};
  }

  async listConnections(input: NangoListConnectionsInput = {}): Promise<NangoConnection[]> {
    // GET /connection rejects a provider_config_key query param with HTTP 400
    // (unrecognized_keys) - list everything and filter client-side instead.
    const data = await this.requestJson({
      method: "GET",
      path: "/connection",
      query: {},
    });
    const connections = normalizeConnectionsResponse(data);
    if (!input.providerConfigKey) return connections;
    return connections.filter((c) => c.providerConfigKey === input.providerConfigKey);
  }

  async listRecords(input: NangoListRecordsInput): Promise<NangoListRecordsResult> {
    // Nango's /records API takes the connection identity as HEADERS
    // (Provider-Config-Key / Connection-Id); passing them as query params is
    // rejected with HTTP 400 "unrecognized_keys". Only model/cursor are query.
    const data = await this.requestJson({
      method: "GET",
      path: "/records",
      query: {
        model: input.model,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      headers: {
        "Provider-Config-Key": input.providerConfigKey,
        "Connection-Id": input.connectionId,
      },
    });
    return normalizeRecordsResponse(data);
  }

  /**
   * Call a provider REST endpoint through Nango's proxy using the stored
   * connection. Used for endpoints Nango's sync templates don't cover
   * (GitHub/Bitbucket issues). Honors Retry-After on 429/503 and retries the
   * same statuses as the JSON path; tolerated statuses are returned to the
   * caller instead of throwing.
   */
  async proxy(input: NangoProxyInput): Promise<NangoProxyResult> {
    const url = new URL(`${this.baseUrl}/proxy${input.endpoint.startsWith("/") ? "" : "/"}${input.endpoint}`);
    for (const [key, value] of Object.entries(input.params ?? {})) {
      if (value !== undefined && String(value).length > 0) url.searchParams.set(key, String(value));
    }
    const tolerate = new Set(input.tolerateStatuses ?? []);

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchProxyWithTimeout(url, input);
        if (tolerate.has(response.status)) {
          const text = await response.text().catch(() => "");
          return { status: response.status, data: text.trim() ? safeJsonParse(text) : null };
        }
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          if (attempt < this.maxAttempts && RETRYABLE.has(response.status)) {
            await sleep(retryAfterMs(response) ?? backoffMs(this.retryDelayMs, attempt));
            continue;
          }
          throw new NangoRequestError(
            `Nango proxy request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
            response.status,
          );
        }
        const text = await response.text();
        return { status: response.status, data: text.trim() ? JSON.parse(text) as unknown : null };
      } catch (error) {
        lastError = error;
        if (error instanceof NangoRequestError) throw error;
        if (attempt < this.maxAttempts && isRetryableError(error)) {
          await sleep(backoffMs(this.retryDelayMs, attempt));
          continue;
        }
        throw new NangoRequestError(`Nango proxy request failed: ${errorMessage(error)}`);
      }
    }

    throw new NangoRequestError(`Nango proxy request failed: ${errorMessage(lastError)}`);
  }

  private async fetchProxyWithTimeout(url: URL, input: NangoProxyInput): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: input.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "Provider-Config-Key": input.providerConfigKey,
          "Connection-Id": input.connectionId,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson(input: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    allowEmpty?: boolean;
  }): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value.length > 0) url.searchParams.set(key, value);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, input);
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          if (attempt < this.maxAttempts && RETRYABLE.has(response.status)) {
            // Same as the proxy path: honor Retry-After when present, fall
            // back to exponential backoff otherwise.
            await sleep(retryAfterMs(response) ?? backoffMs(this.retryDelayMs, attempt));
            continue;
          }
          throw new NangoRequestError(
            `Nango request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
            response.status,
          );
        }
        const text = await response.text();
        if (!text.trim()) {
          if (input.allowEmpty) return {};
          throw new NangoRequestError("Nango response body was empty");
        }
        return JSON.parse(text) as unknown;
      } catch (error) {
        lastError = error;
        if (error instanceof NangoRequestError) throw error;
        if (attempt < this.maxAttempts && isRetryableError(error)) {
          await sleep(backoffMs(this.retryDelayMs, attempt));
          continue;
        }
        throw new NangoRequestError(`Nango request failed: ${errorMessage(error)}`);
      }
    }

    throw new NangoRequestError(`Nango request failed: ${errorMessage(lastError)}`);
  }

  private async fetchWithTimeout(
    url: URL,
    input: { method: "GET" | "POST" | "DELETE"; body?: Record<string, unknown>; headers?: Record<string, string> },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(input.body ? { "Content-Type": "application/json" } : {}),
          ...(input.headers ?? {}),
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createConnectSession(input: NangoConnectSessionInput): Promise<NangoConnectSessionResult> {
  return new NangoClient().createConnectSession(input);
}

export function deleteConnection(input: NangoConnectionTokenInput): Promise<void> {
  return new NangoClient().deleteConnection(input);
}

export function getConnectionToken(input: NangoConnectionTokenInput): Promise<Record<string, unknown>> {
  return new NangoClient().getConnectionToken(input);
}

export function listConnections(input: NangoListConnectionsInput = {}): Promise<NangoConnection[]> {
  return new NangoClient().listConnections(input);
}

export function listRecords(input: NangoListRecordsInput): Promise<NangoListRecordsResult> {
  return new NangoClient().listRecords(input);
}

export function proxy(input: NangoProxyInput): Promise<NangoProxyResult> {
  return new NangoClient().proxy(input);
}

function normalizeRecordsResponse(data: unknown): NangoListRecordsResult {
  if (Array.isArray(data)) {
    return { records: recordsOnly(data), nextCursor: null };
  }
  const record = asRecord(data);
  if (!record) return { records: [], nextCursor: null };

  const records =
    arrayValue(record.records)
    ?? arrayValue(record.data)
    ?? arrayValue(record.items)
    ?? [];
  return {
    records: recordsOnly(records),
    nextCursor: stringValue(record.next_cursor)
      ?? stringValue(record.nextCursor)
      ?? stringValue(record.cursor)
      ?? null,
  };
}

function normalizeConnectionsResponse(data: unknown): NangoConnection[] {
  const record = asRecord(data);
  const values = Array.isArray(data)
    ? data
    : arrayValue(record?.connections)
      ?? arrayValue(record?.data)
      ?? arrayValue(record?.items)
      ?? [];
  return values
    .map((value) => normalizeConnection(value))
    .filter((value): value is NangoConnection => value !== null);
}

function normalizeConnection(value: unknown): NangoConnection | null {
  const record = asRecord(value);
  if (!record) return null;

  const connectionId =
    stringValue(record.connection_id)
    ?? stringValue(record.connectionId)
    ?? stringValue(record.id);
  const providerConfigKey =
    stringValue(record.provider_config_key)
    ?? stringValue(record.providerConfigKey)
    ?? stringValue(record.provider_config);
  if (!connectionId || !providerConfigKey) return null;

  const endUser = asRecord(record.end_user) ?? asRecord(record.endUser);
  const endUserId =
    stringValue(endUser?.id)
    ?? stringValue(record.end_user_id)
    ?? stringValue(record.endUserId);
  return { connectionId, providerConfigKey, endUserId, raw: record };
}

function recordsOnly(values: unknown[]): Record<string, unknown>[] {
  return values.filter((value): value is Record<string, unknown> => Boolean(asRecord(value)));
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return !(error instanceof NangoRequestError);
}

function backoffMs(baseMs: number, attempt: number): number {
  return baseMs * 2 ** (attempt - 1);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, if present. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
