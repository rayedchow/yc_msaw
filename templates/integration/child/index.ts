import { MCPServer } from "mcp-use";
import { childAuthFromEnv, verifyBearer } from "./src/auth.ts";
import { registerTools } from "./src/tools.ts";

const server = new MCPServer({
  name: "{{slug}}",
  title: "{{title}}",
  version: "0.1.0",
  description: "{{description}}",
});

// Direct child endpoint auth (host-owned contract): parent-minted EdDSA bearer tokens.
// Production without auth configuration fails closed; local dev/tests run open.
const auth = childAuthFromEnv();
if (auth || process.env.NODE_ENV === "production") {
  server.use("/mcp", async (c, next) => {
    if (!auth) return c.json({ error: "auth_not_configured" }, 503);
    const v = verifyBearer(auth, c.req.header("authorization"));
    if (!v.ok) return c.json({ error: "unauthorized", reason: v.reason }, 401, { "www-authenticate": 'Bearer realm="{{slug}}"' });
    await next();
  });
}

registerTools(server);

export default server;
