import { whatsappPersonalLane } from "../../../integrations/whatsapp-personal/index.js";

/** WhatsApp (personal): `sources/whatsapp-personal/<account>/<chat>/<yyyy-mm>/<message>.json` + attachment bytes. */
export const whatsappPersonalProvider = whatsappPersonalLane.module();
