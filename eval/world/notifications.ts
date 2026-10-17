/**
 * Host-owned deterministic task world: a simulated notification-delivery API.
 *
 * The agent under evaluation only ever sees the three API operations (as tools); it never sees
 * this code, the scenario spec, or the oracle. Behaviour is identical across scenarios; only the
 * data and the fault schedule differ per seed.
 *
 * Traps (all deterministic):
 * - cursor pagination: page size is capped at 3, the rest is behind `next_cursor`.
 * - 429 on some list calls (by global list-call ordinal), with Retry-After.
 * - transient 503 on deliver for configured ids (first N attempts), with Retry-After. Some of those
 *   503s are returned AFTER the delivery was committed ("commit-then-503"), so a blind retry
 *   without an Idempotency-Key produces a duplicate.
 * - stale "failed" records that already have a delivery (visible through get_deliveries). The API
 *   dedupes on Idempotency-Key, and the original delivery was made with key = notification id.
 * - malformed records (missing recipient / invalid channel) -> deliver returns 422.
 * - permanent failures (status failed_permanent; listed under status=failed) -> deliver returns 409.
 * - channel filter: the task names one channel; delivering other channels is wrong.
 */

export const VALID_CHANNELS = ["email", "sms", "push"] as const;
export type Channel = (typeof VALID_CHANNELS)[number];
export type NotificationStatus = "failed" | "failed_permanent" | "delivered" | "pending";

export interface NotificationRecord {
  id: string;
  status: NotificationStatus;
  /** May be an invalid channel string for malformed records. */
  channel: string;
  recipient?: string;
  created_at: string;
  last_error?: string;
}

export interface DeliveryRecord {
  delivery_id: string;
  notification_id: string;
  idempotency_key?: string;
  delivered_at: string;
  /** True when the delivery existed before the episode started (stale-failed trap). */
  preexisting: boolean;
}

