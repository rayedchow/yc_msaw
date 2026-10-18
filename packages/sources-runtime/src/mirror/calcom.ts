/**
 * Cal.com booking join key.
 *
 * A Cal.com booking creates TWO distinct Google Calendar events for one real
 * meeting (Cal.com's own booking event plus the natively-authored copy), each
 * with a different gcal event id — so `gcal_event` identity alone splits the
 * Meeting in two. Every copy carries the identical Cal.com video/booking URL
 * (`cal.com/video/<uid>` or `cal.com/booking/<uid>`), whose UID is
 * deterministic per booking and therefore the stable cross-event join key.
 *
 * The pattern intentionally matches any host ending in `cal.com` (e.g.
 * `app.cal.com`) and requires a UID of at least 8 URL-safe characters; the
 * FIRST match wins wherever multiple URLs appear.
 */
export const CALCOM_BOOKING_URL_PATTERN = /cal\.com\/(?:video|booking)\/([A-Za-z0-9_-]{8,})/u;

/** Staged-envelope alias kind carrying the Cal.com booking UID. */
export const CALCOM_BOOKING_ALIAS_KIND = "calcom_booking";

/**
 * First Cal.com booking UID found across the given texts, scanned in order.
 * Non-string inputs are skipped; returns null when no text matches.
 */
export function calcomBookingUid(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const match = CALCOM_BOOKING_URL_PATTERN.exec(text);
    if (match) return match[1];
  }
  return null;
}
