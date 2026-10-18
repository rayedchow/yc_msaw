import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SourceViewer } from "../src/sources/access.js";
import { SourceService } from "../src/sources/service.js";
import { DirectoryObjectStore } from "../src/store/objects.js";

/**
 * Owner evidence is cached per tenant (bindings, owners, runtime reports are object-store reads on every MCP call).
 * A change made by this process applies at once; one made by another replica applies within the 5 s TTL.
 */
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("owner evidence cache", () => {
  it("applies local changes at once and other replicas' changes within the TTL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sources-viewer-cache-"));
    dirs.push(dir);
    let now = Date.parse("2026-10-18T12:00:00Z");
    const objects = new DirectoryObjectStore(dir);
    const a = new SourceService(objects, () => new Date(now));
    const b = new SourceService(objects, () => new Date(now));
    const alice = { subject: "user_alice", issuer: "https://issuer.test" };
    expect((await a.viewer("acme", alice)).access("granola/x.md")).toBe("deny");
    await a.owners.claim("acme", "granola", alice, { hasUnownedData: false });
    expect((await a.viewer("acme", alice)).access("granola/x.md")).toBe("allow"); // same process: immediate
    await b.bindings.create("acme", { kind: "device", providers: ["imessage"], transport: "runtime-ingest" }, alice);
    expect((await a.viewer("acme", alice)).access("imessage/x.md")).toBe("deny"); // other replica: cached
    now += 5_001;
    expect((await a.viewer("acme", alice)).access("imessage/x.md")).toBe("allow");
  });
});

describe("Google-wide paths", () => {
  const alice = { subject: "user_alice", issuer: "https://issuer.test" };
  const owned = { account: "alice@acme.test", subject: "user_alice", issuer: "https://issuer.test" };
  it("are served per unit the caller's proven mailboxes can read, never by owning every account", () => {
    // Owning every reported Google account no longer unlocks Docs/Drive: only attributed units do.
    const only = new SourceViewer(alice, { providerOwners: new Map(), googleAccounts: [owned] });
    expect(only.access("google-docs/Plan-doc-1/document.md")).toBe("deny");
    expect(only.access("gmail")).toBe("mixed"); // a mailbox container is always filtered per mailbox
    const units = [
      { path: "google-docs/Plan-doc-1", revisions: true },
      { path: "binary/drive-pdf/f1", revisions: true },
      { path: "google-docs/Viewer-doc-2", revisions: false },
    ];
    const attributed = new SourceViewer(alice, { providerOwners: new Map(), googleAccounts: [owned, { account: "dwd@acme.test", subject: null, issuer: null }], googleUnits: units });
    expect(attributed.access("google-docs/Plan-doc-1/document.md")).toBe("allow");
    expect(attributed.access("binary/drive-pdf/f1/current.pdf")).toBe("allow");
    // A unit the mailbox can only view carries history it may not see: withheld.
    expect(attributed.access("google-docs/Viewer-doc-2/document.md")).toBe("deny");
    expect(attributed.access("google-docs/Someone-elses-doc-3/document.md")).toBe("deny");
    expect(attributed.access("gmail/alice@acme.test/messages/x.md")).toBe("allow");
  });

  it("matches coverage to whole addresses only", () => {
    const an = new SourceViewer({ subject: "an", issuer: "i" }, { providerOwners: new Map(), googleAccounts: [{ account: "an@x.test", subject: "an", issuer: "i" }, { account: "dan@x.test", subject: "dan", issuer: "i" }] });
    expect(an.coverageVisible("gmail", { scope: "mailbox:an@x.test" })).toBe(true);
    expect(an.coverageVisible("gmail", { scope: "mailbox:dan@x.test" })).toBe(false);
    expect(an.coverageVisible("gmail", { scope: "mailbox:an@x.test", reason: "shared with dan@x.test" })).toBe(false);
  });

  it("denies providers nobody declared shared, unless the operator lists them", () => {
    const v = new SourceViewer(alice, { providerOwners: new Map(), googleAccounts: [] });
    expect(v.access("outlook/conn/1/message.json")).toBe("deny");
    expect(v.access("jira/ACME/ACME-1.md")).toBe("allow");
    expect(v.access("binary/slack/F1/current.pdf")).toBe("deny");
    expect(new SourceViewer(alice, { providerOwners: new Map(), googleAccounts: [], sharedProviders: ["outlook-org"] }).access("outlook-org/x.json")).toBe("allow");
  });
});
