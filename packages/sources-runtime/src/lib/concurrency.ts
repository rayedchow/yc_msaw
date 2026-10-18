export type ConcurrencyEnvOptions = {
  min?: number;
  max?: number;
};

export function parseConcurrencyEnv(
  name: string,
  fallback: number,
  options: ConcurrencyEnvOptions = {},
): number {
  const min = Math.max(1, Math.floor(options.min ?? 1));
  const max = Math.max(min, Math.floor(options.max ?? 10));
  const parsed = Math.floor(Number(process.env[name]));
  const value = Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function parsePositiveIntegerEnv(
  name: string,
  fallback: number,
  options: ConcurrencyEnvOptions = {},
): number {
  const min = Math.max(1, Math.floor(options.min ?? 1));
  const max = Math.max(min, Math.floor(options.max ?? Number.MAX_SAFE_INTEGER));
  const parsed = Math.floor(Number(process.env[name]));
  const value = Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
