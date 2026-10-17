/**
 * Scripted (non-LLM) policies over the notification API. Used by unit tests and by the offline
 * "scripted-fixture" mode of eval/run.ts (where they drive a Pi faux model). NOT live model runs.
 *
 * Policies are written against an async `ApiClient` so the same code can call the host world
 * directly or go through Pi tool calls.
 */
import {
  VALID_CHANNELS,
  type ApiResponse,
  type DeliverArgs,
  type ListArgs,
  type NotificationRecord,
  type NotificationWorld,
} from "./world/notifications.js";

export interface ApiClient {
  listNotifications(args: ListArgs): Promise<ApiResponse>;
  getDeliveries(args: { id: string }): Promise<ApiResponse>;
  deliver(args: DeliverArgs): Promise<ApiResponse>;
}

export type ScriptedPolicy = (api: ApiClient, channel: string) => Promise<void>;

export function directClient(world: NotificationWorld): ApiClient {
  return {
    listNotifications: async (a) => world.listNotifications(a),
    getDeliveries: async (a) => world.getDeliveries(a),
    deliver: async (a) => world.deliver(a),
  };
}

interface ListBody {
  data: NotificationRecord[];
  next_cursor: string | null;
}

async function retrying(call: () => Promise<ApiResponse>, maxAttempts: number): Promise<ApiResponse> {
  let res = await call();
  for (let i = 1; i < maxAttempts && (res.status === 429 || res.status === 503); i++) res = await call();
  return res;
}

async function listAll(api: ApiClient, channel: string | undefined, retry: boolean): Promise<NotificationRecord[]> {
  const out: NotificationRecord[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const res = await retrying(
      () => api.listNotifications({ status: "failed", ...(channel ? { channel } : {}), ...(cursor ? { cursor } : {}) }),
      retry ? 5 : 1,
    );
    if (res.status !== 200) break;
    const body = res.body as ListBody;
    out.push(...body.data);
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return out;
}

function shouldSkip(n: NotificationRecord, channel: string): boolean {
  return (
    n.status !== "failed" ||
    !n.recipient ||
    !(VALID_CHANNELS as readonly string[]).includes(n.channel) ||
    n.channel !== channel
  );
}

async function alreadyDelivered(api: ApiClient, id: string, retry: boolean): Promise<boolean> {
  const d = await retrying(() => api.getDeliveries({ id }), retry ? 5 : 1);
  return d.status === 200 && (d.body as { deliveries: unknown[] }).deliveries.length > 0;
}

/** Correct policy: paginate, retry 429/503, skip permanent/malformed, check deliveries, idempotency key. */
export const referencePolicy: ScriptedPolicy = async (api, channel) => {
  for (const n of await listAll(api, channel, true)) {
    if (shouldSkip(n, channel)) continue;
    if (await alreadyDelivered(api, n.id, true)) continue;
    await retrying(() => api.deliver({ id: n.id, idempotency_key: n.id }), 6);
  }
};

/** Only reads the first page. */
export const pageOneOnlyPolicy: ScriptedPolicy = async (api, channel) => {
  const res = await retrying(() => api.listNotifications({ status: "failed", channel }), 5);
  if (res.status !== 200) return;
  for (const n of (res.body as ListBody).data) {
    if (shouldSkip(n, channel)) continue;
    if (await alreadyDelivered(api, n.id, true)) continue;
    await retrying(() => api.deliver({ id: n.id, idempotency_key: n.id }), 6);
  }
};

/** Never retries 429/503. */
export const noRetryPolicy: ScriptedPolicy = async (api, channel) => {
  for (const n of await listAll(api, channel, false)) {
    if (shouldSkip(n, channel)) continue;
    if (await alreadyDelivered(api, n.id, false)) continue;
    await api.deliver({ id: n.id, idempotency_key: n.id });
  }
};

/** Retries, but never checks existing deliveries and sends no Idempotency-Key. */
export const noDedupePolicy: ScriptedPolicy = async (api, channel) => {
  for (const n of await listAll(api, channel, true)) {
    if (shouldSkip(n, channel)) continue;
    await retrying(() => api.deliver({ id: n.id }), 6);
  }
};

/** Ignores the channel filter and status checks; delivers everything listed as failed. */
export const noFilterPolicy: ScriptedPolicy = async (api) => {
  for (const n of await listAll(api, undefined, true)) {
    if (await alreadyDelivered(api, n.id, true)) continue;
    await retrying(() => api.deliver({ id: n.id, idempotency_key: n.id }), 6);
  }
};

export const SCRIPTED_POLICIES = {
  reference: referencePolicy,
  "page-one-only": pageOneOnlyPolicy,
  "no-retry": noRetryPolicy,
  "no-dedupe": noDedupePolicy,
  "no-filter": noFilterPolicy,
} as const;
export type ScriptedPolicyName = keyof typeof SCRIPTED_POLICIES;
