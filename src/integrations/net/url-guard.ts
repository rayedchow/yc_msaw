import { isIP } from "node:net";

/**
 * Outbound URL policy for host-side research fetches. Pure functions: no DNS,
 * no I/O. Hostnames are validated here; resolved addresses are validated again
 * at connect time by safe-fetch (DNS pinning), so a hostname that passes this
 * guard can still be rejected when it resolves to a blocked address.
 */

/** Returns true when an address may be connected to. Default: !isBlockedAddress. */
export type AddressPolicy = (ip: string) => boolean;

export interface UrlGuardOptions {
  /** Permit plain http (default false: https only). */
  allowHttp?: boolean;
  /** Extra permitted ports beyond the protocol default (443 / 80). */
  allowPorts?: readonly number[];
  /** Policy for IP-literal hostnames. Default blocks private/reserved ranges. */
  addressPolicy?: AddressPolicy;
}

export type UrlCheck =
  | { ok: true; url: URL; hostname: string; ipLiteral: boolean }
  | { ok: false; reason: string };

export const defaultAddressPolicy: AddressPolicy = (ip) => !isBlockedAddress(ip);

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.goog",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.com",
  "metadata.platformequinix.com",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain", ".intranet", ".lan", ".corp"];

/** True when a hostname (no brackets, lowercase or not) is a reserved/internal name. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Validate a URL for outbound fetch. Never throws; returns a reason on rejection. */
export function checkOutboundUrl(input: string | URL, opts: UrlGuardOptions = {}): UrlCheck {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : new URL(input.href);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && opts.allowHttp)) {
    return { ok: false, reason: `protocol ${url.protocol} is not allowed${url.protocol === "http:" ? " (https only)" : ""}` };
  }
  if (url.username || url.password) return { ok: false, reason: "URLs with embedded credentials (userinfo) are not allowed" };
  // WHATWG URL normalizes the default port to "".
  if (url.port !== "") {
    const port = Number(url.port);
    if (!(opts.allowPorts ?? []).includes(port)) return { ok: false, reason: `port ${port} is not allowed` };
  }
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (!hostname) return { ok: false, reason: "URL has no hostname" };
  const ipLiteral = isIP(hostname) !== 0;
  if (ipLiteral) {
    const policy = opts.addressPolicy ?? defaultAddressPolicy;
    if (!policy(hostname)) return { ok: false, reason: `address ${hostname} is in a private or reserved range` };
  } else {
    if (isBlockedHostname(hostname)) return { ok: false, reason: `hostname ${hostname} is an internal or reserved name` };
    if (!hostname.replace(/\.+$/, "").includes(".")) return { ok: false, reason: `hostname ${hostname} is not a public DNS name` };
  }
  url.hash = "";
  return { ok: true, url, hostname, ipLiteral };
}

/**
 * True when an IP literal must not be connected to (private, loopback,
 * link-local, CGNAT, documentation, multicast, reserved, NAT64/mapped forms of
 * those). Unparseable input is treated as blocked (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return isBlockedV4(parseV4(bare)!);
  if (family === 6) {
    const words = parseV6(bare);
    return words ? isBlockedV6(words) : true;
  }
  return true;
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts;
}

const V4_BLOCKS: Array<[number, number, number, number, number]> = [
  [0, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24],
  [192, 0, 2, 0, 24],
  [192, 88, 99, 0, 24],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24],
  [203, 0, 113, 0, 24],
  [224, 0, 0, 0, 4],
  [240, 0, 0, 0, 4],
];

function v4ToInt(p: readonly number[]): number {
  return (((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!) >>> 0;
}

function isBlockedV4(p: readonly number[]): boolean {
  const value = v4ToInt(p);
  if (value === 0xffffffff) return true;
  return V4_BLOCKS.some(([a, b, c, d, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((v4ToInt([a, b, c, d]) & mask) >>> 0);
  });
}

/** Expand an IPv6 literal (optionally with trailing dotted IPv4) to 8 16-bit words. */
function parseV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    // Rewrite a trailing dotted IPv4 (::ffff:1.2.3.4) as two hex words.
    const v4 = parseV4(last);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toWords = (s: string) => (s === "" ? [] : s.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = toWords(halves[0]!);
  let words = head;
  if (halves.length === 2) {
    const rest = toWords(halves[1]!);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    words = [...head, ...new Array<number>(fill).fill(0), ...rest];
  }
  if (words.length !== 8 || words.some((w) => Number.isNaN(w))) return null;
  return words;
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isBlockedV6(w: readonly number[]): boolean {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [number, number, number, number, number, number, number, number];
  const first80Zero = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
  // ::ffff:a.b.c.d mapped and ::ffff:0:a.b.c.d translated: judge the embedded v4.
  if (first80Zero && w5 === 0xffff) return isBlockedV4(embeddedV4(w6, w7));
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0) return isBlockedV4(embeddedV4(w6, w7));
  // 64:ff9b::/96 NAT64 well-known prefix: judge the embedded v4.
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return isBlockedV4(embeddedV4(w6, w7));
  // 64:ff9b:1::/48 local-use NAT64.
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 1) return true;
  // ::/8 reserved: ::, ::1, deprecated IPv4-compatible ::a.b.c.d, and the rest.
  if ((w0 & 0xff00) === 0) return true;
  // 100::/64 discard-only.
  if (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) return true;
  // 2001::/32 Teredo (embedded v4 is obfuscated) and 2001:db8::/32 documentation.
  if (w0 === 0x2001 && (w1 === 0 || w1 === 0xdb8)) return true;
  // 2002::/16 6to4: judge the embedded v4.
  if (w0 === 0x2002) return isBlockedV4(embeddedV4(w1, w2));
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  if ((w0 & 0xfe00) === 0xfc00) return true;
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true;
  if ((w0 & 0xff00) === 0xff00) return true;
  return false;
}
