import { imessageHandleVariants } from "../../lib/imessage-handles.js";

const LEGACY_BLOCKED_IMESSAGE_HANDLES = [
  "+13054098546",
  "+12054012556",
];

const BLOCKED_IMESSAGE_HANDLE_VARIANTS = new Set(
  [...configuredBlockedHandles(), ...LEGACY_BLOCKED_IMESSAGE_HANDLES]
    .flatMap((handle) => imessageHandleVariants(handle)),
);

export function isBlockedImessageHandle(handle: string | null | undefined): boolean {
  if (!handle) return false;
  return imessageHandleVariants(handle).some((variant) => BLOCKED_IMESSAGE_HANDLE_VARIANTS.has(variant));
}

export function imessageMessageTouchesBlockedHandle(message: {
  chatId?: string | null;
  participant?: string | null;
  affectedParticipant?: string | null;
}): boolean {
  return isBlockedImessageHandle(message.participant)
    || isBlockedImessageHandle(message.affectedParticipant)
    || isBlockedImessageHandle(parseDmHandleFromChatId(message.chatId));
}

function parseDmHandleFromChatId(chatId: string | null | undefined): string | null {
  const parts = String(chatId ?? "").split(";");
  if (parts.length >= 3 && parts[1] === "-") return parts.slice(2).join(";") || null;
  return null;
}

function configuredBlockedHandles(): string[] {
  return [
    process.env.SENDBLUE_NUMBER,
    process.env.SHEPHERD_OWNED_IMESSAGE_HANDLES,
  ]
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}
