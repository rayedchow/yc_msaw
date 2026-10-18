import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DECLARED_OVERRIDES, DONOR, PACKAGE_ROOT, readManifest, sha256File } from "../../../scripts/provenance.js";

/**
 * Core-owned provenance invariants. The full tree check (including integration agents'
 * recorded patches) is `npm run provenance:check`, run after their records are merged.
 */
const CORE_DONOR_ROOTS = ["src/queue/", "src/outbox/", "src/db/", "src/mirror/", "src/integrations/nango/", "src/integrations/atlassian/", "src/integrations/registry.ts", "src/env.ts", "src/graph/bridge/"];

describe("provenance manifest", () => {
  const manifest = readManifest();

  it("pins the donor commit", () => {
    expect(manifest.donor).toEqual(DONOR);
  });

  it("keeps core-owned shared donor files byte-identical to the donor", () => {
    const inRoots = manifest.files.filter((f) => f.donorSha256 && CORE_DONOR_ROOTS.some((r) => f.path.startsWith(r)));
    expect(inRoots.length).toBeGreaterThanOrEqual(39);
    // Shared donor files change only through coordinator-applied patch requests declared in DECLARED_OVERRIDES.
    expect(inRoots.filter((f) => f.status !== "verbatim" && !DECLARED_OVERRIDES[f.path]).map((f) => f.path)).toEqual([]);
    const shared = inRoots.filter((f) => f.status === "verbatim");
    const changed = shared.filter((f) => sha256File(path.join(PACKAGE_ROOT, f.path)) !== f.donorSha256);
    expect(changed.map((f) => f.path)).toEqual([]);
  });

  it("records exactly the declared shims and core-applied patches, each with a reason and test", () => {
    for (const status of ["shim", "patched"] as const) {
      const declared = Object.entries(DECLARED_OVERRIDES).filter(([, o]) => o.status === status).map(([p]) => p).sort();
      const recorded = manifest.files.filter((f) => f.status === status && DECLARED_OVERRIDES[f.path]).map((f) => f.path).sort();
      expect(recorded, status).toEqual(declared);
    }
    for (const f of manifest.files.filter((x) => DECLARED_OVERRIDES[x.path])) {
      expect(f.reason).toBeTruthy();
      expect(f.test ?? f.tests?.[0]).toBeTruthy();
      expect(sha256File(path.join(PACKAGE_ROOT, f.path))).toBe(f.sha256);
      const text = readFileSync(path.join(PACKAGE_ROOT, f.path), "utf8");
      expect(text).toContain(f.status === "shim" ? "SOURCE-LANE SHIM" : "SOURCE-LANE PATCH");
    }
  });
});
