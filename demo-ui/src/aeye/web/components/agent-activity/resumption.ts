import type { RunResumption } from "../../../src/build/run_resumptions.js";

/**
 * Resume and new-attempt dividers, shared by the build trace and Build or
 * Review conversations. Their time is Pacific, as the rest of the app shows
 * dates: "October 16 at 10:16 AM PDT" (PST in winter).
 */
const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** "October 16 at 10:16 AM PDT"; null for a value that is not a time. */
export function formatPacificMoment(value: string): string | null {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return null;
  const part = (type: Intl.DateTimeFormatPartTypes) => PACIFIC.formatToParts(date).find((entry) => entry.type === type)?.value ?? "";
  return `${part("month")} ${part("day")} at ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`;
}

/**
 * "Resumed October 16 at 10:16 AM PDT", "Resumed after restart …" or
 * "Attempt 2 started …"; null without a recorded time.
 */
export function resumptionLabel(resumption: RunResumption): string | null {
  const moment = formatPacificMoment(resumption.at);
  if (moment === null) return null;
  if (resumption.kind === "restart") return `Resumed after restart ${moment}`;
  return resumption.kind === "resumed" || resumption.attempt === null
    ? `Resumed ${moment}`
    : `Attempt ${resumption.attempt} started ${moment}`;
}

/**
 * The resumptions one loaded transcript shows: only those with activity it
 * recorded both before and at or after them, so a run that merely reads as
 * running, an agent that started after a resume, and one that never went on
 * show none. `firstAt` and `lastAt` bound what is loaded (ISO times).
 */
export function shownResumptions(
  resumptions: readonly RunResumption[] | undefined,
  firstAt: string | undefined,
  lastAt: string | undefined,
): RunResumption[] {
  if (!resumptions?.length || firstAt === undefined || lastAt === undefined) return [];
  return resumptions.filter((entry) => entry.at > firstAt && entry.at <= lastAt && resumptionLabel(entry) !== null);
}
