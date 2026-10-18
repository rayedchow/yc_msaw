export function activityEventTimes(
  timestamp: Date,
  sourceUpdatedAt?: Date | string | null,
): {
  timestamp: Date;
  sourceUpdatedAt: Date | null;
  wikiEligibilityAt: Date;
} {
  const updated = validDate(sourceUpdatedAt);
  const eligibility = updated && updated.getTime() > timestamp.getTime() ? updated : timestamp;
  return {
    timestamp,
    sourceUpdatedAt: updated,
    wikiEligibilityAt: eligibility,
  };
}

export function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
