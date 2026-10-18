import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM helper without types
import { PACKAGE_DIR, readVendor, verifyVendor } from "../scripts/verify-vendor.mjs";

/** The vendored uploader is exactly the pinned donor plus the recorded patches, and tampering is detected. */

let scratch: string | null = null;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function copyPackage(): string {
  scratch = mkdtempSync(path.join(os.tmpdir(), "shepherd-onboard-vendor-"));
  for (const entry of ["bin", "assets", "patches", "tests/donor", "source-selection.cjs", "wiki-readiness.cjs", "vendor.json", "package.json", "package-lock.json"]) {
    cpSync(path.join(PACKAGE_DIR, entry), path.join(scratch, entry), { recursive: true });
  }
  return scratch;
}

describe("vendored Mac uploader pin", () => {
  it("matches vendor.json: donor commit, hashes, patches that reverse to the donor bytes, exact dependency pins", () => {
    const result = verifyVendor();
    expect(result.errors).toEqual([]);
    const vendor = readVendor();
    expect(vendor.donor).toMatchObject({ repo: "askshepherd/gigabrain", commit: "5448774e0a121570666adaa0c8ca18570df72be9", path: "packages/shepherd-onboard" });
    expect(vendor.files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["bin/shepherd-onboard.js", "source-selection.cjs", "wiki-readiness.cjs"]));
  });

  it("the shipped CLI differs from the donor only in the coding-sessions source_sync scan and its receipt", () => {
    const patch = readFileSync(path.join(PACKAGE_DIR, "patches", "0001-coding-sessions-source-sync-full-inventory.patch"), "utf8");
    expect(patch.match(/^@@ .*$/gm)).toEqual([
      expect.stringContaining("function codingSessionsCommandScanOptions(command)"),
      expect.stringContaining("function codingSessionsSourceSyncReceipt({"),
    ]);
  });

  it("fails when a vendored byte, a patch or a dependency pin changes", () => {
    const dir = copyPackage();
    expect(verifyVendor(dir).ok).toBe(true);

    const cli = path.join(dir, "bin", "shepherd-onboard.js");
    const original = readFileSync(cli, "utf8");
    writeFileSync(cli, original.replace("exhaustive: true,\n      ...(payload.fullInventory === false", "exhaustive: false,\n      ...(payload.fullInventory === false"));
    expect(verifyVendor(dir).errors.join("\n")).toMatch(/bin\/shepherd-onboard\.js: sha256 .* != recorded/);
    writeFileSync(cli, original);

    const pkgFile = path.join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    pkg.dependencies["@photon-ai/imessage-kit"] = "^3.0.0";
    writeFileSync(pkgFile, JSON.stringify(pkg));
    expect(verifyVendor(dir).errors.join("\n")).toMatch(/@photon-ai\/imessage-kit must be an exact version/);
  });
});
