import type { AqueductIntegration } from "../types.js";
import { disconnectNangoProvider, nangoConnectForProvider } from "../nango/connect.js";
import { registerNangoTasks } from "../nango/tasks.js";
import { registerNangoHttpRoutes } from "../nango/webhook.js";
import { registerAtlassianProcessors } from "./processors.js";

registerAtlassianProcessors();

export const jiraIntegration: AqueductIntegration = {
  id: "jira",
  connect: nangoConnectForProvider("jira"),
  registerHttp: registerNangoHttpRoutes,
  taskKinds() {
    return [];
  },
  taskHandlers() {
    return registerNangoTasks();
  },
  disconnect(input) {
    return disconnectNangoProvider({ tenantId: input.tenantId, provider: "jira" });
  },
};

export const confluenceIntegration: AqueductIntegration = {
  id: "confluence",
  connect: nangoConnectForProvider("confluence"),
  registerHttp: registerNangoHttpRoutes,
  taskKinds() {
    return [];
  },
  taskHandlers() {
    return registerNangoTasks();
  },
  disconnect(input) {
    return disconnectNangoProvider({ tenantId: input.tenantId, provider: "confluence" });
  },
};
