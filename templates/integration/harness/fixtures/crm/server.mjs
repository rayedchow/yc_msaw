// SYNTHETIC CRM CONTRACT FIXTURE — server core (importable without side effects).
// createCrmFixture({vendor, seed, spec, token, adminToken}) -> {handle, state, canonical, listen}.
// Not a vendor integration certification: each vendor module emulates a narrow documented subset.
import http from "node:http";
import { generateDataset } from "./dataset.mjs";
import { Reply, TAG_OPTIONS, canonicalStageClass, createRng, isPlainObject, readBody, send } from "./common.mjs";
import { createHubspot } from "./hubspot.mjs";
import { createPipedrive } from "./pipedrive.mjs";
import { createZoho } from "./zoho.mjs";
import { createAttio } from "./attio.mjs";

export { TAG_OPTIONS, canonicalStageClass, generateDataset };

const VENDORS = { hubspot: createHubspot, pipedrive: createPipedrive, zoho: createZoho, attio: createAttio };
const CANONICAL_FIELDS = new Set(["nextStep", "tags", "stage", "derived", "other"]);

const TAG_NEEDLES = TAG_OPTIONS.flatMap((t) => [t, t.replace(/-/g, "_")]);
function hasSemicolonTag(v, depth = 0) {
  if (depth > 6) return false;
  if (typeof v === "string") return v.includes(";") && TAG_NEEDLES.some((t) => v.toLowerCase().includes(t));
  if (Array.isArray(v)) return v.some((x) => hasSemicolonTag(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).some((x) => hasSemicolonTag(x, depth + 1));
  return false;
}

// Best-effort tag for a request that recognisably applies ANOTHER vendor's convention.
export function detectForeignPattern(vendor, url, body) {
  const keys = [...url.searchParams.keys()];
  if (keys.includes("$filter")) return "odata.$filter";
  if (vendor !== "zoho" && keys.includes("criteria")) return "zoho.criteria";
  if (!isPlainObject(body)) return null;
  if (vendor !== "hubspot" && "filterGroups" in body) return "hubspot.filterGroups";
  if (vendor !== "hubspot" && isPlainObject(body.properties)) return "hubspot.properties-wrapper";
  if (vendor !== "pipedrive" && "custom_fields" in body) return "pipedrive.custom_fields";
  if (vendor !== "attio" && isPlainObject(body.data) && "values" in body.data) return "attio.data.values";
  if (vendor !== "zoho" && Array.isArray(body.data)) return "zoho.data-array";
  if (vendor !== "hubspot" && hasSemicolonTag(body)) return "semicolon-tags";
  return null;
}

export function createCrmFixture({ vendor, seed, spec, token, adminToken }) {
  const factory = VENDORS[vendor];
  if (!factory) throw new Error(`unknown vendor ${vendor}`);
  if (!token || !adminToken) throw new Error("token and adminToken required");
  const dataset = generateDataset(String(seed), spec);
  const reqRng = createRng(String(seed), `requests:${vendor}`);
  const log = { requests: [], mutations: [], created: [], deleted: [] };
  let seq = 0;
  let mutationSeq = 0;
  let currentSeq = 0;
  let currentRequestId = null;
  let mutationsThisRequest = 0;

  const ctx = {
    vendor,
    seed: String(seed),
    spec,
    dataset,
    token: String(token),
    get requestId() {
      return currentRequestId;
    },
    // Every applied field change on any record (incl. later-reverted writes). Values are vendor-native.
    mutate(recordType, key, nativeId, field, before, after, canonicalField) {
      if (!CANONICAL_FIELDS.has(canonicalField)) throw new Error(`bad canonicalField ${canonicalField}`);
      mutationsThisRequest++;
      log.mutations.push({
        seq: ++mutationSeq,
        requestSeq: currentSeq,
        recordType,
        key,
        nativeId,
        field,
        canonicalField,
        before: before === undefined ? null : structuredClone(before),
        after: after === undefined ? null : structuredClone(after),
      });
    },
    created(recordType, nativeId) {
      mutationsThisRequest++;
      log.created.push({ recordType, nativeId, requestSeq: currentSeq });
    },
    deleted(recordType, nativeId) {
      mutationsThisRequest++;
      log.deleted.push({ recordType, nativeId, requestSeq: currentSeq });
    },
  };
  const impl = factory(ctx);

  const canonical = () => impl.canonical();
  const state = () =>
    structuredClone({
      vendor,
      instanceLabel: spec.instanceLabel,
      canonical: canonical(),
      requests: log.requests,
      mutations: log.mutations,
      created: log.created,
      deleted: log.deleted,
    });

  async function handle(req, res) {
    const t0 = performance.now();
    let url;
    try {
      url = new URL(req.url ?? "/", "http://fixture.local");
    } catch {
      return send(res, 400, { error: "bad_url" });
    }
    if (url.pathname === "/__state") {
      if (req.method !== "GET" || req.headers["x-fixture-admin"] !== String(adminToken)) return send(res, 403, { error: "forbidden" });
      return send(res, 200, state());
    }
    currentSeq = ++seq;
    currentRequestId = reqRng.uuid();
    mutationsThisRequest = 0;
    const method = String(req.method ?? "GET").toUpperCase();
    let out;
    let body;
    let route = null;
    try {
      const { text, tooLarge } = await readBody(req);
      // Handlers are synchronous from here on, so ctx.requestId/currentSeq cannot interleave.
      currentSeq = seq === currentSeq ? currentSeq : currentSeq;
      out = (() => {
        try {
          if (tooLarge) return impl.tooLarge();
          let params = null;
          for (const r of impl.routes) {
            const m = r.re.exec(url.pathname);
            if (m) {
              route = r;
              params = m.slice(1).map((x) => (x === undefined ? x : decodeURIComponent(x)));
              break;
            }
          }
          if (!route) return impl.notFound(url.pathname);
          const fn = route[method];
          if (typeof fn !== "function") return impl.methodNotAllowed(method, url.pathname);
          const authErr = impl.authenticate(req, url);
          if (authErr) return authErr;
          if (text.trim() !== "") {
            try {
              body = JSON.parse(text);
            } catch {
              return impl.invalidJson(text);
            }
          }
          return fn({ params, query: url.searchParams, body, raw: text, req, method, url });
        } catch (e) {
          if (e instanceof Reply) return e;
          throw e;
        }
      })();
    } catch (e) {
      out = new Reply(500, { error: "fixture_error", message: String(e?.message ?? e) }, {}, "fixture_error");
    }
    if (!(out instanceof Reply)) out = new Reply(200, out);
    const headers = { "x-fixture-request-id": currentRequestId, ...(impl.extraHeaders?.(currentRequestId) ?? {}), ...out.headers };
    const readPost = route?.readPost?.(method) ?? false;
    const write = (method !== "GET" && method !== "HEAD" && !readPost) || mutationsThisRequest > 0;
    const errorCode = out.status >= 400 ? (out.errorCode ?? impl.errorCodeOf(out.body) ?? null) : null;
    let foreignPattern = null;
    try {
      foreignPattern = detectForeignPattern(vendor, url, body);
    } catch {
      foreignPattern = null;
    }
    const path = impl.redactPath ? impl.redactPath(url) : url.pathname + url.search;
    log.requests.push({
      seq: currentSeq,
      at: new Date().toISOString(),
      method,
      path,
      status: out.status,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      write,
      errorCode,
      foreignPattern,
      requestId: currentRequestId,
    });
    return send(res, out.status, out.body, headers);
  }

  // Serialise request handling so request seq/mutation attribution stays exact under concurrency.
  let chain = Promise.resolve();
  const serialHandle = (req, res) => {
    const p = chain.then(() => handle(req, res)).catch(() => {
      try {
        send(res, 500, { error: "fixture_error" });
      } catch {
        /* response already sent */
      }
    });
    chain = p;
    return p;
  };

  function listen(port = 0, host = "127.0.0.1") {
    const server = http.createServer(serialHandle);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(port) || 0, host, () => {
        const addr = server.address();
        resolve({
          port: typeof addr === "object" && addr ? addr.port : Number(port),
          close: () =>
            new Promise((r) => {
              server.closeAllConnections?.();
              server.close(() => r());
            }),
        });
      });
    });
  }

  return { handle: serialHandle, state, canonical, listen };
}
