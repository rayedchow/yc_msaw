import { createCodingSessionsProvider } from "../../../integrations/coding-sessions/lane.js";

/**
 * Coding sessions (Codex / Claude Code) device provider: `sources/coding-sessions/<provider>/<yyyy-mm>/<session>.{json,md}`.
 * Wire, device auth (yc_msaw is the live authority) and coverage: src/integrations/coding-sessions/lane.ts.
 */
export const codingSessionsProvider = createCodingSessionsProvider();
