import { dirOf, joinWiki, normalizeWikiPath, PathError, resolveLink } from "./paths.js";

/** Editorial maximum, adapted from AEye's publication gate: split by subject, never by offset. */
export const MAX_PAGE_CHARACTERS = 9_000;
export const MAX_PAGE_BYTES = 64 * 1024;
export const MAX_FILES = 400;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  stats: { pages: number; directories: number; bytes: number };
}

const LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Extract relative wiki link targets from Markdown, ignoring fenced code and external URLs. */
export function extractLinks(markdown: string): string[] {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out: string[] = [];
  for (const match of withoutFences.matchAll(LINK_RE)) {
    let target = match[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    target = target.split("#")[0]!.split("?")[0]!;
    if (!target) continue;
    try {
      out.push(decodeURIComponent(target));
    } catch {
      // Malformed percent escapes are reported as broken links instead of crashing validation.
      out.push(target);
    }
  }
  return out;
}

/**
 * Structural validation of a complete knowledge tree (path -> Markdown).
 * This proves navigability and layout only; it says nothing about whether the
 * procedures described are correct (task success is judged by external evidence).
 */
export function validateWiki(files: ReadonlyMap<string, string>): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let bytes = 0;
  const pages = new Set<string>();

  for (const [rawPath, content] of files) {
    let p: string;
    try {
      p = normalizeWikiPath(rawPath);
    } catch (error) {
      errors.push({ path: rawPath, code: "invalid_path", message: (error as PathError).message });
      continue;
    }
    if (p !== rawPath) errors.push({ path: rawPath, code: "non_canonical_path", message: `Use canonical path ${p}` });
    pages.add(p);
    const size = Buffer.byteLength(content, "utf8");
    bytes += size;
    if (content.trim().length === 0) errors.push({ path: p, code: "empty_page", message: "Page is empty; delete it or give it one clear purpose" });
    if (size > MAX_PAGE_BYTES) errors.push({ path: p, code: "page_too_large", message: `Page exceeds ${MAX_PAGE_BYTES} bytes` });
    else if (content.length > MAX_PAGE_CHARACTERS) {
      errors.push({
        path: p,
        code: "page_too_long",
        message:
          `Page has ${content.length} characters (editorial max ${MAX_PAGE_CHARACTERS}). Split it semantically by subject, workflow, ` +
          `phase, or failure mode: promote it to a directory with index.md and focused child pages, and update the nearest parent index. ` +
          `Do not split at arbitrary offsets.`,
      });
    }
    if (!/^#\s+\S/m.test(content.split("\n").find((l) => l.trim() !== "") ?? "")) {
      warnings.push({ path: p, code: "missing_title", message: "Start the page with a '# Title' heading" });
    }
  }

  if (pages.size > MAX_FILES) errors.push({ path: "", code: "too_many_pages", message: `Tree has ${pages.size} pages (max ${MAX_FILES})` });
  if (bytes > MAX_TOTAL_BYTES) errors.push({ path: "", code: "tree_too_large", message: `Tree is ${bytes} bytes (max ${MAX_TOTAL_BYTES})` });
  if (!pages.has("index.md")) errors.push({ path: "index.md", code: "missing_root_index", message: "The wiki root needs index.md as its landing page" });

  // Directory structure: every directory needs index.md, and every child must be linked from it.
  const directories = new Set<string>([""]);
  for (const p of pages) {
    let d = dirOf(p);
    while (d !== "") {
      directories.add(d);
      d = dirOf(d);
    }
  }
  const children = new Map<string, Set<string>>();
  for (const d of directories) children.set(d, new Set());
  for (const p of pages) {
    const d = dirOf(p);
    if (!p.endsWith("/index.md") && p !== "index.md") children.get(d)!.add(p);
  }
  for (const d of directories) {
    if (d === "") continue;
    children.get(dirOf(d))!.add(joinWiki(d, "index.md"));
  }

  const linksFrom = new Map<string, Set<string>>();
  for (const p of pages) {
    const resolved = new Set<string>();
    for (const target of extractLinks(files.get(p) ?? "")) {
      let r = resolveLink(p, target);
      if (r === null) {
        errors.push({ path: p, code: "link_escapes_root", message: `Link "${target}" escapes the wiki root` });
        continue;
      }
      if (r === "" || directories.has(r)) r = joinWiki(r, "index.md");
      if (!pages.has(r)) {
        errors.push({ path: p, code: "broken_link", message: `Link "${target}" points to missing page ${r}` });
        continue;
      }
      resolved.add(r);
    }
    linksFrom.set(p, resolved);
  }

  for (const d of directories) {
    const index = joinWiki(d, "index.md");
    if (!pages.has(index)) {
      if (d !== "") errors.push({ path: index, code: "missing_index", message: `Directory ${d}/ needs index.md as its landing page linking each child` });
      continue;
    }
    const linked = linksFrom.get(index) ?? new Set();
    for (const child of children.get(d) ?? []) {
      if (!linked.has(child)) {
        errors.push({
          path: index,
          code: "unlinked_child",
          message: `${index} must link ${child} with a short description of when to read it (no orphan pages)`,
        });
      }
    }
    if (d !== "" && !linked.has(joinWiki(dirOf(d), "index.md"))) {
      warnings.push({ path: index, code: "missing_parent_link", message: `Add a link back to the parent index (../index.md)` });
    }
    const childCount = children.get(d)?.size ?? 0;
    if (d !== "" && childCount === 0) {
      warnings.push({ path: index, code: "empty_directory", message: `${d}/ has only an index; fold it back into a single page unless children are coming` });
    }
  }

  return {
    ok: errors.length === 0,
    errors: dedupe(errors),
    warnings: dedupe(warnings),
    stats: { pages: pages.size, directories: directories.size, bytes },
  };
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.path}|${i.code}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatReport(report: ValidationReport, max = 25): string {
  const lines = [`valid=${report.ok} pages=${report.stats.pages} dirs=${report.stats.directories} bytes=${report.stats.bytes}`];
  for (const e of report.errors.slice(0, max)) lines.push(`ERROR ${e.code} ${e.path}: ${e.message}`);
  if (report.errors.length > max) lines.push(`…${report.errors.length - max} more errors`);
  for (const w of report.warnings.slice(0, max)) lines.push(`warn ${w.code} ${w.path}: ${w.message}`);
  return lines.join("\n");
}
