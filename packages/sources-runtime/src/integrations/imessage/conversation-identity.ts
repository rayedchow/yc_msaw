import { normalizeImessageHandle } from "../../lib/imessage-handles.js";

export type ImessageConversationType = "direct" | "group" | "unknown";

export type ImessageConversationPointer = {
  normalizedConversationId: string;
  conversationType: ImessageConversationType;
  conversationName: string;
  counterpartHandle: string | null;
  rawChatId: string;
};

type ImessagePayloadLike = Record<string, unknown>;

export function getImessageConversationPointer(
  payload: ImessagePayloadLike,
): ImessageConversationPointer | null {
  const rawChatId = stringValue(payload.chatId) ?? stringValue(payload._chat_id);
  if (!rawChatId) return null;
  const explicitNormalizedConversationId = stringValue(payload._normalized_conversation_id);
  if (explicitNormalizedConversationId) {
    const parsed = parseNormalizedImessageConversationId(explicitNormalizedConversationId);
    if (parsed.kind === "direct") {
      return {
        normalizedConversationId: explicitNormalizedConversationId,
        conversationType: "direct",
        conversationName: stringValue(payload._resolved_name)
          ?? stringValue(payload.chatName)
          ?? stringValue(payload._chat_name)
          ?? parsed.counterpartHandle,
        counterpartHandle: parsed.counterpartHandle,
        rawChatId,
      };
    }
    if (parsed.kind === "group") {
      return {
        normalizedConversationId: explicitNormalizedConversationId,
        conversationType: "group",
        conversationName: stringValue(payload.chatName) ?? stringValue(payload._chat_name) ?? parsed.rawChatId,
        counterpartHandle: null,
        rawChatId,
      };
    }
    return {
      normalizedConversationId: explicitNormalizedConversationId,
      conversationType: "unknown",
      conversationName: stringValue(payload.chatName) ?? stringValue(payload._chat_name) ?? parsed.rawChatId,
      counterpartHandle: null,
      rawChatId,
    };
  }

  const chatKind = stringValue(payload.chatKind);
  const chatType = stringValue(payload._chat_type);
  const rawDmHandle = parseImessageDmHandleFromChatId(rawChatId);
  const conversationType = normalizeConversationType(chatKind, chatType, rawDmHandle);
  const participant = stringValue(payload.participant) ?? stringValue(payload._sender_handle);
  const isSelfHandle = payload._is_self_handle === true;
  const counterpartHandle = conversationType === "direct"
    ? normalizeDirectCounterpartHandle(isSelfHandle ? rawDmHandle : (participant ?? rawDmHandle))
    : null;

  if (counterpartHandle) {
    return {
      normalizedConversationId: `imessage:dm:${counterpartHandle}`,
      conversationType: "direct",
      conversationName: stringValue(payload._resolved_name)
        ?? stringValue(payload.chatName)
        ?? stringValue(payload._chat_name)
        ?? counterpartHandle,
      counterpartHandle,
      rawChatId,
    };
  }

  if (conversationType === "group") {
    return {
      normalizedConversationId: `imessage:group:${rawChatId}`,
      conversationType,
      conversationName: stringValue(payload.chatName) ?? stringValue(payload._chat_name) ?? rawChatId,
      counterpartHandle: null,
      rawChatId,
    };
  }

  return {
    normalizedConversationId: `imessage:raw:${rawChatId}`,
    conversationType,
    conversationName: stringValue(payload.chatName) ?? stringValue(payload._chat_name) ?? rawChatId,
    counterpartHandle: null,
    rawChatId,
  };
}

export function normalizedImessageConversationIdForHandle(handle: string): string {
  const normalized = normalizeImessageHandle(handle);
  if (!normalized) throw new Error("counterpart_handle must be a non-empty string");
  return `imessage:dm:${normalized}`;
}

export function parseImessageDmHandleFromChatId(chatId: unknown): string | null {
  const raw = stringValue(chatId);
  if (!raw) return null;
  const parts = raw.split(";");
  if (parts.length < 3 || parts[1] !== "-") return null;
  return normalizeDirectCounterpartHandle(parts.slice(2).join(";"));
}

export function parseNormalizedImessageConversationId(
  normalizedConversationId: string,
): { kind: "direct"; counterpartHandle: string } | { kind: "group" | "raw"; rawChatId: string } {
  if (normalizedConversationId.startsWith("imessage:dm:")) {
    const counterpartHandle = normalizedConversationId.slice("imessage:dm:".length);
    if (!counterpartHandle) throw new Error("normalized_conversation_id has an empty iMessage DM handle");
    return { kind: "direct", counterpartHandle };
  }

  if (normalizedConversationId.startsWith("imessage:group:")) {
    const rawChatId = normalizedConversationId.slice("imessage:group:".length);
    if (!rawChatId) throw new Error("normalized_conversation_id has an empty iMessage group chat id");
    return { kind: "group", rawChatId };
  }

  if (normalizedConversationId.startsWith("imessage:raw:")) {
    const rawChatId = normalizedConversationId.slice("imessage:raw:".length);
    if (!rawChatId) throw new Error("normalized_conversation_id has an empty iMessage raw chat id");
    return { kind: "raw", rawChatId };
  }

  throw new Error("normalized_conversation_id must start with imessage:dm:, imessage:group:, or imessage:raw:");
}

function normalizeConversationType(
  chatKind: string | null,
  chatType: string | null,
  rawDmHandle: string | null,
): ImessageConversationType {
  if (chatKind === "dm" || chatType === "direct") return "direct";
  if (chatKind === "group" || chatType === "group") return "group";
  if (rawDmHandle) return "direct";
  return "unknown";
}

function normalizeDirectCounterpartHandle(handle: string | null): string | null {
  if (!handle) return null;
  const normalized = normalizeImessageHandle(handle);
  return normalized || null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
