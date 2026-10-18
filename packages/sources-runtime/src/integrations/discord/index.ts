import type { AqueductIntegration } from "../types.js";
import { connectDiscord, disconnectDiscord } from "./connect.js";
import { runDiscordSync } from "./sync.js";

/** Discord over the official bot API (see connect.ts for the authentication adaptation from the donor). */
export const discordIntegration: AqueductIntegration = {
  id: "discord",
  connect: (input) => connectDiscord(input),
  disconnect: (input) => disconnectDiscord(input),
  taskKinds: () => ["discord.sync"],
  taskHandlers: () => ({
    // The tenant is the queued task's own tenant, never a payload field.
    "discord.sync": async (_payload, ctx) => {
      const r = await runDiscordSync(ctx.task.tenantId);
      return { connections: r.connections, channels: r.channels.map((c) => `${c.channelId}:${c.status}`) };
    },
  }),
};
