/** Shared pieces of GurtAI's simulated systems: deterministic randomness, the timeline, request/response shapes. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const DAY = 86_400_000;
export const iso = (t: number) => new Date(t).toISOString();
export const NOW = Date.UTC(2026, 10, 1) - 1;
export const START = Date.UTC(2025, 0, 1);

export interface Req { method: string; path: string; query: Record<string, string>; body?: unknown; auth?: string | null }
export interface Res { status: number; body: unknown }

/** Offset paging used by the warehouse-style exports: { total, results, paging.next.after }. */
export function exportPage<T>(rows: T[], q: Record<string, string>, max = 5000) {
  const limit = Math.min(Number(q.limit ?? 1000), max);
  const off = Number(q.after ?? 0);
  const page = rows.slice(off, off + limit);
  return { total: rows.length, results: page, ...(off + page.length < rows.length ? { paging: { next: { after: String(off + page.length) } } } : {}) };
}
