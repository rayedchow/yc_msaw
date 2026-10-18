import { instagramPersonalLane } from "../../../integrations/instagram-personal/index.js";

/** Instagram (personal): `sources/instagram-personal/<account>/<chat>/<yyyy-mm>/<message>.json` + attachment bytes. */
export const instagramPersonalProvider = instagramPersonalLane.module();
