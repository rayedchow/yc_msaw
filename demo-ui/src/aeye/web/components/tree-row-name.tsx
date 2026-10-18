/*
 * Port of AEye web/components/tree-row-name.tsx (askshepherd/aeye-shepherd @ a49aae10e219a7b3aa36102099b649340c2d42b0).
 * Same row: one line, cut with an ellipsis. AEye shows a cut name (or one whose label differs) in its Radix tooltip
 * through a shared controller; this page has no tooltip library, so the same rule sets the native title instead.
 */
import React, { useRef } from "react";

/** Whether a row's name needs the tooltip: its text is cut, or its label differs from it. */
export function treeRowNameNeedsTooltip(
  element: Pick<HTMLElement, "scrollWidth" | "clientWidth">,
  text: string,
  full: string,
): boolean {
  return full !== text || element.scrollWidth > element.clientWidth;
}

export function TreeRowName({ children, label }: { children: string; label?: string | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const full = label ?? children;
  return (
    <span
      ref={ref}
      className="tree-row-name"
      onPointerEnter={() => {
        const element = ref.current;
        if (element === null) return;
        if (treeRowNameNeedsTooltip(element, children, full)) element.title = full;
        else element.removeAttribute("title");
      }}
    >
      {children}
    </span>
  );
}
