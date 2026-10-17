/**
 * Procedural memory parent MCP — mcp-use entry (deployed to Manufact).
 * `mcp-use start|dev` imports the default-exported MCPServer and calls listen()
 * itself (PORT/HOST from the environment). Configuration is environment-driven;
 * see .env.example and README.
 */
import { createApp } from "./src/app.js";

const app = await createApp();
console.error(`[procmem] auth=${app.auth.mode} store=${app.config.store} sandbox=${app.config.sandbox}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Terminate customer sandboxes before exit; durable state lives in the object store.
    void app.workspaces.closeAll().finally(() => process.exit(0));
  });
}

export default app.server;
