import { timingSafeEqual } from "node:crypto";

/** Constant-time compare against an expected secret value. */
export function safeCompareKey(provided: string | undefined, expected: string | undefined = process.env.ADMIN_API_KEY): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
