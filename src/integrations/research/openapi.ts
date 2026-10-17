import { IntegrationError } from "../types.js";
import { errorMessage } from "../../util.js";

/**
 * Structural summary of an OpenAPI 3.0/3.1 or Swagger 2.0 JSON document. This
 * reads documented structure only; it does not infer anything from prose.
 * Only local parameter / requestBody $refs are resolved; any other $ref is
 * reported as-is (ref) rather than guessed.
 */

export type OpenApiSpecVersion = `openapi-${string}` | "swagger-2.0";

export interface OpenApiParameterSummary {
  name: string | null;
  in: string | null;
  required: boolean;
  schemaType: string | null;
  /** Present when the parameter is a $ref that was not resolvable locally. */
  ref?: string;
}

export interface OpenApiOperationSummary {
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  parameters: OpenApiParameterSummary[];
  requestBodyContentTypes: string[];
  responses: string[];
  /** Effective security requirements (operation override, else global). */
  security: Array<Record<string, string[]>>;
  securitySource: "operation" | "global" | "none";
}

export interface OpenApiSecuritySchemeSummary {
  name: string;
  type: string | null;
  in?: string;
  /** apiKey header/query/cookie parameter name. */
  parameterName?: string;
  scheme?: string;
  bearerFormat?: string;
  openIdConnectUrl?: string;
  flows?: Record<string, { authorizationUrl?: string; tokenUrl?: string; refreshUrl?: string; scopes: string[] }>;
}

export interface OpenApiSummary {
  specVersion: OpenApiSpecVersion;
  title: string | null;
  version: string | null;
  servers: string[];
  securitySchemes: OpenApiSecuritySchemeSummary[];
  operations: OpenApiOperationSummary[];
  /** Operations matching the filter (before limit). */
  operationCount: number;
  /** Operations in the document (before filter). */
  totalOperations: number;
  truncated: boolean;
}

export interface SummarizeOpenApiOptions {
  /** Case-insensitive substring over method, path, operationId, summary, tags. */
  filter?: string;
  /** Max operations returned (default 200, max 1000). */
  limit?: number;
}

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Parse a fetched spec body. JSON only: YAML (or anything not starting with
 * "{") fails with "unsupported_format" so the agent can look for a JSON
 * variant; there is no YAML parser and no best-effort conversion.
 */
export function parseOpenApiText(text: string, contentType?: string | null): unknown {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (!trimmed.startsWith("{")) {
    throw new IntegrationError(
      "unsupported_format",
      `Spec is not JSON${contentType ? ` (content-type ${contentType})` : ""}; YAML is not supported. Look for a JSON variant of the same spec (often openapi.json / swagger.json or ?format=json).`,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new IntegrationError("invalid_json", `Spec body is not valid JSON: ${errorMessage(error)}`);
  }
}

export function summarizeOpenApi(doc: unknown, opts: SummarizeOpenApiOptions = {}): OpenApiSummary {
  if (!isObj(doc)) throw new IntegrationError("not_openapi", "Document is not a JSON object");
  const openapi = str(doc.openapi);
  const swagger = str(doc.swagger);
  let specVersion: OpenApiSpecVersion;
  if (openapi && /^3\.[01](\.|$)/.test(openapi)) specVersion = `openapi-${openapi}`;
  else if (swagger === "2.0") specVersion = "swagger-2.0";
  else throw new IntegrationError("not_openapi", `Document has no supported "openapi" (3.0/3.1) or "swagger" ("2.0") version field`);
  const isSwagger = specVersion === "swagger-2.0";

  const info = isObj(doc.info) ? doc.info : {};
  const components = isObj(doc.components) ? doc.components : {};
  const paramDefs = isSwagger ? (isObj(doc.parameters) ? doc.parameters : {}) : isObj(components.parameters) ? components.parameters : {};
  const bodyDefs = isObj(components.requestBodies) ? components.requestBodies : {};
  const paramPrefix = isSwagger ? "#/parameters/" : "#/components/parameters/";

  const resolveParam = (p: unknown): Obj | { $unresolved: string } | null => {
    if (!isObj(p)) return null;
    const ref = str(p.$ref);
    if (ref === null) return p;
    if (ref.startsWith(paramPrefix)) {
      const target = paramDefs[decodePointer(ref.slice(paramPrefix.length))];
      if (isObj(target) && str(target.$ref) === null) return target;
    }
    return { $unresolved: ref };
  };

  const summarizeParam = (p: Obj | { $unresolved: string }): OpenApiParameterSummary => {
    if ("$unresolved" in p) return { name: null, in: null, required: false, schemaType: null, ref: String(p.$unresolved) };
    const schema = isObj(p.schema) ? p.schema : null;
    return {
      name: str(p.name),
      in: str(p.in),
      required: p.required === true,
      schemaType: schemaType(isSwagger && p.in !== "body" ? p : schema),
    };
  };

  const globalSecurity = securityList(doc.security);
  const paths = isObj(doc.paths) ? doc.paths : {};
  const all: OpenApiOperationSummary[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const merged = new Map<string, OpenApiParameterSummary>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const resolved = resolveParam(raw);
        if (!resolved) continue;
        const s = summarizeParam(resolved);
        merged.set(s.ref ?? `${s.in}:${s.name}`, s);
      }
      const parameters = [...merged.values()];
      let requestBodyContentTypes: string[] = [];
      if (isSwagger) {
        if (parameters.some((p) => p.in === "body" || p.in === "formData")) requestBodyContentTypes = strings(op.consumes ?? doc.consumes);
      } else {
        let body = op.requestBody;
        const ref = isObj(body) ? str(body.$ref) : null;
        if (ref?.startsWith("#/components/requestBodies/")) body = bodyDefs[decodePointer(ref.slice("#/components/requestBodies/".length))];
        if (isObj(body) && isObj(body.content)) requestBodyContentTypes = Object.keys(body.content);
      }
      const opSecurity = op.security === undefined ? null : securityList(op.security);
      all.push({
        method: method.toUpperCase(),
        path,
        operationId: str(op.operationId),
        summary: str(op.summary),
        tags: strings(op.tags),
        deprecated: op.deprecated === true,
        parameters,
        requestBodyContentTypes,
        responses: isObj(op.responses) ? Object.keys(op.responses) : [],
        security: opSecurity ?? globalSecurity ?? [],
        securitySource: opSecurity ? "operation" : globalSecurity ? "global" : "none",
      });
    }
  }

  const needle = opts.filter?.trim().toLowerCase();
  const matching = needle
    ? all.filter((o) => [o.method, o.path, o.operationId ?? "", o.summary ?? "", ...o.tags].some((f) => f.toLowerCase().includes(needle)))
    : all;
  const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));

  return {
    specVersion,
    title: str(info.title),
    version: str(info.version),
    servers: servers(doc, isSwagger),
    securitySchemes: securitySchemes(isSwagger ? doc.securityDefinitions : components.securitySchemes, isSwagger),
    operations: matching.slice(0, limit),
    operationCount: matching.length,
    totalOperations: all.length,
    truncated: matching.length > limit,
  };
}

function decodePointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function schemaType(schema: Obj | null): string | null {
  if (!schema) return null;
  const ref = str(schema.$ref);
  if (ref) return `ref:${ref}`;
  const t = schema.type;
  if (typeof t === "string") {
    if (t === "array" && isObj(schema.items)) {
      const inner = schemaType(schema.items);
      return inner ? `array<${inner}>` : "array";
    }
    return t;
  }
  if (Array.isArray(t)) return strings(t).join("|") || null;
  for (const k of ["oneOf", "anyOf", "allOf"] as const) if (Array.isArray(schema[k])) return k;
  return null;
}

function securityList(v: unknown): Array<Record<string, string[]>> | null {
  if (!Array.isArray(v)) return null;
  return v.filter(isObj).map((req) => Object.fromEntries(Object.entries(req).map(([k, scopes]) => [k, strings(scopes)])));
}

function servers(doc: Obj, isSwagger: boolean): string[] {
  if (!isSwagger) return Array.isArray(doc.servers) ? doc.servers.filter(isObj).map((s) => str(s.url)).filter((u): u is string => u !== null) : [];
  const host = str(doc.host);
  const basePath = str(doc.basePath) ?? "";
  if (!host) return basePath ? [basePath] : [];
  const schemes = strings(doc.schemes);
  return (schemes.length ? schemes : ["https"]).map((s) => `${s}://${host}${basePath}`);
}

function securitySchemes(defs: unknown, isSwagger: boolean): OpenApiSecuritySchemeSummary[] {
  if (!isObj(defs)) return [];
  const out: OpenApiSecuritySchemeSummary[] = [];
  for (const [name, def] of Object.entries(defs)) {
    if (!isObj(def)) continue;
    const s: OpenApiSecuritySchemeSummary = { name, type: str(def.type) };
    if (str(def.in)) s.in = str(def.in)!;
    if (s.type === "apiKey" && str(def.name)) s.parameterName = str(def.name)!;
    if (str(def.scheme)) s.scheme = str(def.scheme)!;
    if (str(def.bearerFormat)) s.bearerFormat = str(def.bearerFormat)!;
    if (str(def.openIdConnectUrl)) s.openIdConnectUrl = str(def.openIdConnectUrl)!;
    if (isSwagger && s.type === "oauth2") {
      s.flows = {
        [str(def.flow) ?? "unknown"]: flow(def),
      };
    } else if (isObj(def.flows)) {
      s.flows = Object.fromEntries(Object.entries(def.flows).filter(([, f]) => isObj(f)).map(([k, f]) => [k, flow(f as Obj)]));
    }
    out.push(s);
  }
  return out;
}

function flow(f: Obj): { authorizationUrl?: string; tokenUrl?: string; refreshUrl?: string; scopes: string[] } {
  const out: { authorizationUrl?: string; tokenUrl?: string; refreshUrl?: string; scopes: string[] } = {
    scopes: isObj(f.scopes) ? Object.keys(f.scopes) : [],
  };
  if (str(f.authorizationUrl)) out.authorizationUrl = str(f.authorizationUrl)!;
  if (str(f.tokenUrl)) out.tokenUrl = str(f.tokenUrl)!;
  if (str(f.refreshUrl)) out.refreshUrl = str(f.refreshUrl)!;
  return out;
}
