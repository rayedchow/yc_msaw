import { createHash } from "node:crypto";

/** Stable content hash for mirror files (change detection + dedupe). */
export function wikiContentSha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
