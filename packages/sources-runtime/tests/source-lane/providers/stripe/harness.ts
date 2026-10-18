/**
 * Stripe lane test harness: PGlite with the real source-lane migration plan (so 9900's journal trigger and
 * the activity_events constraints run for real) and a fake, read-only Stripe API. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";

export const pg = new PGlite();
export const db = drizzle(pg);

export const ready: Promise<void> = (async () => {
  for (const file of planMigrations().apply) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
})();

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

export async function resetAll(): Promise<void> {
  await pg.exec(`
    DELETE FROM stripe_object_snapshots; DELETE FROM stripe_cursors; DELETE FROM stripe_connections;
    DELETE FROM activity_events WHERE source = 'stripe'; DELETE FROM source_lane_journal; DELETE FROM task_queue;
    DELETE FROM task_schedules; DELETE FROM connections;
  `);
}

export type Obj = Record<string, unknown> & { id: string; object: string };

export function evt(id: string, type: string, created: number, object: Obj, extra: Record<string, unknown> = {}) {
  return { id, object: "event", type, created, livemode: false, api_version: "2026-09-30", data: { object }, ...extra };
}

/** Minimal Stripe API: GET /v1/account, /v1/events (newest first, created[gte], starting_after), /v1/<resource>. */
export class FakeStripe {
  account: { id: string } | null = { id: "acct_1TESTacct" };
  accountStatus = 200;
  events: ReturnType<typeof evt>[] = [];
  objects: Record<string, Obj[]> = {};
  calls: URL[] = [];
  hooks: Array<(url: URL) => Response | undefined> = [];
  keys = new Set(["sk_test_validkey123", "rk_test_restricted123"]);

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.calls.push(url);
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!this.keys.has(auth.replace(/^Bearer /, ""))) return json({ error: { type: "invalid_request_error", message: "Invalid API Key provided" } }, 401);
    for (const h of this.hooks) {
      const r = h(url);
      if (r) return r;
    }
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    const page = <T extends { id: string }>(all: T[]) => {
      const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
      const data = all.slice(start, start + limit);
      return json({ object: "list", data, has_more: start + limit < all.length, url: url.pathname });
    };
    if (url.pathname === "/v1/account") {
      if (this.accountStatus !== 200) return json({ error: { type: "invalid_request_error", message: "The provided key does not have the required permissions" } }, this.accountStatus);
      return json({ object: "account", ...this.account });
    }
    if (url.pathname === "/v1/events") {
      const gte = Number(url.searchParams.get("created[gte]") ?? 0);
      return page([...this.events].filter((e) => e.created >= gte).sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1)));
    }
    const resource = url.pathname.replace(/^\/v1\//, "");
    if (this.objects[resource]) return page(this.objects[resource]!);
    return json({ error: { type: "invalid_request_error", message: `Unrecognized request URL (GET: ${url.pathname})` } }, 404);
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
