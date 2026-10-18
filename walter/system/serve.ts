/** Local HTTP server for the GurtAI system: `npx tsx walter/system/serve.ts [port]` (token from GURTAI_TOKEN). */
import http from "node:http";
import { GurtaiSystem } from "./gurtai.js";

export function startSystemServer(token: string, port = 0): Promise<{ url: string; close: () => Promise<void>; system: GurtaiSystem }> {
  const system = new GurtaiSystem(token);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    let body: unknown;
    if (req.method === "POST" || req.method === "PATCH") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
    }
    const out = system.handle({ method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization ?? null });
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, system, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startSystemServer(process.env.GURTAI_TOKEN ?? "dev-token", Number(process.argv[2] ?? 4410));
  console.log(`GurtAI system on ${s.url}`);
}
