/**
 * WhatsApp (personal) over Unipile, ported from gigabrain 5448774 brain/src/integrations/whatsapp-personal/*.
 * Shared machinery and the deliberate changes from the donor: ../unipile-personal/lane.ts.
 */
import { UnipileLane, whatsappSenderId } from "../unipile-personal/lane.js";

export const WHATSAPP_PERSONAL_PROVIDER = "whatsapp_personal";

export const whatsappPersonalLane = new UnipileLane({
  provider: WHATSAPP_PERSONAL_PROVIDER,
  sourceDir: "whatsapp-personal",
  accountType: "WHATSAPP",
  label: "WhatsApp",
  historyLimit: "history is whatever WhatsApp's linked-device sync hands Unipile (initial sync window decided by WhatsApp, typically recent 1:1 and group history); webhooks are forward-only",
  senderId: whatsappSenderId,
  // Donor whatsappPersonalEventType: non-receive events keep their name; otherwise sent/received by sender.
  eventType: (m, accountUserId, _accountId, event) => {
    if (event && event !== "message_received") return event;
    const sender = whatsappSenderId(m);
    return sender && accountUserId && sender === accountUserId ? "message_sent" : "message_received";
  },
  eventSuffix: true,
});

export const whatsappPersonalIntegration = whatsappPersonalLane.integration();
