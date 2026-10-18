/**
 * A domain pack: everything walter needs to know about one kind of system to mine it, compile an MCP for it and
 * check that MCP against history. The pipeline itself (miner, backtests, compiler, deploy, evals, UI) is generic.
 *
 *   runtime.ts         fetchData + makeCtx; also shipped inside the compiled MCP, so rules see the same ctx live
 *   tools.fragment.ts  the MCP tools for this domain (spliced into compile/server.template.ts)
 *   index.ts           the Domain object below
 */
import type { Decision, SystemClient } from "../mine/data.js";
import type { Mcp } from "../mcp-client.js";

export interface KindSpec {
  description: string;
  signature: string;
  returns: string;
  /** what one decision is, for people ("deal-months", "bills") */
  unit: string;
  /** "set": rules have roles; an item is in if any include rule fires and no exclude rule does */
  combine?: "set";
  /** how to score a rule on one decision; default fn(...decision.args, ctx) */
  apply?: (fn: (...a: any[]) => any, d: Decision, ctx: any) => unknown;
}

export interface ToolMeta { name: string; sig: string; d: string; kinds: string[]; task?: string }
export interface AggregateRow { month: string; label: string; recorded: number; got: number; recordedIds: number; gotIds: number; match: boolean }
export interface ReplayCase { tool: string; month: string; heldOut: boolean; label: string; expected: unknown; got: unknown; ok: boolean }

export interface Domain<D = any> {
  id: string;
  /** MCP name in the UI */
  name: string;
  /** what the system is, for the miner and the MCP description */
  title: string;
  description: string;
  systems: string[];
  integrations: [file: string, label: string, detail: string, secret: string][];
  /** integrations/*.md shown in the tree */
  mdFile: string;
  kinds: Record<string, KindSpec>;
  fetchData(c: SystemClient): Promise<D>;
  makeCtx(d: D): any;
  ctxHelp: string;
  decisions(d: D, ctx: any): Decision[];
  describe(d: D, c: SystemClient): Promise<unknown>;
  /** exact replays of a recorded aggregate (commit, payment runs) from set + value rules */
  aggregate?: { setKind: string; valueKind: string; run(b: { data: D; ctx: any }, rules: { kind: string; role?: string; code: string }[]): AggregateRow[] };
  tools: ToolMeta[];
  replay(mcp: Mcp, d: D): Promise<ReplayCase[]>;
  /** absolute path of this domain's folder */
  dir: string;
}
