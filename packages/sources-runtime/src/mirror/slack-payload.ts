import { mentionIdsIn } from "./slack-text.js";

export type SlackPayloadReconcileResult = {
  changed: boolean;
  textChanged: boolean;
  payload: Record<string, unknown>;
};

export function buildSlackMentionStamp(
  text: string | undefined,
  resolveName: (id: string) => string | undefined,
): Record<string, unknown> {
  if (!text) return {};
  const ids = mentionIdsIn(text);
  if (ids.length === 0) return {};

  const mentions: Record<string, string> = {};
  let dropped = 0;
  for (const [index, id] of ids.entries()) {
    if (index >= 20) {
      dropped++;
      continue;
    }
    const resolved = resolveName(id);
    if (!resolved) {
      dropped++;
      continue;
    }
    mentions[id] = resolved;
  }

  return {
    ...(Object.keys(mentions).length > 0 ? { _mentions: mentions } : {}),
    ...(dropped > 0 ? { _mentions_dropped: dropped } : {}),
  };
}

export function reconcileStoredSlackMessagePayload(
  oldPayload: Record<string, unknown>,
  newPayload: Record<string, unknown>,
  editedAtFallback: string,
): SlackPayloadReconcileResult {
  const textChanged = stringOrNull(oldPayload.text) !== stringOrNull(newPayload.text);
  const changed = textChanged
    || slackEditedTs(oldPayload.edited) !== slackEditedTs(newPayload.edited)
    || stableSlackReactions(oldPayload.reactions) !== stableSlackReactions(newPayload.reactions);

  if (!changed) {
    return { changed: false, textChanged: false, payload: oldPayload };
  }

  const { _mentions, _mentions_dropped, ...oldPayloadWithoutMentionStamp } = oldPayload;
  void _mentions;
  void _mentions_dropped;

  const payload = {
    ...oldPayloadWithoutMentionStamp,
    ...newPayload,
  };

  if (textChanged) {
    const editHistory = Array.isArray(oldPayload._edit_history)
      ? [...(oldPayload._edit_history as Array<{ text: string; edited_at: string }>)]
      : [];
    editHistory.push({
      text: stringOrNull(oldPayload.text) ?? "",
      edited_at: slackEditedTs(newPayload.edited) ?? editedAtFallback,
    });
    payload._edit_history = editHistory;
  }

  return { changed: true, textChanged, payload };
}

function slackEditedTs(value: unknown): string | null {
  return value && typeof value === "object" && typeof (value as { ts?: unknown }).ts === "string"
    ? (value as { ts: string }).ts
    : null;
}

function stableSlackReactions(value: unknown): string {
  if (!Array.isArray(value)) return "[]";
  const normalized = value.flatMap((reaction) => {
    if (!reaction || typeof reaction !== "object") return [];
    const candidate = reaction as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const count = typeof candidate.count === "number" ? candidate.count : Number(candidate.count);
    const users = Array.isArray(candidate.users)
      ? candidate.users.filter((user): user is string => typeof user === "string").sort()
      : [];
    if (!name || !Number.isFinite(count)) return [];
    return [{ name, count, users }];
  }).sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(normalized);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
