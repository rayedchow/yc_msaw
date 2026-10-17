/**
 * What an `edit` or `write` call changed, read from the call's own recorded
 * input and result (pure, no React). The activity row shows it as a removed
 * and added diff instead of the raw JSON:
 *
 * - `edit` replaces exact `oldText` with `newText` in one `$WORK` file. Both
 *   texts are the call's input, so the removed and added lines are exact;
 *   the rest of the file is not part of the call and is never invented.
 * - `write` replaces a whole file with `content`. Its previous contents are
 *   not part of the call or its receipt, so only the written lines show.
 *
 * A call is shown as applied only when its result recorded success; a
 * running, failed, cancelled or unfinished call says so. A clipped input
 * preview (Chat and Edit keep bounded previews) is decoded as far as it goes
 * and marked incomplete; it is never shown as the whole change.
 */

import { diffLines, type LineDiff } from "../../../src/web/text_diff.js";
import type { ActivityToolStatus } from "./activity-model.js";

export type EditCallField<T> = { value: T; complete: true } | { value: T; complete: false };

export interface ParsedEditCall {
  kind: "edit";
  path: string | null;
  oldText: EditCallField<string> | null;
  newText: EditCallField<string> | null;
  replaceAll: boolean;
}

export interface ParsedWriteCall {
  kind: "write";
  path: string | null;
  content: EditCallField<string> | null;
}

export type ParsedFileChangeCall = ParsedEditCall | ParsedWriteCall;

/** The facts a call's result recorded (its receipt), when they can be read. */
export interface FileChangeReceipt {
  status: string | null;
  replacements: number | null;
  matches: number | null;
  byteLength: number | null;
  contentSha256: string | null;
  oldTextSha256: string | null;
  newTextSha256: string | null;
  error: string | null;
  message: string | null;
}

/** The tools whose calls change one file's text. */
export function isFileChangeTool(toolName: string): toolName is "edit" | "write" {
  return toolName === "edit" || toolName === "write";
}

/**
 * Reads the string, boolean and number members of one JSON object, also
 * from a prefix of it (a clipped preview): each value says whether its text
 * ended inside the input. Nested values are skipped. Returns null when the
 * text does not start as an object.
 */
export function readJsonObjectPrefix(text: string): Map<string, { value: string | boolean | number | null; complete: boolean }> | null {
  let at = 0;
  const length = text.length;
  const space = () => { while (at < length && /\s/u.test(text[at]!)) at += 1; };
  space();
  if (text[at] !== "{") return null;
  at += 1;
  const fields = new Map<string, { value: string | boolean | number | null; complete: boolean }>();
  const readString = (): { value: string; complete: boolean } => {
    // at points at the opening quote.
    at += 1;
    let out = "";
    while (at < length) {
      const character = text[at]!;
      if (character === "\"") {
        at += 1;
        return { value: out, complete: true };
      }
      if (character !== "\\") {
        out += character;
        at += 1;
        continue;
      }
      const escape = text[at + 1];
      if (escape === undefined) break;
      if (escape === "u") {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) break;
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 6;
        continue;
      }
      const simple: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      const decoded = simple[escape];
      if (decoded === undefined) break;
      out += decoded;
      at += 2;
    }
    at = length;
    return { value: out, complete: false };
  };
  const skipNested = (): boolean => {
    let depth = 0;
    while (at < length) {
      const character = text[at]!;
      if (character === "\"") {
        if (!readString().complete) return false;
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      if (character === "}" || character === "]") {
        depth -= 1;
        at += 1;
        if (depth === 0) return true;
        continue;
      }
      at += 1;
    }
    return false;
  };
  while (at < length) {
    space();
    if (text[at] === "}") return fields;
    if (text[at] === ",") { at += 1; continue; }
    if (text[at] !== "\"") return fields;
    const key = readString();
    if (!key.complete) return fields;
    space();
    if (text[at] !== ":") return fields;
    at += 1;
    space();
    const first = text[at];
    if (first === undefined) return fields;
    if (first === "\"") {
      const value = readString();
      fields.set(key.value, value);
      if (!value.complete) return fields;
    } else if (first === "{" || first === "[") {
      if (!skipNested()) return fields;
    } else {
      const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(at, at + 40));
      if (literal === null) return fields;
      at += literal[0].length;
      // A literal at the very end of a prefix may continue past it.
      const complete = at < length;
      const raw = literal[0];
      fields.set(key.value, { value: raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : Number(raw), complete });
    }
  }
  return fields;
}

function stringField(fields: ReturnType<typeof readJsonObjectPrefix>, key: string): EditCallField<string> | null {
  const field = fields?.get(key);
  if (field === undefined || typeof field.value !== "string") return null;
  return field.complete ? { value: field.value, complete: true } : { value: field.value, complete: false };
}

