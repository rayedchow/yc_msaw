import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { IntegrationError } from "../types.js";
import { sha256 } from "../../util.js";
import { checkOutboundUrl, defaultAddressPolicy, type AddressPolicy } from "./url-guard.js";

/**
 * Bounded, SSRF-hardened GET for host-side research.
 *
 * - Every hop (initial URL and each redirect) passes checkOutboundUrl.
 * - DNS is resolved by us; if ANY resolved address fails the address policy
 *   the hop is rejected ("url_rejected"), otherwise the socket connects to
 *   those validated addresses (pinned: no second lookup, so no rebinding).
 *   TLS SNI and Host stay the original hostname.
 * - Only fixed Accept / User-Agent / Accept-Encoding headers are sent. No
 *   cookies, no Authorization, no caller-supplied headers.
 * - Hard byte cap (body is cut, socket destroyed, truncated: true) and one
 *   total deadline across all hops.
 * - Non-2xx responses are returned as data; the tool layer decides.
 */

export const SAFE_FETCH_USER_AGENT = "procmem-integration-research/0.1";
export const SAFE_FETCH_ACCEPT = "text/html,application/xhtml+xml,application/json,application/xml,text/plain,text/markdown,*/*;q=0.5";
export const SAFE_FETCH_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const SAFE_FETCH_MAX_BYTES = 8 * 1024 * 1024;
export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const SAFE_FETCH_MAX_TIMEOUT_MS = 30_000;
export const SAFE_FETCH_DEFAULT_MAX_REDIRECTS = 3;

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const defaultResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export interface SafeFetchOptions {
  /** Default 2 MiB, clamped to 8 MiB. */
  maxBytes?: number;
  /** Total deadline across all hops. Default 15s, clamped to 30s. */
  timeoutMs?: number;
  /** Default 3. */
  maxRedirects?: number;
  allowHttp?: boolean;
  allowPorts?: readonly number[];
  /** Which addresses may be connected to. Default blocks private/reserved/loopback. */
  addressPolicy?: AddressPolicy;
  /** Hostname resolver (default dns.promises.lookup all:true). */
  resolver?: Resolver;
  signal?: AbortSignal;
}

export interface SafeFetchRedirect {
  status: number;
  location: string;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  redirects: SafeFetchRedirect[];
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  bytes: number;
  /** sha256 hex of exactly the bytes received (after truncation). */
  sha256: string;
  body: Buffer;
  truncated: boolean;
  /** Addresses the final hop was pinned to ([] for IP-literal hosts). */
  resolvedAddresses: string[];
  retrievedAt: string;
  durationMs: number;
}

