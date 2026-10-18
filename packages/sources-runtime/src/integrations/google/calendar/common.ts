import { createHash } from "node:crypto";

export const GOOGLE_CALENDAR_QUEUE = "google-calendar-sync";
export const GOOGLE_CALENDAR_WEBHOOK_PATH = "/webhooks/google/calendar";
export const GOOGLE_CALENDAR_LIST_RESOURCE_KEY = "calendar_list";

export const GOOGLE_CALENDAR_EVENT_TYPES = [
  "birthday",
  "default",
  "focusTime",
  "fromGmail",
  "outOfOffice",
  "workingLocation",
] as const;

export type GoogleCalendarEventType = typeof GOOGLE_CALENDAR_EVENT_TYPES[number];
export type GoogleCalendarResourceType = "calendar_list" | "events";
export type GoogleCalendarParticipantKind = "human" | "nonhuman" | "unknown";

const GOOGLE_CALENDAR_INFRA_EMAIL = /@(?:[^@.]+\.)*calendar\.google\.com$/iu;
const GOOGLE_CALENDAR_SERVICE_EMAILS = new Set([
  "calendar-notification@google.com",
  "calendar-notification@googlemail.com",
  "calendar-server@google.com",
  "calendar@google.com",
]);

/** Classify only the participant shapes that give deterministic evidence. */
export function classifyGoogleCalendarParticipant(input: {
  email?: unknown;
  resource?: unknown;
}): GoogleCalendarParticipantKind {
  if (input.resource === true) return "nonhuman";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return "unknown";
  if (GOOGLE_CALENDAR_INFRA_EMAIL.test(email) || GOOGLE_CALENDAR_SERVICE_EMAILS.has(email)) {
    return "nonhuman";
  }
  return "human";
}

/**
 * Calendar resources and Google-managed calendar addresses can look like
 * attendees but are not human participation evidence.
 */
export function isHumanGoogleCalendarParticipant(input: {
  email?: unknown;
  resource?: unknown;
}): boolean {
  return classifyGoogleCalendarParticipant(input) === "human";
}

export function googleCalendarChannelTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function calendarEventTypeToActivityEventType(eventType: string | null | undefined, status?: string | null): string {
  if (status === "cancelled") return "calendar_event_cancelled";
  switch (eventType) {
    case "birthday":
      return "calendar_event_birthday";
    case "focusTime":
      return "calendar_event_focus_time";
    case "fromGmail":
      return "calendar_event_from_gmail";
    case "outOfOffice":
      return "calendar_event_out_of_office";
    case "workingLocation":
      return "calendar_event_working_location";
    case "default":
    case undefined:
    case null:
      return "calendar_event_default";
    default:
      return `calendar_event_${eventType.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;
  }
}

export function googleCalendarSourceEventId(input: {
  delegatedEmail: string;
  calendarId: string;
  eventId: string;
  revision: string | null | undefined;
}): string {
  const revision = input.revision?.trim() || "unknown";
  const digest = createHash("sha256")
    .update(input.delegatedEmail)
    .update("\0")
    .update(input.calendarId)
    .update("\0")
    .update(input.eventId)
    .update("\0")
    .update(revision)
    .digest("hex")
    .slice(0, 40);
  return `calendar:${digest}`;
}

export function googleCalendarSemanticSourceEventId(input: {
  delegatedEmail: string;
  calendarId: string;
  eventId: string;
  revision: string | null | undefined;
  semanticType: string;
  changeKey: string;
}): string {
  const revision = input.revision?.trim() || "unknown";
  const digest = createHash("sha256")
    .update(input.delegatedEmail)
    .update("\0")
    .update(input.calendarId)
    .update("\0")
    .update(input.eventId)
    .update("\0")
    .update(revision)
    .update("\0")
    .update(input.semanticType)
    .update("\0")
    .update(input.changeKey)
    .digest("hex")
    .slice(0, 40);
  return `calendar:change:${digest}`;
}
