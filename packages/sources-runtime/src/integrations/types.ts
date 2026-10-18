import type { Hono } from "hono";
import type { TaskHandler } from "../queue/queue.js";

export type ConnectResult = {
  status: number;
  body: Record<string, unknown>;
};

/**
 * A connector: HTTP surface (OAuth callbacks, provider webhooks) plus task
 * handlers (polls, backfills) registered on the Postgres task queue.
 */
export type AqueductIntegration = {
  id: string;
  /** Tenant-scoped API connect handler for /v1/connect/:provider. */
  connect?: (input: { tenantId: string; body: unknown }) => Promise<ConnectResult>;
  /** Mount OAuth callbacks / provider webhook routes on the API app. */
  registerHttp?: (app: Hono) => void;
  /** Recurring task kinds this integration owns; disabled on disconnect. */
  taskKinds?: () => string[];
  /** Provider-side disconnect/revoke hook. Called before local status is revoked. */
  disconnect?: (input: { tenantId: string }) => Promise<void>;
  /** Task handlers keyed by task kind (e.g. "gmail.poll"). */
  taskHandlers?: () => Record<string, TaskHandler>;
  /** Long-lived listeners (socket-mode etc.); optional. */
  startRealtime?: () => Promise<void> | void;
};

/** Ported alias - connector files copied from the source repo use this name. */
export type BrainIntegration = AqueductIntegration;
