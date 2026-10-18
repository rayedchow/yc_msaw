/**
 * Evals: replay past work through the deployed MCP and compare with what people actually did (history is the
 * answer key). Each domain pack decides which recorded work its tools replay (domain.replay); this sums it up.
 */
import type { ReplayCase } from "../domains/types.js";
export type { ReplayCase };

export function summarizeReplays(cases: ReplayCase[]) {
  const by = new Map<string, { tool: string; n: number; ok: number; learned: { n: number; ok: number }; heldOut: { n: number; ok: number } }>();
  for (const c of cases) {
    const s = by.get(c.tool) ?? { tool: c.tool, n: 0, ok: 0, learned: { n: 0, ok: 0 }, heldOut: { n: 0, ok: 0 } };
    s.n++; if (c.ok) s.ok++;
    const b = c.heldOut ? s.heldOut : s.learned;
    b.n++; if (c.ok) b.ok++;
    by.set(c.tool, s);
  }
  return [...by.values()];
}
