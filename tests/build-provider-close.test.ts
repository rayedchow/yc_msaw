/**
 * Integration runtime close() must not be reported as a success when the
 * runtime says bundle persistence or sandbox termination failed.
 * Agent turns are the scripted FIXTURE client; the runtime is a fake.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runMemoryBuild } from "../src/harness/daily.js";
import { createIntegrationToolProviders } from "../src/harness/integration-provider.js";
import { createProfileRegistry } from "../src/harness/profiles.js";
import { ToolError } from "../src/harness/tools.js";
import { localWorkspaceFactory } from "../src/harness/workspace.js";
import { defineTool, succeeded } from "../src/integrations/types.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { fixtureInputs, scripted, tempRepo } from "./build-fixture.js";

function fakeRuntimeModule(closeResult: { persisted: string[]; errors: string[] }) {
  const calls = { close: 0 };
  const runtime = {
    tools: [
      defineTool({
        name: "integration_list",
        description: "List integrations (fake).",
        scope: "builder-workspace",
        authority: "fake runtime",
        mutates: false,
        input: z.object({}),
        run: async () => succeeded({ integrations: [] }),
      }),
    ],
    instructions: "fake runtime instructions",
    close: async () => {
      calls.close++;
      return closeResult;
    },
  };
  return { calls, loadModule: async () => ({ createIntegrationRuntime: () => runtime }) };
}

const store = new DirectoryObjectStore("/tmp/procmem-provider-close-unused");

describe("integration provider close", () => {
  it("throws an explicit error (with what was persisted) when the runtime reports close errors", async () => {
    const fake = fakeRuntimeModule({ persisted: ["notify-hub"], errors: ["bundle upload for billing-api failed: volume unavailable"] });
    const [reg] = await createIntegrationToolProviders({ ns: "t-close", store, buildId: "bld-close-1", loadModule: fake.loadModule, log: () => undefined });
    const error = await reg!.provider.close!().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("integration_close_failed");
    expect((error as Error).message).toContain("persisted: notify-hub");
    expect((error as Error).message).toContain("bundle upload for billing-api failed");
  });

  it("returns the persisted repos on a clean close", async () => {
    const fake = fakeRuntimeModule({ persisted: ["notify-hub"], errors: [] });
    const [reg] = await createIntegrationToolProviders({ ns: "t-close", store, buildId: "bld-close-3", loadModule: fake.loadModule, log: () => undefined });
    await expect(reg!.provider.close!()).resolves.toEqual({ persisted: ["notify-hub"] });
    // Closing twice is a no-op, the runtime is closed exactly once.
    await reg!.provider.close!();
    expect(fake.calls.close).toBe(1);
  });

  it("records a failed providerClose in the build receipt instead of ok:true", async () => {
    const fake = fakeRuntimeModule({ persisted: [], errors: ["sandbox terminate timed out"] });
    const toolProviders = await createIntegrationToolProviders({ ns: "t-close", store, buildId: "bld-close-4", loadModule: fake.loadModule, log: () => undefined });
    const repo = await tempRepo();
    const run = scripted({ root: [[{ name: "publish", args: { summary: "no change" } }]] });
    const receipt = await runMemoryBuild({
      repo,
      inputs: fixtureInputs(),
      sources: ["traces-test"],
      profiles: createProfileRegistry(),
      clientFactory: run.factory,
      workspaceFactory: localWorkspaceFactory,
      toolProviders,
    });
    expect(receipt.providerClose).toHaveLength(1);
    expect(receipt.providerClose[0]).toMatchObject({ id: "integrations", ok: false });
    expect(receipt.providerClose[0]!.error).toContain("sandbox terminate timed out");
  });
});
