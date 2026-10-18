import { describe, expect, it, vi } from "vitest";
import { disconnectAllGoogleAccounts } from "../../../src/integrations/google/connect.js";
import { googleIntegration } from "../../../src/integrations/google/index.js";
import { defaultRegistry } from "../../../src/source-lane/registry.js";

/** Regressions for core-applied patch requests to shared donor files (PROVENANCE status "patched"). */
describe("shared donor patches", () => {
  it("google: tenant disconnect revokes provider grants (google-auth patch 5)", () => {
    // The internal DELETE /tenants/:t/connections/google route calls integration.disconnect first.
    expect(googleIntegration.disconnect).toBe(disconnectAllGoogleAccounts);
  });

  it("registry: google-auth is registered without claiming any event source or mirror root (google-auth patch 1)", () => {
    const r = defaultRegistry();
    expect(r.get("google-auth")).toBeTruthy();
    expect(r.get("google-auth")!.eventSources).toEqual([]);
    expect(r.forEventSource("gdocs")?.id).toBe("google-docs");
    expect(r.forMirrorPath("sources/gmail/x.md")?.id).toBe("gmail");
  });

  it("registry: google-contacts is registered next to calendar without claiming event sources (calendar-contacts patch 1)", () => {
    const r = defaultRegistry();
    expect(r.get("google-contacts")?.eventSources).toEqual([]);
    expect(r.get("calendar")).toBeTruthy();
    expect(r.extraTable("google_contact_snapshots")?.provider.id).toBe("google-contacts");
  });

  it("dispatch: google.contacts_sync runs every 15 minutes (calendar-contacts patch 4)", async () => {
    vi.resetModules();
    const schedules: Array<{ kind: string; frequencySeconds: number }> = [];
    vi.doMock("../../../src/queue/sweeper.js", () => ({ upsertTaskSchedule: async (s: { kind: string; frequencySeconds: number }) => void schedules.push(s) }));
    vi.doMock("../../../src/graph/wiring/default-kb.js", () => ({ ensureDefaultKbForTenant: async () => ({ kbId: null, attachedProviders: [] }) }));
    const { startGooglePolling } = await import("../../../src/queue/dispatch.js");
    await startGooglePolling("t1");
    expect(schedules.find((s) => s.kind === "google.contacts_sync")?.frequencySeconds).toBe(900);
    vi.doUnmock("../../../src/queue/sweeper.js");
    vi.doUnmock("../../../src/graph/wiring/default-kb.js");
  });
});
