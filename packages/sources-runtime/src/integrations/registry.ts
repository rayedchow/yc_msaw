import type { Hono } from "hono";
import type { AqueductIntegration } from "./types.js";
import type { TaskHandler } from "../queue/queue.js";
import { googleIntegration } from "./google/index.js";
import { notionIntegration } from "./notion/index.js";
import { granolaIntegration } from "./granola/index.js";
import { confluenceIntegration, jiraIntegration } from "./atlassian/index.js";
import { bitbucketIntegration } from "./bitbucket/index.js";
import { githubIntegration } from "./github/index.js";
import { slackIntegration } from "./slack/index.js";
// SOURCE-LANE PATCH (coordinator, stripe): Stripe connector ported from gigabrain 5448774 (webhook + backfill).
import { stripeIntegration } from "./stripe/index.js";
// SOURCE-LANE PATCH (coordinator, discord): official bot API collector (semantic reference gigabrain discord-personal).
import { discordIntegration } from "./discord/index.js";
// SOURCE-LANE PATCH (coordinator, unipile): WhatsApp/Instagram personal over Unipile (read-only, operator opt-in).
import { instagramPersonalIntegration } from "./instagram-personal/index.js";
import { whatsappPersonalIntegration } from "./whatsapp-personal/index.js";

/**
 * Launch catalog: the mirror-ready sources (gmail + calendar + gdocs live under
 * the google integration; Nango-backed Atlassian/Git providers register their
 * shared task/webhook handlers here). A new integration is additive - add it
 * to this array and implement the AqueductIntegration interface.
 */
export const integrations: AqueductIntegration[] = [
  googleIntegration,
  notionIntegration,
  granolaIntegration,
  jiraIntegration,
  confluenceIntegration,
  bitbucketIntegration,
  githubIntegration,
  slackIntegration,
  stripeIntegration,
  discordIntegration,
  instagramPersonalIntegration,
  whatsappPersonalIntegration,
];

export function registerIntegrationHttpRoutes(app: Hono, list: AqueductIntegration[] = integrations): void {
  for (const integration of list) {
    integration.registerHttp?.(app);
  }
}

export function integrationById(id: string, list: AqueductIntegration[] = integrations): AqueductIntegration | undefined {
  return list.find((integration) => integration.id === id);
}

export function collectIntegrationTaskHandlers(list: AqueductIntegration[] = integrations): Record<string, TaskHandler> {
  const handlers: Record<string, TaskHandler> = {};
  for (const integration of list) {
    Object.assign(handlers, integration.taskHandlers?.() ?? {});
  }
  return handlers;
}

export function startIntegrationRealtime(list: AqueductIntegration[] = integrations): void {
  for (const integration of list) {
    try {
      const started = integration.startRealtime?.();
      if (started && typeof (started as Promise<void>).catch === "function") {
        void (started as Promise<void>).catch((err) => {
          console.error(`[integration:${integration.id}] realtime start failed:`, err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      console.error(`[integration:${integration.id}] realtime start failed:`, err instanceof Error ? err.message : err);
    }
  }
}
