import { createOfficeAudioProvider } from "../../../integrations/office-audio/lane.js";

/**
 * Office audio (room transcripts, consent-gated, transcript-only): `sources/office-audio/<yyyy-mm>/<session>/{session.json,transcript.md}`.
 * Wire, consent gate and device authority: src/integrations/office-audio/lane.ts.
 */
export const officeAudioProvider = createOfficeAudioProvider();
