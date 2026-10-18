/* Vendored from AEye web/components/workspace/draft-tree.tsx (askshepherd/aeye-shepherd @ a49aae10e219a7b3aa36102099b649340c2d42b0); verbatim apart from this note. */

import { Archive, File, FileText, Folder } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { workspaceFolderName } from "../../../src/build/workspace_display.js";
import type { HandbookTreeNode } from "../../../src/web/repository.js";
import { fileTypeIcon } from "../file-type-icon.js";
import { TreeRowName } from "../tree-row-name.js";

/**
 * The workspace file tree shared by the build trace's Files pane and the
 * Chat/Edit workspace panel. Folders stay as the reader left them: selecting
 * a file (by click, link or citation) only expands its ancestors and never
 * collapses another folder. A mounted ZIP expands like a folder, its members
 * loading page by page from the pinned source version.
 */

export interface DraftTreeProps {
  nodes: readonly HandbookTreeNode[];
  selected: string | null;
  onSelect(path: string): void;
  /**
   * The tree sits inside another page (the Chat/Edit workspace panel): a
   * selection leaves the page's address alone and roles are not labeled.
   */
  inPage?: boolean;
  /** The file API (`<base>/members?path=`) that lists a mounted ZIP's members. */
  membersBase?: string | null;
  /** Remembers expanded folders for this browser session (one key per conversation or run). */
  persistKey?: string | null;
  /** Organized display path of a mounted source (tooltip shows the mounted path). */
  displayPaths?: Readonly<Record<string, string>>;
}

