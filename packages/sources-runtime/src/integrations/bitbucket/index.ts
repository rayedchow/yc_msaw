import type { AqueductIntegration } from "../types.js";
import { disconnectNangoProvider, nangoConnectForProvider } from "../nango/connect.js";
import { registerNangoTasks } from "../nango/tasks.js";
import { registerNangoHttpRoutes } from "../nango/webhook.js";
import { registerBitbucketProcessors } from "./processors.js";

registerBitbucketProcessors();

export const bitbucketIntegration: AqueductIntegration = {
  id: "bitbucket",
  connect: nangoConnectForProvider("bitbucket"),
  registerHttp: registerNangoHttpRoutes,
  taskKinds() {
    return [];
  },
  taskHandlers() {
    return registerNangoTasks();
  },
  disconnect(input) {
    return disconnectNangoProvider({ tenantId: input.tenantId, provider: "bitbucket" });
  },
};
