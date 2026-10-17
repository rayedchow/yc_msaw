/**
 * Expose the host-side notification world to a Pi agent as three custom tools. The agent sees the
 * HTTP-like responses (status, headers, body) as JSON text; the world itself stays on the host.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApiResponse, NotificationWorld } from "./notifications.js";

export const WORLD_TOOL_NAMES = ["list_notifications", "get_deliveries", "deliver"] as const;

export interface WorldToolBudget {
  /** Called before each world call; return a string to refuse the call (budget exhausted). */
  beforeCall?: (toolName: string) => string | undefined;
}

function asResult(res: ApiResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ http_status: res.status, headers: res.headers, body: res.body }) }],
    details: { status: res.status },
  };
}

export function createWorldTools(world: NotificationWorld, budget: WorldToolBudget = {}): ToolDefinition[] {
  const guard = (name: string) => {
    const refusal = budget.beforeCall?.(name);
    if (refusal) throw new Error(refusal);
  };
  const list = defineTool({
    name: "list_notifications",
    label: "List notifications",
    description:
      "GET /notifications. Lists notifications filtered by status (required: failed | failed_permanent | delivered | pending) " +
      "and optional channel. Results are paginated: pass the returned next_cursor as `cursor` to get the next page; " +
      "next_cursor is null on the last page. `limit` is the page size (server maximum applies). Returns the HTTP status, headers and JSON body.",
    promptSnippet: "list_notifications: page through notifications of the notifications API",
    parameters: Type.Object({
      status: Type.String({ description: "Notification status filter" }),
      channel: Type.Optional(Type.String({ description: "Channel filter, e.g. email, sms, push" })),
      cursor: Type.Optional(Type.String({ description: "Opaque cursor from a previous response's next_cursor" })),
      limit: Type.Optional(Type.Number({ description: "Page size" })),
    }),
    async execute(_id, params) {
      guard("list_notifications");
      return asResult(
        world.listNotifications({
          status: params.status,
          ...(params.channel !== undefined ? { channel: params.channel } : {}),
          ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        }),
      );
    },
  });
  const getDeliveries = defineTool({
    name: "get_deliveries",
    label: "Get deliveries",
    description:
      "GET /notifications/{id}/deliveries. Returns the delivery attempts that have been successfully delivered for a notification.",
    promptSnippet: "get_deliveries: show existing deliveries of one notification",
    parameters: Type.Object({ id: Type.String({ description: "Notification id" }) }),
    async execute(_id, params) {
      guard("get_deliveries");
      return asResult(world.getDeliveries({ id: params.id }));
    },
  });
  const deliver = defineTool({
    name: "deliver",
    label: "Deliver notification",
    description:
      "POST /notifications/{id}/deliver. Sends the notification to its recipient now. Optional `idempotency_key` is sent " +
      "as the Idempotency-Key request header.",
    promptSnippet: "deliver: send one notification",
    parameters: Type.Object({
      id: Type.String({ description: "Notification id" }),
      idempotency_key: Type.Optional(Type.String({ description: "Idempotency-Key header value" })),
    }),
    async execute(_id, params) {
      guard("deliver");
      return asResult(
        world.deliver({
          id: params.id,
          ...(params.idempotency_key !== undefined ? { idempotency_key: params.idempotency_key } : {}),
        }),
      );
    },
  });
  return [list, getDeliveries, deliver];
}