function readExpanded(key: string | null | undefined): Set<string> {
  if (!key) return new Set();
  try {
    const value = JSON.parse(window.sessionStorage.getItem(`shepherd:tree:${key}`) ?? "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(key: string | null | undefined, expanded: ReadonlySet<string>): void {
  if (!key) return;
  try {
    window.sessionStorage.setItem(`shepherd:tree:${key}`, JSON.stringify([...expanded].slice(0, 2_000)));
  } catch {
    // Remembering folders is a convenience only.
  }
}

/** The folders (and ZIPs) that lead to a path, outermost first. */
export function treeAncestors(nodes: readonly HandbookTreeNode[], path: string): string[] {
  for (const node of nodes) {
    if (node.kind === "file") {
      if (node.archive && path.startsWith(`${node.path}!/`)) {
        const segments = path.slice(node.path.length + 2).split("/");
        return [node.path, ...segments.slice(0, -1).map((_segment, index) => `${node.path}!/${segments.slice(0, index + 1).join("/")}`)];
      }
      continue;
    }
    if (node.path === path) return [];
    const inner = treeAncestors(node.children, path);
    if (inner.length > 0 || containsFile(node.children, path)) return [node.path, ...inner];
  }
  return [];
}

function containsFile(nodes: readonly HandbookTreeNode[], path: string): boolean {
  return nodes.some((node) => node.kind === "file" ? node.path === path : containsFile(node.children, path));
}

/** Nested nodes from a ZIP's flat member page (`<zip>!/a/b.html`). */
export function archiveMemberNodes(
  archivePath: string,
  members: ReadonlyArray<{ path: string; kind: "directory" | "file" }>,
): HandbookTreeNode[] {
  const root: HandbookTreeNode = { kind: "directory", title: "", path: archivePath, children: [] };
  const directories = new Map<string, HandbookTreeNode>([["", root]]);
  const directory = (relative: string): HandbookTreeNode => {
    const existing = directories.get(relative);
    if (existing !== undefined) return existing;
    const at = relative.lastIndexOf("/");
    const parent = directory(at < 0 ? "" : relative.slice(0, at));
    const node: HandbookTreeNode = { kind: "directory", title: relative.slice(at + 1), path: `${archivePath}!/${relative}`, children: [] };
    parent.children.push(node);
    directories.set(relative, node);
    return node;
  };
  for (const member of members) {
    if (!member.path.startsWith(`${archivePath}!/`)) continue;
    const relative = member.path.slice(archivePath.length + 2).replace(/\/+$/u, "");
    if (!relative) continue;
    if (member.kind === "directory") {
      directory(relative);
      continue;
    }
    const at = relative.lastIndexOf("/");
    directory(at < 0 ? "" : relative.slice(0, at)).children.push({
      kind: "file",
      title: relative.slice(at + 1),
      path: member.path,
      children: [],
    });
  }
  const sort = (nodes: HandbookTreeNode[]): HandbookTreeNode[] => nodes
    .sort((left, right) => left.kind === right.kind ? left.title.localeCompare(right.title) : left.kind === "directory" ? -1 : 1)
    .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(root.children);
}

/**
 * The expanded folders after a file is selected: its ancestors are added and
 * nothing is ever removed, so moving between folders never collapses one.
 */
export function expandedForSelection(
  current: ReadonlySet<string>,
  nodes: readonly HandbookTreeNode[],
  selected: string | null,
  inPage: boolean,
): ReadonlySet<string> {
  if (selected === null) return current;
  const ancestors = treeAncestors(nodes, selected);
  // The trace names Knowledge pages without their `knowledge/` prefix.
  const fallback = ancestors.length === 0 && !inPage ? treeAncestors(nodes, `knowledge/${selected}`) : [];
  const wanted = [...ancestors, ...fallback].map((path) => inPage ? path : path.replace(/^knowledge\//u, ""));
  if (wanted.every((path) => current.has(path))) return current;
  return new Set([...current, ...wanted]);
}

interface TreeContext {
  selected: string | null;
  onSelect(path: string): void;
  inPage: boolean;
  membersBase: string | null;
  expanded: ReadonlySet<string>;
  setOpen(path: string, open: boolean): void;
  displayPaths: Readonly<Record<string, string>>;
}

function plainClick(event: React.MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** File selection changes one query field; it never drops the selected
 * agent, branch, panel or other surrounding workspace navigation. */
export function workspaceFileHref(currentHref: string, path: string): string {
  const url = new URL(currentHref);
  url.searchParams.set("file", path);
  return `${url.pathname}${url.search}${url.hash}`;
}

function FileRow({ node, context }: { node: HandbookTreeNode; context: TreeContext }) {
  const path = context.inPage ? node.path : node.path.replace(/^knowledge\//u, "");
  const display = context.displayPaths[node.path];
  // By the file's own name (a saved file's title may carry an identity suffix).
  const Icon = fileTypeIcon(node.path, node.workspaceRole === "working_artifact" ? File : FileText);
  return (
    <li className="docs-file">
      <a
        href={context.inPage ? `#workspace-file=${encodeURIComponent(path)}` : `?file=${encodeURIComponent(path)}`}
        aria-current={context.selected === path ? "page" : undefined}
        data-workspace-tree-file={context.inPage ? "" : undefined}
        onPointerEnter={(event) => { if (!context.inPage) event.currentTarget.href = workspaceFileHref(window.location.href, path); }}
        onFocus={(event) => { if (!context.inPage) event.currentTarget.href = workspaceFileHref(window.location.href, path); }}
        onContextMenu={(event) => { if (!context.inPage) event.currentTarget.href = workspaceFileHref(window.location.href, path); }}
        onAuxClick={(event) => { if (!context.inPage) event.currentTarget.href = workspaceFileHref(window.location.href, path); }}
        onClick={(event) => {
          const href = context.inPage ? null : workspaceFileHref(window.location.href, path);
          if (href !== null) event.currentTarget.href = href;
          if (!plainClick(event)) return;
          event.preventDefault();
          if (href !== null) window.history.replaceState(null, "", href);
          context.onSelect(path);
        }}
      >
        <Icon aria-hidden="true" size={14} strokeWidth={1.7} />
        {/* Saved evidence keeps its stable identity path out of sight; its folders already say where it came from. */}
        <TreeRowName label={display === undefined || node.path.startsWith("$SAVED/") ? undefined : node.path}>{node.title}</TreeRowName>
        {!context.inPage && node.workspaceRole === "working_artifact" ? <small>Artifact</small> : null}
      </a>
    </li>
  );
}

interface MemberPage {
  members: Array<{ path: string; kind: "directory" | "file" }>;
  page: { offset: number; limit: number; total: number } | null;
}

function ArchiveRow({ node, context }: { node: HandbookTreeNode; context: TreeContext }) {
  const open = context.expanded.has(node.path);
  const [loaded, setLoaded] = useState<MemberPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const selectedMember = context.selected?.startsWith(`${node.path}!/`) ? context.selected.slice(node.path.length + 2) : null;

  const load = useCallback(async (offset: number, member: string | null) => {
    if (!context.membersBase) return;
    setLoading(true);
    setFailed(false);
    try {
      const search = new URLSearchParams({ path: node.path, offset: String(offset) });
      if (member !== null) search.set("member", member);
      const response = await fetch(`${context.membersBase}/members?${search.toString()}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(String(response.status));
      setLoaded(await response.json() as MemberPage);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [context.membersBase, node.path]);

  // Opening the ZIP lists its members; a selected member opens its own page.
  useEffect(() => {
    if (!open || loading) return;
    if (loaded === null && !failed) { void load(0, selectedMember); return; }
    if (selectedMember !== null && loaded !== null && !loaded.members.some((member) => member.path === context.selected)) {
      void load(0, selectedMember);
    }
  }, [open, loaded, loading, failed, load, selectedMember, context.selected]);

  const children = useMemo(() => loaded === null ? [] : archiveMemberNodes(node.path, loaded.members), [loaded, node.path]);
  const detailsRef = React.useRef<HTMLDetailsElement>(null);
  // Members arrive after the selection: bring the selected member into view in the tree.
  useEffect(() => {
    if (loaded === null || selectedMember === null) return;
    const frame = requestAnimationFrame(() => {
      const row = detailsRef.current?.querySelector<HTMLElement>("a[aria-current=\"page\"]");
      const box = row?.closest<HTMLElement>(".build-ide-tree");
      if (!row || !box) return;
      const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      if (top < 0 || top > box.clientHeight - row.offsetHeight) box.scrollTop += top - box.clientHeight / 3;
    });
    return () => cancelAnimationFrame(frame);
  }, [loaded, selectedMember]);
  const page = loaded?.page ?? null;
  const display = context.displayPaths[node.path];
  return (
    <li className="docs-directory">
      <details ref={detailsRef} open={open} onToggle={(event) => context.setOpen(node.path, event.currentTarget.open)}>
        <summary
          aria-current={context.selected === node.path ? "page" : undefined}
          onClick={() => context.onSelect(node.path)}
        >
          <Archive aria-hidden="true" size={14} strokeWidth={1.7} />
          <TreeRowName label={display === undefined ? undefined : node.path}>{node.title}</TreeRowName>
        </summary>
        {open ? (
          loading && loaded === null ? (
            <div className="docs-tree-skeleton" aria-label="Loading files"><span /><span /><span /></div>
          ) : failed ? (
            <p className="docs-tree-empty">
              Couldn&apos;t load these files. <button type="button" className="docs-tree-retry" onClick={() => void load(page?.offset ?? 0, null)}>Retry</button>
            </p>
          ) : (
            <>
              {page !== null && page.total > page.limit ? (
                <div className="docs-tree-pager">
                  <span>{(page.offset + 1).toLocaleString()}–{Math.min(page.offset + page.limit, page.total).toLocaleString()} of {page.total.toLocaleString()}</span>
                  {page.offset > 0 ? <button type="button" onClick={() => void load(Math.max(0, page.offset - page.limit), null)}>Previous</button> : null}
                  {page.offset + page.limit < page.total ? <button type="button" onClick={() => void load(page.offset + page.limit, null)}>Next</button> : null}
                </div>
              ) : null}
              <TreeLevel nodes={children} context={context} />
            </>
          )
        ) : null}
      </details>
    </li>
  );
}

function TreeLevel({ nodes, context }: { nodes: readonly HandbookTreeNode[]; context: TreeContext }) {
  return (
    <ul>
      {nodes.map((node) => {
        if (node.kind === "file") {
          return node.archive && context.membersBase
            ? <ArchiveRow key={node.path} node={node} context={context} />
            : <FileRow key={node.path} node={node} context={context} />;
        }
        const path = context.inPage ? node.path : node.path.replace(/^knowledge\//u, "");
        // A mount reads as its folder name ("inputs"); the tooltip keeps the variable ("$INPUTS").
        const name = workspaceFolderName(node.title);
        return (
          <li key={node.path} className="docs-directory">
            <details open={context.expanded.has(path)} onToggle={(event) => context.setOpen(path, event.currentTarget.open)}>
              <summary>
                <Folder aria-hidden="true" size={14} strokeWidth={1.7} />
                <TreeRowName label={name === node.title ? undefined : node.title}>{name}</TreeRowName>
              </summary>
              {context.expanded.has(path) ? <TreeLevel nodes={node.children} context={context} /> : null}
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function DraftTreeNodes({
  nodes,
  selected,
  onSelect,
  inPage = false,
  membersBase = null,
  persistKey = null,
  displayPaths = {},
}: DraftTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // The remembered folders load after mount (session storage is browser-only).
  useEffect(() => {
    const remembered = readExpanded(persistKey);
    if (remembered.size > 0) setExpanded((current) => new Set([...current, ...remembered]));
  }, [persistKey]);

  // A selection expands what leads to it, and nothing else changes.
  useEffect(() => {
    setExpanded((current) => {
      const next = expandedForSelection(current, nodes, selected, inPage);
      if (next !== current) writeExpanded(persistKey, next);
      return next;
    });
  }, [inPage, nodes, persistKey, selected]);

  const setOpen = useCallback((path: string, open: boolean) => {
    setExpanded((current) => {
      if (current.has(path) === open) return current;
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      writeExpanded(persistKey, next);
      return next;
    });
  }, [persistKey]);

  const context: TreeContext = { selected, onSelect, inPage, membersBase, expanded, setOpen, displayPaths };
  return <TreeLevel nodes={nodes} context={context} />;
}
