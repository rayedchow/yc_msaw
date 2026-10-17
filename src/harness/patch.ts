import { canonicalJson, sha256 } from "../util.js";
import { scopeAllows, type WriteScope } from "./scope.js";

/**
 * Knowledge patch proposed by a completed child: the exact diff of its
 * knowledge/ branch against the base it was spawned with. Accepting it is an
 * exact-base merge: every touched path's CURRENT parent bytes must equal the
 * child's base bytes (absent = absent), otherwise nothing is applied.
 */
export interface PatchChange {
  path: string;
  op: "add" | "modify" | "delete";
  /** sha256 of the base bytes, null when the path did not exist at spawn. */
  baseSha256: string | null;
  /** Proposed content, null for delete. */
  content: string | null;
  newSha256: string | null;
}

export interface KnowledgePatch {
  /** sha256 over the canonical base manifest the child branched from. */
  baseManifestSha256: string;
  changes: PatchChange[];
  /** Declared renames whose source was deleted and target added by this patch. */
  moves: Array<{ from: string; to: string }>;
  /** sha256 over canonical {base, changes(path, op, baseSha256, newSha256), moves}. */
  sha256: string;
}

export interface PatchConflict {
  path: string;
  expectedBaseSha256: string | null;
  actualSha256: string | null;
}

export function manifestSha256(files: ReadonlyMap<string, string>): string {
  const entries = [...files.entries()].map(([p, c]) => [p, sha256(c)]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  return sha256(canonicalJson(entries));
}

export class PatchScopeError extends Error {
  readonly code = "scope_violation";
  constructor(readonly paths: string[]) {
    super(`Branch changed paths outside its knowledgeWriteScope: ${paths.slice(0, 20).join(", ")}`);
  }
}

export function computePatch(base: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>, scope: WriteScope, declaredMoves: ReadonlyArray<{ from: string; to: string }>): KnowledgePatch {
  const changes: PatchChange[] = [];
  const outOfScope: string[] = [];
  const paths = [...new Set([...base.keys(), ...current.keys()])].sort();
  for (const p of paths) {
    const before = base.get(p);
    const after = current.get(p);
    if (before === after) continue;
    if (!scopeAllows(scope, p)) {
      outOfScope.push(p);
      continue;
    }
    changes.push({
      path: p,
      op: before === undefined ? "add" : after === undefined ? "delete" : "modify",
      baseSha256: before === undefined ? null : sha256(before),
      content: after ?? null,
      newSha256: after === undefined ? null : sha256(after),
    });
  }
  if (outOfScope.length) throw new PatchScopeError(outOfScope);
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const moves = declaredMoves.filter((m) => byPath.get(m.from)?.op === "delete" && byPath.get(m.to)?.op === "add");
  const baseManifest = manifestSha256(base);
  const digest = sha256(canonicalJson({ base: baseManifest, changes: changes.map(({ content: _c, ...rest }) => rest), moves }));
  return { baseManifestSha256: baseManifest, changes, moves, sha256: digest };
}

/** Exact-base preflight against the parent's current draft. Empty array = safe to apply. */
export function findConflicts(parentCurrent: ReadonlyMap<string, string>, patch: KnowledgePatch): PatchConflict[] {
  const out: PatchConflict[] = [];
  for (const c of patch.changes) {
    const cur = parentCurrent.get(c.path);
    const actual = cur === undefined ? null : sha256(cur);
    if (actual !== c.baseSha256) out.push({ path: c.path, expectedBaseSha256: c.baseSha256, actualSha256: actual });
  }
  return out;
}

/** Compact line diff (LCS) with explicit truncation; for parent review only, never applied. */
export function lineDiff(before: string | undefined, after: string | undefined, maxLines = 200): { diff: string; truncated: boolean } {
  const a = before === undefined ? [] : before.split("\n");
  const b = after === undefined ? [] : after.split("\n");
  const out: string[] = [];
  if (a.length * b.length > 4_000_000) {
    out.push(`(file too large for line diff: ${a.length} -> ${b.length} lines; use read_agent_result with path)`);
    return { diff: out.join("\n"), truncated: true };
  }
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let truncated = false;
  const push = (line: string) => {
    if (out.length >= maxLines) truncated = true;
    else out.push(line);
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      push(`+${j + 1}: ${b[j]}`);
      j++;
    } else {
      push(`-${i + 1}: ${a[i]}`);
      i++;
    }
  }
  if (truncated) out.push(`…[diff truncated at ${maxLines} lines]`);
  return { diff: out.join("\n"), truncated };
}
