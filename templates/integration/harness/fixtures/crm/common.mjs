// SYNTHETIC CRM CONTRACT FIXTURE — shared helpers (host-owned; Node 22 builtins only).
// Deterministic seeded PRNG (sha256 counter mode), canonical stage/tag tables, HTTP helpers.
import { createHash } from "node:crypto";

export const TAG_OPTIONS = ["budget-hold", "legal-review", "renewal", "at-risk", "exec-review", "closed-q4"];

// Canonical stage keys -> pipeline + class (vendor-neutral, host-only).
export const CANONICAL_STAGES = {
  qualify: { pipeline: "default", stageClass: "open" },
  propose: { pipeline: "default", stageClass: "open" },
  negotiate: { pipeline: "default", stageClass: "open" },
  discovery: { pipeline: "enterprise", stageClass: "open" },
  "security-review": { pipeline: "enterprise", stageClass: "open" },
  "won-default": { pipeline: "default", stageClass: "won" },
  "lost-default": { pipeline: "default", stageClass: "lost" },
  "won-enterprise": { pipeline: "enterprise", stageClass: "won" },
  "lost-enterprise": { pipeline: "enterprise", stageClass: "lost" },
};

export function canonicalStageClass(stage) {
  const s = CANONICAL_STAGES[stage];
  if (!s) throw new Error(`unknown canonical stage ${stage}`);
  return s.stageClass;
}

// Pick a canonical stage key for a native stage that maps to several canonical keys: prefer the deal's
// initial canonical stage, then a candidate in the same pipeline as the initial stage, then the first.
export function pickCanonicalStage(candidates, initialStage) {
  if (candidates.includes(initialStage)) return initialStage;
  const pipe = CANONICAL_STAGES[initialStage]?.pipeline;
  return candidates.find((c) => CANONICAL_STAGES[c]?.pipeline === pipe) ?? candidates[0] ?? null;
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function stableStringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}

export const hashOther = (fields) => sha256(stableStringify(fields));

// Seeded PRNG: sha256(seed \0 label \0 counter) blocks. Same seed+label -> same stream. No Math.random.
export function createRng(seed, label) {
  let counter = 0;
  let block = Buffer.alloc(0);
  let pos = 0;
  const bytes = (n) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      if (pos >= block.length) {
        block = createHash("sha256").update(`${seed}\u0000${label}\u0000${counter++}`).digest();
        pos = 0;
      }
      out[i] = block[pos++];
    }
    return out;
  };
  const rng = {
    bytes,
    float() {
      const b = bytes(7);
      // 53 random bits
      const hi = b.readUIntBE(0, 4) >>> 0;
      const lo = (b.readUIntBE(4, 3) >>> 3) & 0x1fffff;
      return (hi * 2 ** 21 + lo) / 2 ** 53;
    },
    int(min, max) {
      return min + Math.floor(rng.float() * (max - min + 1));
    },
    hex(n) {
      return bytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
    },
    digits(n) {
      let s = String(rng.int(1, 9));
      while (s.length < n) s += String(rng.int(0, 9));
      return s;
    },
    uuid() {
      const b = bytes(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.toString("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
    shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
  return rng;
}

// Deterministic timestamps: base 2026-09-01T10:00:00Z + createdOrder minutes.
export const BASE_TIME_MS = Date.UTC(2026, 8, 1, 10, 0, 0);
export const createdIso = (order) => new Date(BASE_TIME_MS + order * 60_000).toISOString().replace(".000Z", "Z");
// Close date for closed seed deals: 20 days after creation (date-only form available via .slice(0,10)).
export const seedCloseIso = (order) => new Date(BASE_TIME_MS + order * 60_000 + 20 * 86_400_000).toISOString().replace(".000Z", "Z");
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A response (returned or thrown by vendor handlers). body === undefined -> empty body.
export class Reply {
  constructor(status, body, headers = {}, errorCode = null) {
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.errorCode = errorCode;
  }
}
export const reply = (status, body, headers, errorCode) => new Reply(status, body, headers, errorCode);

// Opaque cursor (offset + a query fingerprint so a cursor cannot be replayed on another query).
export function encodeCursor(offset, fingerprint = "") {
  return Buffer.from(JSON.stringify({ o: offset, f: sha256(fingerprint).slice(0, 8) })).toString("base64url");
}
export function decodeCursor(cursor, fingerprint = "") {
  try {
    const v = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!Number.isInteger(v.o) || v.o < 0 || v.f !== sha256(fingerprint).slice(0, 8)) return null;
    return v.o;
  } catch {
    return null;
  }
}

export const BODY_CAP = 256 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_CAP) tooLarge = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), tooLarge }));
    req.on("error", reject);
  });
}

export function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, headers);
    return res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

// Parse a positive integer query param; returns default when absent, NaN when malformed.
export function intParam(q, name, dflt) {
  const raw = q.get(name);
  if (raw === null || raw === "") return dflt;
  return /^-?\d+$/.test(raw) ? Number(raw) : NaN;
}

export const uniq = (arr) => [...new Set(arr)];
