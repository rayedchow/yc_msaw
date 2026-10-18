// Host-owned SYNTHETIC CRM CONTRACT FIXTURE (HubSpot / Pipedrive / Zoho / Attio subsets) — stdin wrapper.
// Config arrives on stdin (never argv/env): {port, token, adminToken, vendor, seed, spec, host?}.
// Listens on cfg.host (default 127.0.0.1; "0.0.0.0" for Modal tunnels) and prints `fixture listening <port>`.
// All logic lives in ./crm/server.mjs (importable without side effects). Not a vendor certification.
import { createCrmFixture } from "./crm/server.mjs";

const input = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => resolve(buf));
});
const cfg = JSON.parse(input || "{}");
const fx = createCrmFixture({
  vendor: String(cfg.vendor),
  seed: String(cfg.seed ?? ""),
  spec: cfg.spec,
  token: String(cfg.token ?? ""),
  adminToken: String(cfg.adminToken ?? ""),
});
const listener = await fx.listen(Number(cfg.port ?? 0), typeof cfg.host === "string" && cfg.host ? cfg.host : "127.0.0.1");
process.stdout.write(`fixture listening ${listener.port}\n`);
const stop = () => Promise.resolve(listener.close()).then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
