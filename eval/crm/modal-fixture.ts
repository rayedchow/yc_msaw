/**
 * SYNTHETIC CRM CONTRACT FIXTURE served from a Modal sandbox behind an encrypted tunnel, so children deployed on
 * Manufact (real cloud) can reach it. Same fixture code as the validation harness and the local matrix
 * (templates/integration/harness/fixtures/crm-fixture.mjs + crm/*.mjs). Only the host holds the bearer and the admin
 * token; the oracle reads /__state over the tunnel with the admin header.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ModalClient } from "modal";
import { REPO, registerSecret, type RunningFixture } from "./infra.js";
import type { Vendor } from "./scenarios.js";

const PORT = 8080;

async function execIn(sandbox: Awaited<ReturnType<ModalClient["sandboxes"]["create"]>>, argv: string[], stdin?: Buffer): Promise<number> {
  const proc = await sandbox.exec(argv, { mode: "binary", timeoutMs: 120_000 });
  const w = proc.stdin.getWriter();
  try {
    if (stdin?.byteLength) await w.write(new Uint8Array(stdin));
    await w.close();
  } catch {
    /* ignore */
  }
  const drain = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader();
    for (;;) if ((await r.read()).done) break;
  };
  await Promise.all([drain(proc.stdout as unknown as ReadableStream<Uint8Array>), drain(proc.stderr as unknown as ReadableStream<Uint8Array>)]).catch(() => undefined);
  return await proc.wait();
}

export async function startModalFixture(vendor: Vendor, seed: string, spec: unknown, tag: string): Promise<RunningFixture & { sandboxId: string; tunnelUrl: string }> {
  const token = `fx_${randomBytes(18).toString("hex")}`;
  const adminToken = randomBytes(18).toString("hex");
  registerSecret(token);
  registerSecret(adminToken);
  const client = new ModalClient();
  const app = await client.apps.fromName("procmem-crm-bench-fixtures", { createIfMissing: true });
  const image = client.images.fromRegistry("node:22-slim");
  const sandbox = await client.sandboxes.create(app, image, { encryptedPorts: [PORT], timeoutMs: 4 * 3600_000, cpu: 0.5, memoryMiB: 512, workdir: "/", tags: { component: "crm-contract-fixture", vendor, bench: tag } });
  try {
    const root = path.join(REPO, "templates/integration/harness/fixtures");
    const files = ["crm-fixture.mjs", ...(await fs.readdir(path.join(root, "crm"))).filter((f) => f.endsWith(".mjs")).map((f) => `crm/${f}`)];
    for (const f of files) {
      const code = await execIn(sandbox, ["sh", "-c", `mkdir -p "$(dirname /fx/${f})" && cat > /fx/${f}`], await fs.readFile(path.join(root, f)));
      if (code !== 0) throw new Error(`writing ${f} into the fixture sandbox failed (${code})`);
    }
    const cfg = Buffer.from(JSON.stringify({ port: PORT, host: "0.0.0.0", token, adminToken, vendor, seed, spec }));
    if ((await execIn(sandbox, ["sh", "-c", "cat > /fx/config.json && chmod 600 /fx/config.json"], cfg)) !== 0) throw new Error("writing fixture config failed");
    await sandbox.exec(["sh", "-c", "cd /fx && nohup node crm-fixture.mjs < /fx/config.json > /fx/fixture.log 2>&1 &"], { timeoutMs: 30_000 }).then((p) => p.wait());
    const tunnels = await sandbox.tunnels(60_000);
    const url = tunnels[PORT]!.url.replace(/\/+$/, "");
    const state = async () => {
      const r = await fetch(`${url}/__state`, { headers: { "x-fixture-admin": adminToken }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`fixture state HTTP ${r.status}`);
      return r.json();
    };
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await state();
        break;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`modal fixture ${vendor} never became ready: ${String((e as Error).message)}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return {
      vendor,
      url,
      tunnelUrl: url,
      sandboxId: sandbox.sandboxId,
      token,
      adminToken,
      state,
      close: async () => {
        await sandbox.terminate().catch(() => undefined);
      },
    };
  } catch (e) {
    await sandbox.terminate().catch(() => undefined);
    throw e;
  }
}