export interface ScenarioSpec {
  seed: string;
  /** Channel the task asks to re-deliver. */
  channel: Channel;
  notifications: NotificationRecord[];
  /** Notification ids that already have a delivery before the episode (status still "failed"). */
  staleDelivered: string[];
  /** id -> number of initial deliver attempts that return 503. */
  transient503: Record<string, number>;
  /** ids whose FIRST 503 is returned after the delivery was committed. */
  commitThen503: string[];
  /** 1-based ordinals of list_notifications calls that return 429. */
  rateLimitedListCalls: number[];
  pageSize: number;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface ApiCallLog {
  seq: number;
  op: "list_notifications" | "get_deliveries" | "deliver";
  args: Record<string, unknown>;
  status: number;
}

export interface ListArgs {
  status?: string;
  channel?: string;
  cursor?: string;
  limit?: number;
}

export interface DeliverArgs {
  id: string;
  idempotency_key?: string;
}

// ---------------------------------------------------------------------------------------------
// Deterministic PRNG

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scenarios

export const TRAIN_SCENARIOS = ["train-day1-a", "train-day1-b"] as const;
export const HELDOUT_SCENARIOS = ["heldout-x", "heldout-y"] as const;
export const ALL_SCENARIOS = [...TRAIN_SCENARIOS, ...HELDOUT_SCENARIOS] as const;
export type ScenarioId = (typeof ALL_SCENARIOS)[number];

const SCENARIO_CHANNEL: Record<ScenarioId, Channel> = {
  "train-day1-a": "email",
  "train-day1-b": "sms",
  "heldout-x": "push",
  "heldout-y": "email",
};

type Kind =
  | "eligible"
  | "eligible_503"
  | "eligible_commit503"
  | "stale"
  | "permanent"
  | "missing_recipient"
  | "invalid_channel"
  | "other_channel"
  | "delivered"
  | "pending";

/** Build a scenario deterministically from its seed. Unknown seeds are allowed (generic mix). */
export function buildScenario(seed: string): ScenarioSpec {
  const rand = mulberry32(hashString(seed));
  const channel: Channel =
    (SCENARIO_CHANNEL as Record<string, Channel | undefined>)[seed] ??
    VALID_CHANNELS[Math.floor(rand() * VALID_CHANNELS.length)]!;
  const others = VALID_CHANNELS.filter((c) => c !== channel);

  // Every scenario contains every trap at least once; counts vary by seed.
  const counts: Record<Kind, number> = {
    eligible: 3 + Math.floor(rand() * 3),
    eligible_503: 1,
    eligible_commit503: 1,
    stale: 1 + Math.floor(rand() * 2),
    permanent: 1 + Math.floor(rand() * 2),
    missing_recipient: 1,
    invalid_channel: 1,
    other_channel: 2 + Math.floor(rand() * 2),
    delivered: 1,
    pending: 1,
  };
  let kinds: Kind[] = [];
  for (const [k, n] of Object.entries(counts) as [Kind, number][]) {
    for (let i = 0; i < n; i++) kinds.push(k);
  }
  kinds = shuffle(kinds, rand);
  // Make sure at least one eligible record sits beyond the first page (page size 3).
  if (kinds.slice(3).every((k) => !k.startsWith("eligible"))) {
    const idx = kinds.findIndex((k) => k.startsWith("eligible"));
    const [moved] = kinds.splice(idx, 1);
    kinds.push(moved!);
  }

  const prefix = seed.replace(/[^a-z0-9]/gi, "").slice(-4).toLowerCase() || "n";
  const notifications: NotificationRecord[] = [];
  const staleDelivered: string[] = [];
  const transient503: Record<string, number> = {};
  const commitThen503: string[] = [];
  const base = Date.UTC(2026, 9, 16, 8, 0, 0);
  kinds.forEach((kind, i) => {
    const id = `ntf_${prefix}_${String(100 + i)}`;
    const created_at = new Date(base + i * 97_000).toISOString();
    const recipient = `user${100 + Math.floor(rand() * 900)}@example.test`;
    const rec: NotificationRecord = {
      id,
      status: "failed",
      channel,
      recipient,
      created_at,
      last_error: "upstream_timeout",
    };
    switch (kind) {
      case "eligible":
        break;
      case "eligible_503":
        transient503[id] = 1 + Math.floor(rand() * 2);
        break;
      case "eligible_commit503":
        transient503[id] = 1;
        commitThen503.push(id);
        break;
      case "stale":
        staleDelivered.push(id);
        rec.last_error = "ack_timeout";
        break;
      case "permanent":
        rec.status = "failed_permanent";
        rec.last_error = "recipient_unsubscribed";
        break;
      case "missing_recipient":
        delete rec.recipient;
        rec.last_error = "missing_recipient";
        break;
      case "invalid_channel":
        rec.channel = rand() < 0.5 ? "fax" : "carrier_pigeon";
        rec.last_error = "unknown_channel";
        break;
      case "other_channel":
        rec.channel = others[Math.floor(rand() * others.length)]!;
        break;
      case "delivered":
        rec.status = "delivered";
        delete rec.last_error;
        break;
      case "pending":
        rec.status = "pending";
        delete rec.last_error;
        break;
    }
    notifications.push(rec);
  });

  const rateLimitedListCalls = [2 + Math.floor(rand() * 2)];
  return {
    seed,
    channel,
    notifications,
    staleDelivered,
    transient503,
    commitThen503,
    rateLimitedListCalls,
    pageSize: 3,
  };
}

/** The natural-language task the agent receives (no hints about the traps). */
export function taskPrompt(spec: ScenarioSpec): string {
  return [
    `Our notification service had an outage. Re-deliver every failed "${spec.channel}" notification so that each one`,
    `the customer should have received is delivered exactly once. Use only the notifications API tools`,
    `(list_notifications, get_deliveries, deliver). When you are done, reply with a short summary listing the`,
    `notification ids you delivered and the ids you intentionally skipped (with the reason).`,
  ].join(" ");
}

// ---------------------------------------------------------------------------------------------
// World

function encodeCursor(offset: number, status: string, channel: string | undefined, seed: string): string {
  return Buffer.from(JSON.stringify({ o: offset, s: status, c: channel ?? null, k: hashString(seed) % 9973 })).toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string,
  seed: string,
): { o: number; s: string; c: string | null } | undefined {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof v.o !== "number" || typeof v.s !== "string" || v.k !== hashString(seed) % 9973) return undefined;
    return { o: v.o, s: v.s, c: typeof v.c === "string" ? v.c : null };
  } catch {
    return undefined;
  }
}

export class NotificationWorld {
  readonly spec: ScenarioSpec;
  private readonly deliveries: DeliveryRecord[] = [];
  private readonly attempts = new Map<string, number>();
  private listCalls = 0;
  private deliverySeq = 0;
  private clock: number;
  readonly log: ApiCallLog[] = [];