export type SafeFetch = (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;

interface Hop {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  resolved: string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const safeFetch: SafeFetch = async (requestedUrl, opts = {}) => {
  const started = Date.now();
  const maxBytes = clamp(opts.maxBytes ?? SAFE_FETCH_DEFAULT_MAX_BYTES, 1, SAFE_FETCH_MAX_BYTES);
  const timeoutMs = clamp(opts.timeoutMs ?? SAFE_FETCH_DEFAULT_TIMEOUT_MS, 1, SAFE_FETCH_MAX_TIMEOUT_MS);
  const maxRedirects = clamp(opts.maxRedirects ?? SAFE_FETCH_DEFAULT_MAX_REDIRECTS, 0, 10);
  const policy = opts.addressPolicy ?? defaultAddressPolicy;
  const resolver = opts.resolver ?? defaultResolver;
  const deadline = started + timeoutMs;
  const redirects: SafeFetchRedirect[] = [];
  let current = requestedUrl;

  for (;;) {
    const check = checkOutboundUrl(current, { allowHttp: opts.allowHttp, allowPorts: opts.allowPorts, addressPolicy: policy });
    if (!check.ok) {
      throw new IntegrationError("url_rejected", `URL rejected${redirects.length ? ` after redirect ${redirects.length}` : ""}: ${check.reason}`, {
        url: current,
        redirects,
      });
    }
    const hop = await requestOnce(check.url, check.hostname, { deadline, timeoutMs, maxBytes, policy, resolver, signal: opts.signal });
    const location = hop.headers.location;
    if (REDIRECT_STATUSES.has(hop.status) && typeof location === "string" && location) {
      redirects.push({ status: hop.status, location });
      if (redirects.length > maxRedirects) {
        throw new IntegrationError("too_many_redirects", `More than ${maxRedirects} redirects`, { requestedUrl, redirects });
      }
      try {
        current = new URL(location, check.url).href;
      } catch {
        throw new IntegrationError("url_rejected", `Redirect location is not a valid URL`, { location, redirects });
      }
      continue;
    }
    return {
      requestedUrl,
      finalUrl: check.url.href,
      redirects,
      status: hop.status,
      contentType: headerValue(hop.headers["content-type"]),
      contentEncoding: headerValue(hop.headers["content-encoding"]),
      bytes: hop.body.length,
      sha256: sha256(hop.body),
      body: hop.body,
      truncated: hop.truncated,
      resolvedAddresses: hop.resolved,
      retrievedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  }
};

function requestOnce(
  url: URL,
  hostname: string,
  o: { deadline: number; timeoutMs: number; maxBytes: number; policy: AddressPolicy; resolver: Resolver; signal?: AbortSignal },
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const remaining = o.deadline - Date.now();
    if (remaining <= 0) return reject(new IntegrationError("timeout", `Fetch exceeded ${o.timeoutMs}ms`));
    if (o.signal?.aborted) return reject(new IntegrationError("aborted", "Fetch aborted by caller"));

    let rejection: IntegrationError | null = null;
    let settled = false;
    const resolved: string[] = [];

    const lookup: LookupFunction = (host, options, callback) => {
      o.resolver(host).then(
        (addrs) => {
          if (addrs.length === 0) {
            rejection = new IntegrationError("dns_failed", `No addresses for ${host}`);
            return callback(rejection, "", 4);
          }
          const blocked = addrs.find((a) => !o.policy(a.address));
          if (blocked) {
            rejection = new IntegrationError("url_rejected", `Hostname ${host} resolves to blocked address ${blocked.address}`, {
              hostname: host,
              addresses: addrs.map((a) => a.address),
            });
            return callback(rejection, "", 4);
          }
          const wanted = options.family === 4 || options.family === 6 ? addrs.filter((a) => a.family === options.family) : addrs;
          const usable = wanted.length ? wanted : addrs;
          for (const a of usable) resolved.push(a.address);
          if (options.all) return callback(null, usable);
          const first = usable[0]!;
          return callback(null, first.address, first.family);
        },
        (error: NodeJS.ErrnoException) => {
          rejection = new IntegrationError("dns_failed", `DNS lookup failed for ${host}: ${error.code ?? error.message}`);
          callback(rejection, "", 4);
        },
      );
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (error: IntegrationError) => finish(() => {
      req.destroy();
      reject(error);
    });

    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: url.protocol,
      hostname,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { Accept: SAFE_FETCH_ACCEPT, "User-Agent": SAFE_FETCH_USER_AGENT, "Accept-Encoding": "identity" },
      lookup,
      agent: false,
      ...(url.protocol === "https:" ? { servername: hostname.includes(":") ? undefined : hostname } : {}),
    });

    const timer = setTimeout(() => fail(new IntegrationError("timeout", `Fetch exceeded ${o.timeoutMs}ms`)), remaining);
    const onAbort = () => fail(new IntegrationError("aborted", "Fetch aborted by caller"));
    o.signal?.addEventListener("abort", onAbort, { once: true });

    req.on("error", (error) => {
      if (rejection) return fail(rejection);
      fail(new IntegrationError("fetch_failed", `Request to ${url.host} failed: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
    });

    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status) && res.headers.location) {
        res.destroy();
        return finish(() => {
          req.destroy();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false, resolved });
        });
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        const room = o.maxBytes - received;
        if (chunk.length > room) {
          // Cap reached: keep exactly maxBytes, stop reading, drop the socket.
          chunks.push(chunk.subarray(0, room));
          return finish(() => {
            res.destroy();
            req.destroy();
            resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated: true, resolved });
          });
        }
        chunks.push(chunk);
        received += chunk.length;
      });
      res.on("end", () => finish(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks), truncated: false, resolved })));
      res.on("error", (error) => fail(new IntegrationError("fetch_failed", `Response from ${url.host} failed: ${error.message}`)));
      res.on("aborted", () => fail(new IntegrationError("fetch_failed", `Response from ${url.host} was aborted`)));
    });

    req.end();
  });
}

function headerValue(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
