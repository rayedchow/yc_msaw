/**
 * Instagram (personal) over Unipile, ported from gigabrain 5448774 brain/src/integrations/instagram-personal/*.
 * Coverage is always partial (gigabrain brain/evals/research/unipile-instagram-sync.md: Unipile surfaces a
 * limited recent slice of Instagram DMs, and webhooks are forward-only). Shared machinery: ../unipile-personal/lane.ts.
 */
import { UnipileLane, instagramSenderId } from "../unipile-personal/lane.js";

export const INSTAGRAM_PERSONAL_PROVIDER = "instagram_personal";

export const instagramPersonalLane = new UnipileLane({
  provider: INSTAGRAM_PERSONAL_PROVIDER,
  sourceDir: "instagram-personal",
  accountType: "INSTAGRAM",
  label: "Instagram",
  historyLimit: "Unipile surfaces only a limited recent slice of Instagram DMs (message requests and older threads may be absent); webhooks are forward-only",
  senderId: instagramSenderId,
  // Donor instagramPersonalEventType compares the sender with the Unipile account id.
  eventType: (m, _accountUserId, accountId) => {
    const sender = instagramSenderId(m);
    return sender && sender === accountId ? "message_sent" : "message_received";
  },
  // The donor Instagram webhook stores message deliveries only (no per-event rows).
  eventSuffix: false,
});

export const instagramPersonalIntegration = instagramPersonalLane.integration();
