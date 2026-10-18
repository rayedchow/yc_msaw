/** The domain packs walter knows. Each one becomes its own company MCP. */
import { erp } from "./erp/index.js";
import { mail } from "./mail/index.js";
import { sales } from "./sales/index.js";
import type { Domain } from "./types.js";

export const DOMAINS: Record<string, Domain> = { sales, erp, mail };

export function domainOf(id: string): Domain {
  const d = DOMAINS[id];
  if (!d) throw new Error(`unknown MCP "${id}" (known: ${Object.keys(DOMAINS).join(", ")})`);
  return d;
}
