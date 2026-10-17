import { createHash, randomBytes } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON (sorted object keys) so manifests hash identically everywhere. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Time-sortable random id: <prefix>-<base36 ms>-<hex>. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
}

/** Write via temp file + fsync + rename so readers never observe partial content. */
export async function atomicWrite(file: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

/**
 * Write an immutable object exactly once. If it already exists the bytes must
 * match (content-addressed objects are idempotent); otherwise it is an error.
 */
export async function writeImmutable(file: string, data: string | Uint8Array): Promise<"created" | "exists"> {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  try {
    const existing = await fs.readFile(file);
    if (!existing.equals(bytes)) throw new Error(`Immutable object ${path.basename(file)} already exists with different content`);
    return "exists";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmp, bytes, { mode: 0o444 });
  try {
    // link() fails if the target exists, giving create-once semantics even across processes.
    await fs.link(tmp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(file);
    if (!existing.equals(bytes)) throw new Error(`Immutable object ${path.basename(file)} raced with different content`);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  return "created";
}

export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Serializes async work per key (single writer per memory space inside one process). */
export class KeyedMutex {
  #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}

/** Cross-process advisory lock using O_EXCL lock files with stale-lock recovery. */
export async function withFileLock<T>(lockFile: string, fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 60_000;
  const started = Date.now();
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      const handle = await fs.open(lockFile, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock ${path.basename(lockFile)}`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockFile, { force: true });
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
