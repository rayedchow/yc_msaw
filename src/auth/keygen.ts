/**
 * Generate a static procmem key for headless SDK ingest / CI.
 *
 *   npx tsx src/auth/keygen.ts --tenant <tenantNs> --scopes traces:write[+memory:read]
 *   npx tsx src/auth/keygen.ts --tenant-from-issuer https://x.authkit.app --org org_123 --scopes traces:write
 *
 * Prints the raw key ONCE (give it to the SDK as PROCMEM_API_KEY) and the
 * hashed `PROCMEM_STATIC_KEYS` entry for the server. The server never stores
 * the raw key.
 */
import { pathToFileURL } from "node:url";
import { parseScopeList, isScope, type Scope } from "./scopes.js";
import { generateStaticKey } from "./static-keys.js";
import { tenantNsFor } from "./tenant.js";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const issuer = arg(argv, "tenant-from-issuer");
  const org = arg(argv, "org");
  const sub = arg(argv, "sub");
  let tenant = arg(argv, "tenant");
  if (!tenant && issuer && (org || sub)) tenant = tenantNsFor(issuer, { organizationId: org, subject: sub ?? "" });
  const scopes = parseScopeList(arg(argv, "scopes") ?? "traces:write");
  if (!tenant) {
    console.error("usage: keygen --tenant <ns> | --tenant-from-issuer <iss> --org <org_id> [--scopes a+b]");
    process.exitCode = 2;
    return;
  }
  const bad = scopes.filter((s) => !isScope(s));
  if (bad.length) throw new Error(`unknown scopes: ${bad.join(", ")}`);
  const { key, entry } = generateStaticKey(tenant, scopes as Scope[]);
  console.log(`tenant:               ${tenant}`);
  console.log(`client key (secret):  ${key}`);
  console.log(`PROCMEM_STATIC_KEYS entry: ${entry}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
