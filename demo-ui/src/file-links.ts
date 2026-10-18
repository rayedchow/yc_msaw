/*
 * Links inside a recorded Markdown file, as the Files viewer follows them.
 * A relative link resolves against the selected file's folder ("../", "./",
 * percent-encoding, a trailing #anchor or ?query are handled) and opens the
 * recorded file it names in the same viewer. Nothing is fetched: a target
 * that was not recorded is reported as missing, never invented. Links with
 * a scheme (https:, mailto:) stay ordinary links; in-page anchors stay put.
 */

export type RecordedLink =
  | { kind: "file"; path: string }
  | { kind: "missing"; path: string }
  | { kind: "external" }
  | { kind: "anchor" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

/** The recorded path a link in `fromPath` names (`recorded`: every recorded path). */
export function resolveRecordedLink(fromPath: string, href: string, recorded: ReadonlySet<string>): RecordedLink {
  const raw = href.trim();
  if (raw === "" || raw.startsWith("#")) return { kind: "anchor" };
  if (SCHEME.test(raw) || raw.startsWith("//")) return { kind: "external" };
  const target = raw.replace(/[?#].*$/su, "");
  if (target === "") return { kind: "anchor" };
  // "/x" names x from the recorded root; anything else is relative to the file's own folder.
  const base = target.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const parts = [...base];
  let escaped = false;
  for (const segment of target.split("/")) {
    const part = decode(segment);
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) escaped = true;
      else parts.pop();
      continue;
    }
    parts.push(part);
  }
  const path = parts.join("/");
  if (!escaped && recorded.has(path)) return { kind: "file", path };
  // A folder link opens its recorded index page, when there is one.
  if (!escaped && recorded.has(`${path}/index.md`)) return { kind: "file", path: `${path}/index.md` };
  return { kind: "missing", path: escaped ? target : path };
}
