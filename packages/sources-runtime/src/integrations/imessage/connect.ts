import { db } from "../../db/client.js";
import { ensureDefaultKbForTenant } from "../../graph/wiring/default-kb.js";
import { storeToken } from "../../vault/tokens.js";
import { imessageHandlesFromInput } from "../../lib/imessage-handles.js";
import { ensureDefaultKbSchedule } from "../../queue/dispatch.js";
import { createImessageAgentToken, invalidateTokenCache } from "./auth.js";

interface ImessageConnectResult {
  success: boolean;
  agentToken?: string;
  error?: string;
}

export async function connectImessage(
  userId: string,
  handlesInput: string | string[],
): Promise<ImessageConnectResult> {
  const handles = normalizeImessageHandles(handlesInput);
  const handle = handles[0];
  if (!handle || handle.length < 5) {
    return { success: false, error: "Valid phone number or Apple ID email is required" };
  }

  const agentToken = createImessageAgentToken();

  await storeToken(userId, "imessage", agentToken, {
    handle,
    handles,
    connectedAt: new Date().toISOString(),
  });

  invalidateTokenCache();
  await ensureDefaultKbSchedule(userId);
  await ensureDefaultKbForTenant(db, userId);

  return { success: true, agentToken };
}

function normalizeImessageHandles(handlesInput: string | string[]): string[] {
  return imessageHandlesFromInput(handlesInput);
}
