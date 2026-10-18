import { readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MAX_BLOB_BYTES, SESSION_ID_RE } from "../traces/schema.js";
import { ensurePrivateDir, readSecretFile, withFileLock, writeSecretFileAtomic } from "./oauth-refresh.js";
import { TraceOutboxError, type TraceOutboxStore } from "./outbox.js";

/**
 * Node filesystem TraceOutboxStore. Raw traces stay private:
 *  - the directory is created 0700 and must be owned by the current user and not group/world writable;
 *  - every file is 0600, opened with O_NOFOLLOW (symlinks are refused), and written atomically
 *    (temp file + fsync + rename + directory fsync);
 *  - checkpoint CAS runs under an exclusive cross-process lock file (no automatic takeover of a lock a live process may
 *    hold; a lock left by a crash mid-write times out with a clear error).
 * These are the SDK's existing secret-file helpers (shared with the OAuth token store). Nothing is sent anywhere.
 *
 * Layout: <dir>/sessions/<sessionId>.json (checkpoint), <dir>/sessions/<sessionId>.lock, <dir>/objects/<key>.b64.
 */
export interface FileTraceOutboxOptions {
  /** Max wait for the per-session lock (default 10 s). */
  lockTimeoutMs?: number;
}

const OBJECT_KEY_RE = /^(chunk\/[a-z0-9][a-z0-9_-]{2,95}\/\d{6,}-[0-9a-f]{64}|blob\/[a-z0-9][a-z0-9_-]{2,95}\/[0-9a-f]{64})$/;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

function wrap(what: string, error: unknown): TraceOutboxError {
  if (error instanceof TraceOutboxError) return error;
  return new TraceOutboxError("store_error", `trace outbox ${what} failed: ${error instanceof Error ? error.message.replace(/token store|secret file/g, "outbox file") : String(error)}`, error);
}

export class FileTraceOutbox implements TraceOutboxStore {
  readonly dir: string;
  readonly #sessions: string;
  readonly #objects: string;
  readonly #lockTimeoutMs: number;
  #ready: Promise<void> | null = null;

  constructor(dir: string, options: FileTraceOutboxOptions = {}) {
    if (!dir) throw new TraceOutboxError("store_error", "FileTraceOutbox needs a directory");
    this.dir = resolve(dir);
    this.#sessions = join(this.dir, "sessions");
    this.#objects = join(this.dir, "objects");
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  #init(): Promise<void> {
    this.#ready ??= (async () => {
      try {
        await ensurePrivateDir(this.dir);
        await ensurePrivateDir(this.#sessions);
        await ensurePrivateDir(this.#objects);
      } catch (error) {
        this.#ready = null;
        throw wrap("initialization", error);
      }
    })();
    return this.#ready;
  }

  #checkpointPath(sessionId: string): string {
    if (!SESSION_ID_RE.test(sessionId)) throw new TraceOutboxError("store_error", `invalid sessionId ${JSON.stringify(sessionId)}`);
    return join(this.#sessions, `${sessionId}.json`);
  }

  #objectPath(key: string): string {
    if (!OBJECT_KEY_RE.test(key)) throw new TraceOutboxError("store_error", `invalid outbox object key ${JSON.stringify(key)}`);
    return join(this.#objects, `${key.replace(/\//g, "__")}.b64`);
  }

  async listSessions(): Promise<string[]> {
    await this.#init();
    try {
      return (await readdir(this.#sessions))
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .map((f) => f.slice(0, -5))
        .filter((s) => SESSION_ID_RE.test(s))
        .sort();
    } catch (error) {
      throw wrap("listing", error);
    }
  }

  async readCheckpoint(sessionId: string): Promise<string | null> {
    await this.#init();
    try {
      return await readSecretFile(this.#checkpointPath(sessionId), MAX_CHECKPOINT_BYTES);
    } catch (error) {
      throw wrap(`read of checkpoint ${sessionId}`, error);
    }
  }

  async casCheckpoint(sessionId: string, expectedRevision: number | null, json: string, revision: number): Promise<boolean> {
    await this.#init();
    const path = this.#checkpointPath(sessionId);
    try {
      return await withFileLock(
        `${path.slice(0, -5)}.lock`,
        async () => {
          const current = await readSecretFile(path, MAX_CHECKPOINT_BYTES);
          let currentRevision: number | null = null;
          if (current !== null) {
            try {
              currentRevision = (JSON.parse(current) as { revision?: unknown }).revision as number;
            } catch {
              throw new TraceOutboxError("corrupt", `checkpoint of ${sessionId} is not valid JSON; refusing to overwrite it`);
            }
            if (!Number.isInteger(currentRevision)) throw new TraceOutboxError("corrupt", `checkpoint of ${sessionId} has no revision; refusing to overwrite it`);
          }
          if (currentRevision !== expectedRevision) return false;
          await writeSecretFileAtomic(path, json);
          void revision;
          return true;
        },
        { timeoutMs: this.#lockTimeoutMs },
      );
    } catch (error) {
      throw wrap(`checkpoint CAS of ${sessionId}`, error);
    }
  }

  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    await this.#init();
    try {
      await writeSecretFileAtomic(this.#objectPath(key), Buffer.from(bytes).toString("base64"));
    } catch (error) {
      throw wrap(`write of ${key}`, error);
    }
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    await this.#init();
    try {
      const raw = await readSecretFile(this.#objectPath(key), Math.ceil((MAX_BLOB_BYTES * 4) / 3) + 1024);
      return raw === null ? null : new Uint8Array(Buffer.from(raw, "base64"));
    } catch (error) {
      throw wrap(`read of ${key}`, error);
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.#init();
    try {
      await unlink(this.#objectPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw wrap(`delete of ${key}`, error);
    }
  }
}