/** The file change an edit or write call's recorded input describes, or null for any other tool or input. */
export function parseFileChangeCall(toolName: string, input: string | null | undefined): ParsedFileChangeCall | null {
  if (!isFileChangeTool(toolName) || input === null || input === undefined) return null;
  const fields = readJsonObjectPrefix(input);
  if (fields === null) return null;
  const path = stringField(fields, "path");
  const pathText = path?.complete ? path.value : null;
  if (toolName === "write") {
    return { kind: "write", path: pathText, content: stringField(fields, "content") };
  }
  return {
    kind: "edit",
    path: pathText,
    oldText: stringField(fields, "oldText"),
    newText: stringField(fields, "newText"),
    replaceAll: fields.get("replaceAll")?.value === true,
  };
}

/** Whether every text the diff needs was read whole (not from a clipped preview). */
export function fileChangeComplete(call: ParsedFileChangeCall): boolean {
  if (call.kind === "write") return call.content?.complete === true;
  return call.oldText?.complete === true && call.newText?.complete === true;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** The receipt facts a call's result text records (any field it lacks is null). */
export function fileChangeReceipt(result: string | null | undefined): FileChangeReceipt | null {
  if (result === null || result === undefined || result.trim() === "") return null;
  // The result may be the receipt object, or a string that holds it.
  let fields = readJsonObjectPrefix(result);
  if (fields !== null && fields.size === 0) fields = null;
  if (fields === null) {
    try {
      const unwrapped = JSON.parse(result) as unknown;
      if (typeof unwrapped === "string") fields = readJsonObjectPrefix(unwrapped);
    } catch {
      fields = null;
    }
  }
  if (fields === null) return null;
  const text = (key: string) => {
    const field = fields!.get(key);
    return field?.complete && typeof field.value === "string" ? field.value : null;
  };
  const count = (key: string) => {
    const field = fields!.get(key);
    return field?.complete && typeof field.value === "number" && Number.isSafeInteger(field.value) && field.value >= 0 ? field.value : null;
  };
  const sha = (key: string) => {
    const value = text(key);
    return value !== null && SHA256.test(value) ? value : null;
  };
  return {
    status: text("status"),
    replacements: count("replacements"),
    matches: count("matches"),
    byteLength: count("byteLength"),
    contentSha256: sha("contentSha256"),
    oldTextSha256: sha("oldTextSha256"),
    newTextSha256: sha("newTextSha256"),
    error: text("error"),
    message: text("message"),
  };
}

export type FileChangeState = "applied" | "not_applied" | "pending" | "cancelled" | "unknown";

/**
 * Whether the change took effect, from the call's own status: applied only
 * when it succeeded (and its receipt, when one was read, did not say
 * otherwise); never applied while running or after a failure.
 */
export function fileChangeState(status: ActivityToolStatus, receipt: FileChangeReceipt | null): FileChangeState {
  if (status === "running") return "pending";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "not_applied";
  if (status === "unfinished") return "unknown";
  if (receipt?.status !== null && receipt?.status !== undefined && receipt.status !== "succeeded") return "not_applied";
  return "applied";
}

export const FILE_CHANGE_STATE_LABELS: Readonly<Record<FileChangeState, string>> = {
  applied: "Applied",
  not_applied: "Not applied",
  pending: "Not applied yet",
  cancelled: "Cancelled, not applied",
  unknown: "Outcome not recorded",
};

/** The removed and added lines of a parsed change; null when its texts are missing. */
export function fileChangeDiff(call: ParsedFileChangeCall): LineDiff | null {
  if (call.kind === "write") return call.content === null ? null : diffLines("", call.content.value);
  if (call.oldText === null || call.newText === null) return null;
  return diffLines(call.oldText.value, call.newText.value);
}

/** SHA-256 of UTF-8 text as hex, with the platform's Web Crypto (browser and Node alike). */
export async function sha256Text(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ReceiptBinding = "matches" | "differs" | "unavailable";

/**
 * Whether the texts shown are the very texts the call's receipt hashed: an
 * edit's oldText/newText hashes, or a write's written content hash. Only a
 * complete input can match.
 */
export async function fileChangeReceiptBinding(call: ParsedFileChangeCall, receipt: FileChangeReceipt | null): Promise<ReceiptBinding> {
  if (receipt === null || !fileChangeComplete(call)) return "unavailable";
  if (call.kind === "write") {
    if (receipt.contentSha256 === null) return "unavailable";
    const actual = await sha256Text(call.content!.value);
    return actual === null ? "unavailable" : actual === receipt.contentSha256 ? "matches" : "differs";
  }
  if (receipt.oldTextSha256 === null || receipt.newTextSha256 === null) return "unavailable";
  const [oldSha, newSha] = await Promise.all([sha256Text(call.oldText!.value), sha256Text(call.newText!.value)]);
  if (oldSha === null || newSha === null) return "unavailable";
  return oldSha === receipt.oldTextSha256 && newSha === receipt.newTextSha256 ? "matches" : "differs";
}
