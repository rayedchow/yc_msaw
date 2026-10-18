export type ImessageMessageIdentity =
  | { kind: "provider_guid"; value: string; explicit: boolean }
  | { kind: "local_row"; value: string };

export type ImessageIdentityInput = {
  messageId?: unknown;
  providerMessageGuid?: unknown;
  localRowId?: unknown;
  rowId?: unknown;
  chatId?: unknown;
  providerGuidExplicit?: unknown;
  _provider_guid_explicit?: unknown;
  _providerGuidExplicit?: unknown;
};

export function getImessageMessageIdentity(input: ImessageIdentityInput): ImessageMessageIdentity {
  const explicitGuid = stringValue(input.providerMessageGuid);
  const messageId = stringValue(input.messageId);
  const rowId = Number(input.localRowId ?? input.rowId);
  if (explicitGuid && isProviderMessageGuidCandidate(explicitGuid, rowId)) {
    return { kind: "provider_guid", value: explicitGuid, explicit: providerGuidWasExplicit(input) };
  }

  if (messageId && !/^\d+$/.test(messageId) && (!Number.isFinite(rowId) || messageId !== String(rowId))) {
    return { kind: "provider_guid", value: messageId, explicit: false };
  }

  return { kind: "local_row", value: Number.isFinite(rowId) && rowId > 0 ? String(rowId) : (messageId ?? "unknown") };
}

export function getCanonicalImessageSourceEventId(
  input: ImessageIdentityInput,
  identity: ImessageMessageIdentity,
  normalizedConversationId: string | null,
): string {
  if (identity.kind === "provider_guid") {
    return `imessage:message:${identity.value}`;
  }
  const rawChatId = stringValue(input.chatId) ?? "unknown";
  return `imessage:local:${normalizedConversationId ?? rawChatId}:${identity.value}`;
}

export function getLegacyImessageSourceEventId(input: ImessageIdentityInput): string {
  return `imessage:${stringValue(input.chatId) ?? "unknown"}:${stringValue(input.messageId) ?? "unknown"}`;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isProviderMessageGuidCandidate(value: string, rowId: number): boolean {
  if (Number.isFinite(rowId) && value === String(rowId)) return false;
  return !/^\d+$/.test(value);
}

function providerGuidWasExplicit(input: ImessageIdentityInput): boolean {
  const explicit = booleanValue(input.providerGuidExplicit)
    ?? booleanValue(input._provider_guid_explicit)
    ?? booleanValue(input._providerGuidExplicit);
  return explicit ?? true;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}
