export function normalizeImessageHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();

  const phone = normalizePhoneHandle(trimmed);
  return phone || trimmed.toLowerCase();
}

export function imessageHandleVariants(handle: string): string[] {
  const trimmed = handle.trim();
  if (!trimmed) return [];

  const variants = new Set<string>([trimmed, trimmed.toLowerCase()]);
  const normalized = normalizeImessageHandle(trimmed);
  if (normalized) variants.add(normalized);

  if (!trimmed.includes("@")) {
    const digits = trimmed.replace(/\D/g, "");
    if (digits) variants.add(digits);
    if (digits.length === 10) variants.add(`+1${digits}`);
    if (digits.length === 11 && digits.startsWith("1")) {
      variants.add(`+${digits}`);
      variants.add(digits.slice(1));
    }
    if (normalized.startsWith("+1") && normalized.length === 12) {
      variants.add(normalized.slice(2));
      variants.add(normalized.slice(1));
    } else if (normalized.startsWith("+")) {
      variants.add(normalized.slice(1));
    }
  }

  return [...variants].filter(Boolean);
}

export function imessageHandlesFromInput(input: unknown): string[] {
  return [...new Set(rawImessageHandleValues(input)
    .map((value) => normalizeImessageHandle(value))
    .filter(Boolean))];
}

export function imessageHandlesFromMetadata(metadata: unknown): string[] {
  const record = recordValue(metadata);
  if (!record) return [];
  return imessageHandlesFromInput([
    record.handle,
    record.handles,
    record.phone,
    record.phoneNumber,
    record.appleIdEmail,
    record.contactEmail,
    record.contactEmails,
    record.imessageHandles,
  ]);
}

function normalizePhoneHandle(handle: string): string {
  const hasPlus = handle.trim().startsWith("+");
  const digits = handle.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (hasPlus) return `+${digits}`;
  return digits;
}

function rawImessageHandleValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(rawImessageHandleValues);
  const string = typeof value === "string" && value.trim() ? value.trim() : "";
  if (!string) return [];
  return string.split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
