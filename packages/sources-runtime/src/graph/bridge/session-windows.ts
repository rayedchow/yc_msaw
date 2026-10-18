export const SESSION_WINDOW_DEFAULT_GAP_MS = 5 * 60 * 60 * 1000;
export const SESSION_WINDOW_DEFAULT_MAX_CHARS = 80_000;
export const SESSION_WINDOW_DEFAULT_MIN_CHARS = 500;

export interface SessionMessage {
  timestamp: string | Date;
  text?: string | null;
  senderName?: string | null;
  senderHandle?: string | null;
  isFromMe?: boolean | null;
  reaction?: string | null;
  hasAttachments?: boolean | null;
}

export interface SessionWindowOptions {
  gapMs?: number;
  maxChars?: number;
  minChars?: number;
  sinceTs?: Date;
}

export interface SessionWindow {
  windowKey: string;
  startTs: Date;
  endTs: Date;
  messageCount: number;
  content: string;
  crumb: boolean;
}

type RenderedSessionMessage = {
  timestamp: Date;
  line: string;
  ordinal: number;
};

export function assembleSessionWindows(
  messages: SessionMessage[],
  opts: SessionWindowOptions = {},
): SessionWindow[] {
  const gapMs = positiveNumber(opts.gapMs) ?? SESSION_WINDOW_DEFAULT_GAP_MS;
  const maxChars = positiveNumber(opts.maxChars) ?? SESSION_WINDOW_DEFAULT_MAX_CHARS;
  const minChars = nonNegativeNumber(opts.minChars) ?? SESSION_WINDOW_DEFAULT_MIN_CHARS;
  const sinceMs = opts.sinceTs?.getTime();

  const rendered = messages
    .map((message, ordinal): RenderedSessionMessage | null => {
      const timestamp = message.timestamp instanceof Date ? message.timestamp : new Date(String(message.timestamp));
      if (Number.isNaN(timestamp.getTime())) return null;
      if (sinceMs !== undefined && timestamp.getTime() < sinceMs) return null;
      const line = renderSessionMessageLine(message);
      return line ? { timestamp, line, ordinal } : null;
    })
    .filter((message): message is RenderedSessionMessage => message !== null)
    .sort((a, b) => (
      a.timestamp.getTime() - b.timestamp.getTime()
      || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0)
      || a.ordinal - b.ordinal
    ));

  const windows: Array<{
    startTs: Date;
    endTs: Date;
    lines: string[];
    messageCount: number;
  }> = [];
  let current: (typeof windows)[number] | null = null;

  for (const message of rendered) {
    const wouldExceedGap = current
      ? message.timestamp.getTime() - current.endTs.getTime() > gapMs
      : false;
    const wouldExceedMaxChars = current && current.lines.length > 0
      ? current.lines.join("\n").length + 1 + message.line.length > maxChars
      : false;

    if (!current || wouldExceedGap || wouldExceedMaxChars) {
      current = {
        startTs: new Date(message.timestamp.getTime()),
        endTs: new Date(message.timestamp.getTime()),
        lines: [],
        messageCount: 0,
      };
      windows.push(current);
    }

    current.lines.push(message.line);
    current.endTs = new Date(message.timestamp.getTime());
    current.messageCount += 1;
  }

  const keyCounts = new Map<string, number>();
  return windows.map((window) => {
    const baseKey = sessionWindowKey(window.startTs);
    const nextCount = (keyCounts.get(baseKey) ?? 0) + 1;
    keyCounts.set(baseKey, nextCount);
    const content = window.lines.join("\n");
    return {
      windowKey: nextCount === 1 ? baseKey : `${baseKey}-${nextCount}`,
      startTs: new Date(window.startTs.getTime()),
      endTs: new Date(window.endTs.getTime()),
      messageCount: window.messageCount,
      content,
      crumb: content.length < minChars,
    };
  });
}

export function renderSessionMessageLine(message: SessionMessage): string | null {
  const date = message.timestamp instanceof Date ? message.timestamp : new Date(String(message.timestamp));
  if (Number.isNaN(date.getTime())) return null;
  const text = stringValue(message.text);
  const reaction = stringValue(message.reaction);
  const attachment = message.hasAttachments === true;
  if (!text && !reaction && !attachment) return null;
  const sender = message.isFromMe === true
    ? "me"
    : stringValue(message.senderName) ?? stringValue(message.senderHandle) ?? "unknown";
  const stamp = `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)}`;
  const parts = [
    reaction ? `(${reaction})` : null,
    text,
    attachment && !text ? "[attachment]" : attachment ? "[+attachment]" : null,
  ].filter(Boolean).join(" ");
  return `**${stamp}** ${inlineText(sender)}: ${parts.replace(/\s+/g, " ").trim()}`;
}

function sessionWindowKey(date: Date): string {
  return date.toISOString().slice(0, 16).replace(":", "");
}

function positiveNumber(value: number | undefined): number | null {
  return typeof value === "number" && (Number.isFinite(value) || value === Number.POSITIVE_INFINITY) && value > 0
    ? value
    : null;
}

function nonNegativeNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
