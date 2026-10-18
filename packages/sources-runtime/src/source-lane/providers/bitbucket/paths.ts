import { createHash } from "node:crypto";
import { encodeSegment } from "../../export/mapping.js";

/**
 * sources/ layout of the Bitbucket repository content lane, next to the donor
 * projections of the same repository (sources/bitbucket/<ws>/<repo>/{repo.md, pr-N.md,
 * issue-N.md}, src/mirror/materializer.ts):
 *
 *   sources/bitbucket/<ws>/<repo>/code/_repo.json                    repository metadata + raw Bitbucket payload
 *   sources/bitbucket/<ws>/<repo>/code/<ref>/_head.json              confirmed HEAD: commit, generation, mode, omissions
 *   sources/bitbucket/<ws>/<repo>/code/<ref>/_snapshots/g<gen>.json  immutable record per committed scan
 *   sources/bitbucket/<ws>/<repo>/code/<ref>/files/<path>            exact file bytes at that commit
 *   sources/bitbucket/<ws>/<repo>/code/<ref>/_overflow/<hash>        files whose path cannot be a sources/ path
 *
 * <ws>/<repo> is the donor's directory for the CURRENT full name (a rename re-exports at
 * the new path); <ref> is the branch name as one segment. Repository path segments are kept
 * as-is except bytes the sources/ grammar forbids, so the mapping is injective and a
 * repository is greppable under files/.
 */

export const PROVIDER = "bitbucket";
const ROOT = `sources/${PROVIDER}`;
const PREFIX_SEGMENTS = 7; // sources/bitbucket/<ws>/<repo>/code/<ref>/files
const MAX_SEGMENTS = 64;
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;

/**
 * The donor materializer's repository directory (`gitProviderRepoDirectory(BITBUCKET_SOURCE_ROOT, fullName)`,
 * a private helper of the frozen src/mirror/materializer.ts, reproduced exactly and pinned by
 * tests/source-lane/providers/bitbucket/module.test.ts against the donor's own repo.md path).
 */
export function repoSourceDirectory(repoFullName: string): string {
  const segments = repoFullName.split("/").filter((segment) => segment.trim().length > 0);
  const safe = segments.length > 0 ? segments.map((segment) => donorPathSegment(segment, "unknown")) : ["unknown-repo"];
  return `${ROOT}/${safe.join("/")}`;
}

function donorPathSegment(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || fallback
  );
}

export function repoCodeDir(fullName: string): string {
  return `${repoSourceDirectory(fullName)}/code`;
}

export function refDir(fullName: string, ref: string): string {
  return `${repoCodeDir(fullName)}/${encodeSegment(ref)}`;
}

export function repoFilePath(fullName: string): string {
  return `${repoCodeDir(fullName)}/_repo.json`;
}

export function headFilePath(fullName: string, ref: string): string {
  return `${refDir(fullName, ref)}/_head.json`;
}

export function snapshotFilePath(fullName: string, ref: string, generation: number): string {
  return `${refDir(fullName, ref)}/_snapshots/g${String(generation).padStart(8, "0")}.json`;
}

/** One repository path segment as a sources/ segment (identity for ordinary names). */
export function encodeRepoSegment(seg: string): string {
  let out = "";
  for (const ch of seg) {
    const cp = ch.codePointAt(0)!;
    if (ch === "%" || ch === "\\" || cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      out += [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    } else {
      out += ch;
    }
  }
  if (out === "." || out === "..") out = out.replace(/\./gu, "%2E");
  if (out === "") out = "%00empty";
  if (Buffer.byteLength(out, "utf8") > MAX_SEGMENT_BYTES) {
    let head = "";
    for (const ch of out) {
      if (Buffer.byteLength(head + ch, "utf8") > 180) break;
      head += ch;
    }
    out = `${head}~${createHash("sha256").update(seg).digest("hex").slice(0, 24)}`;
  }
  return out;
}

/** Exported path of a repository file, or the overflow path when it cannot fit the sources/ grammar. */
export function contentFilePath(fullName: string, ref: string, repoPath: string): string {
  const base = refDir(fullName, ref);
  const segs = repoPath.split("/");
  const encoded = segs.map(encodeRepoSegment);
  const candidate = `${base}/files/${encoded.join("/")}`;
  const ok = segs.every((s) => s.length > 0) && PREFIX_SEGMENTS + encoded.length <= MAX_SEGMENTS && Buffer.byteLength(candidate, "utf8") <= MAX_PATH_BYTES;
  if (ok) return candidate;
  return `${base}/_overflow/${createHash("sha256").update(repoPath).digest("hex").slice(0, 40)}`;
}

const BINARY_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  jar: "application/java-archive",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Content type of exact file bytes: text stays greppable text/*, everything else is binary. */
export function contentTypeFor(repoPath: string, isText: boolean): string {
  const name = repoPath.split("/").at(-1) ?? "";
  const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  if (isText) return ext === "md" || ext === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
  return BINARY_TYPES[ext] ?? "application/octet-stream";
}