  constructor(spec: ScenarioSpec) {
    this.spec = spec;
    this.clock = Date.UTC(2026, 9, 17, 9, 0, 0);
    for (const id of spec.staleDelivered) {
      this.deliveries.push({
        delivery_id: this.nextDeliveryId(),
        notification_id: id,
        idempotency_key: id,
        delivered_at: new Date(Date.UTC(2026, 9, 16, 23, 59, 0)).toISOString(),
        preexisting: true,
      });
    }
  }

  static fromSeed(seed: string): NotificationWorld {
    return new NotificationWorld(buildScenario(seed));
  }

  private nextDeliveryId(): string {
    this.deliverySeq += 1;
    return `dlv_${String(this.deliverySeq).padStart(4, "0")}`;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private record(op: ApiCallLog["op"], args: Record<string, unknown>, res: ApiResponse): ApiResponse {
    this.log.push({ seq: this.log.length + 1, op, args: { ...args }, status: res.status });
    return res;
  }

  allDeliveries(): readonly DeliveryRecord[] {
    return this.deliveries;
  }

  listNotifications(args: ListArgs): ApiResponse {
    const a = { ...args } as Record<string, unknown>;
    this.listCalls += 1;
    this.tick();
    if (this.spec.rateLimitedListCalls.includes(this.listCalls)) {
      return this.record("list_notifications", a, {
        status: 429,
        headers: { "retry-after": "1" },
        body: { error: "rate_limited", message: "Too many requests. Retry after 1 second." },
      });
    }
    let status = args.status;
    let channel = args.channel;
    let offset = 0;
    if (args.cursor !== undefined && args.cursor !== "") {
      const c = decodeCursor(args.cursor, this.spec.seed);
      if (!c) {
        return this.record("list_notifications", a, {
          status: 400,
          headers: {},
          body: { error: "invalid_cursor" },
        });
      }
      offset = c.o;
      status = c.s;
      channel = c.c ?? undefined;
    }
    if (status === undefined || status === "") {
      return this.record("list_notifications", a, {
        status: 400,
        headers: {},
        body: { error: "missing_parameter", message: "status is required" },
      });
    }
    const allowedStatus = ["failed", "failed_permanent", "delivered", "pending"];
    if (!allowedStatus.includes(status)) {
      return this.record("list_notifications", a, {
        status: 400,
        headers: {},
        body: { error: "invalid_status", allowed: allowedStatus },
      });
    }
    const limit = Math.max(1, Math.min(this.spec.pageSize, Math.floor(args.limit ?? this.spec.pageSize)));
    const matches = this.spec.notifications.filter((n) => {
      // status=failed includes permanently failed records (they are failures too).
      const statusOk = status === "failed" ? n.status === "failed" || n.status === "failed_permanent" : n.status === status;
      return statusOk && (channel === undefined || channel === "" || n.channel === channel);
    });
    const page = matches.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const next_cursor =
      nextOffset < matches.length ? encodeCursor(nextOffset, status, channel || undefined, this.spec.seed) : null;
    return this.record("list_notifications", a, {
      status: 200,
      headers: {},
      body: { data: page.map((n) => ({ ...n })), next_cursor },
    });
  }

  getDeliveries(args: { id: string }): ApiResponse {
    const a = { ...args } as Record<string, unknown>;
    this.tick();
    const n = this.spec.notifications.find((x) => x.id === args.id);
    if (!n) {
      return this.record("get_deliveries", a, { status: 404, headers: {}, body: { error: "not_found" } });
    }
    const deliveries = this.deliveries
      .filter((d) => d.notification_id === args.id)
      .map(({ delivery_id, idempotency_key, delivered_at }) => ({
        delivery_id,
        idempotency_key: idempotency_key ?? null,
        delivered_at,
      }));
    return this.record("get_deliveries", a, {
      status: 200,
      headers: {},
      body: { notification_id: args.id, deliveries },
    });
  }

  deliver(args: DeliverArgs): ApiResponse {
    const a = { ...args } as Record<string, unknown>;
    const now = this.tick();
    const n = this.spec.notifications.find((x) => x.id === args.id);
    if (!n) {
      return this.record("deliver", a, { status: 404, headers: {}, body: { error: "not_found" } });
    }
    if (n.status === "failed_permanent") {
      return this.record("deliver", a, {
        status: 409,
        headers: {},
        body: { error: "permanent_failure", message: "Notification is permanently failed and cannot be re-sent." },
      });
    }
    if (!n.recipient) {
      return this.record("deliver", a, {
        status: 422,
        headers: {},
        body: { error: "invalid_record", message: "Notification has no recipient." },
      });
    }
    if (!(VALID_CHANNELS as readonly string[]).includes(n.channel)) {
      return this.record("deliver", a, {
        status: 422,
        headers: {},
        body: { error: "invalid_record", message: `Unsupported channel "${n.channel}".` },
      });
    }
    // Idempotency-Key dedupe (scoped per notification).
    const key = args.idempotency_key;
    if (key !== undefined && key !== "") {
      const existing = this.deliveries.find((d) => d.notification_id === n.id && d.idempotency_key === key);
      if (existing) {
        return this.record("deliver", a, {
          status: 200,
          headers: { "idempotent-replay": "true" },
          body: { delivery_id: existing.delivery_id, deduplicated: true, delivered_at: existing.delivered_at },
        });
      }
    }
    const attempt = (this.attempts.get(n.id) ?? 0) + 1;
    this.attempts.set(n.id, attempt);
    const failures = this.spec.transient503[n.id] ?? 0;
    if (attempt <= failures) {
      if (attempt === 1 && this.spec.commitThen503.includes(n.id)) {
        // Committed, but the gateway times out before responding.
        this.deliveries.push({
          delivery_id: this.nextDeliveryId(),
          notification_id: n.id,
          ...(key ? { idempotency_key: key } : {}),
          delivered_at: now,
          preexisting: false,
        });
      }
      return this.record("deliver", a, {
        status: 503,
        headers: { "retry-after": "1" },
        body: { error: "service_unavailable", message: "Delivery gateway unavailable. Retry after 1 second." },
      });
    }
    const d: DeliveryRecord = {
      delivery_id: this.nextDeliveryId(),
      notification_id: n.id,
      ...(key ? { idempotency_key: key } : {}),
      delivered_at: now,
      preexisting: false,
    };
    this.deliveries.push(d);
    return this.record("deliver", a, {
      status: 202,
      headers: {},
      body: { delivery_id: d.delivery_id, deduplicated: false, delivered_at: d.delivered_at },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Oracle (host-side only)

export function isEligible(n: NotificationRecord, spec: ScenarioSpec): boolean {
  return (
    n.status === "failed" &&
    !spec.staleDelivered.includes(n.id) &&
    n.recipient !== undefined &&
    n.recipient !== "" &&
    (VALID_CHANNELS as readonly string[]).includes(n.channel) &&
    n.channel === spec.channel
  );
}

export interface OracleResult {
  success: boolean;
  eligible: number;
  delivered: number;
  duplicates: number;
  missed: number;
  wrong: number;
  failedCalls: number;
  totalCalls: number;
  missedIds: string[];
  duplicateIds: string[];
  wrongIds: string[];
}

export function evaluateWorld(world: NotificationWorld): OracleResult {
  const spec = world.spec;
  const counts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  for (const d of world.allDeliveries()) {
    counts.set(d.notification_id, (counts.get(d.notification_id) ?? 0) + 1);
    if (!d.preexisting) newCounts.set(d.notification_id, (newCounts.get(d.notification_id) ?? 0) + 1);
  }
  const eligibleIds = spec.notifications.filter((n) => isEligible(n, spec)).map((n) => n.id);
  const missedIds = eligibleIds.filter((id) => (counts.get(id) ?? 0) === 0);
  const duplicateIds: string[] = [];
  let duplicates = 0;
  for (const [id, c] of counts) {
    if (c > 1) {
      duplicates += c - 1;
      duplicateIds.push(id);
    }
  }
  const wrongIds: string[] = [];
  for (const [id, c] of newCounts) {
    // Stale records re-sent are already counted as duplicates.
    if (c > 0 && !eligibleIds.includes(id) && !spec.staleDelivered.includes(id)) wrongIds.push(id);
  }
  const failedCalls = world.log.filter((l) => l.status >= 400).length;
  const delivered = eligibleIds.filter((id) => (counts.get(id) ?? 0) >= 1).length;
  return {
    success: missedIds.length === 0 && duplicates === 0 && wrongIds.length === 0,
    eligible: eligibleIds.length,
    delivered,
    duplicates,
    missed: missedIds.length,
    wrong: wrongIds.length,
    failedCalls,
    totalCalls: world.log.length,
    missedIds,
    duplicateIds: duplicateIds.sort(),
    wrongIds: wrongIds.sort(),
  };
}
