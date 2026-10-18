import type { AqueductIntegration } from "../types.js";
import { disconnectNangoProvider, nangoConnectForProvider } from "../nango/connect.js";
import { registerNangoTasks } from "../nango/tasks.js";
import { registerNangoHttpRoutes } from "../nango/webhook.js";
import { registerGithubProcessors } from "./processors.js";

registerGithubProcessors();

export const githubIntegration: AqueductIntegration = {
  id: "github",
  connect: nangoConnectForProvider("github"),
  registerHttp: registerNangoHttpRoutes,
  taskKinds() {
    return [];
  },
  taskHandlers() {
    return registerNangoTasks();
  },
  disconnect(input) {
    return disconnectNangoProvider({ tenantId: input.tenantId, provider: "github" });
  },
};
