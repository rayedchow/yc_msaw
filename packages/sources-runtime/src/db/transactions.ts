import type { db } from "./client.js";

export type DbExecutor = Pick<typeof db, "execute">;

export type TransactionCapableExecutor = DbExecutor & {
  transaction?(callback: (tx: DbExecutor) => Promise<unknown>): Promise<unknown>;
};

export async function withTransaction<T>(
  executor: TransactionCapableExecutor,
  callback: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  if (typeof executor.transaction === "function") {
    return executor.transaction((tx) => callback(tx)) as Promise<T>;
  }
  return callback(executor);
}
