/**
 * Google Docs fidelity fix F3: the donor OT reverse-engineering notes and research harnesses (gigabrain 5448774)
 * are preserved byte-for-byte under docs/research/google-docs-ot/ (8 scripts with a private doc ID literal
 * replaced), and stay outside the product runtime.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../..");
const DIR = join(ROOT, "docs/research/google-docs-ot");
const manifest = JSON.parse(readFileSync(join(DIR, "MANIFEST.json"), "utf8")) as {
  donorRepo: string;
  donorCommit: string;
  files: Array<{ path: string; donorPath: string; status: "verbatim" | "patched"; sha256: string; donorSha256: string }>;
};
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("F3: preserved Google Docs OT research", () => {
  it("records every preserved file against the pinned donor commit", () => {
    expect(manifest.donorRepo).toBe("askshepherd/gigabrain");
    expect(manifest.donorCommit).toMatch(/^5448774e[0-9a-f]{32}$/);
    const onDisk = walk(DIR).map((f) => relative(DIR, f)).filter((f) => f !== "MANIFEST.json" && f !== "PRESERVATION.md").sort();
    expect(manifest.files.map((f) => f.path).sort()).toEqual(onDisk);
    expect(manifest.files.filter((f) => f.path.endsWith(".md"))).toHaveLength(15);
    expect(manifest.files.filter((f) => f.path.startsWith("scripts/"))).toHaveLength(22);
  });

  it("keeps notes and unpatched scripts byte-identical to the donor; exactly the 8 doc-ID scripts and the README (e-mails) differ", () => {
    for (const f of manifest.files) {
      expect(sha(join(DIR, f.path)), f.path).toBe(f.sha256);
      if (f.status === "verbatim") expect(f.sha256, f.path).toBe(f.donorSha256);
      else expect(f.sha256, f.path).not.toBe(f.donorSha256);
    }
    expect(manifest.files.filter((f) => f.status === "patched").map((f) => f.path).sort()).toEqual([
      "README.md",
      "scripts/check-latest-entries.ts", "scripts/check-session-tokens.ts", "scripts/check-undo-rvrt.ts", "scripts/test-dc-ops.ts",
      "scripts/test-last-chunks.ts", "scripts/test-nm-parsing.ts", "scripts/test-nm-standalone.ts", "scripts/test-op-types.ts",
    ]);
  });

  it("contains no Drive file IDs or credentials", () => {
    for (const f of manifest.files) {
      const text = readFileSync(join(DIR, f.path), "utf8");
      expect(text, f.path).not.toMatch(/["'`]1[A-Za-z0-9_-]{40,45}["'`]/); // Google Drive file ID literal
      expect(text, f.path).not.toMatch(/ya29\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{30,}/);
      if (f.status === "patched" && f.path.endsWith(".ts")) expect(text).toContain('(process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID")');
      expect(text, f.path).not.toMatch(/@askshepherd\.ai|ishanramrakhiani@/);
    }
  });

  it("is outside the product runtime: not compiled, not imported, not a test", () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as { include: string[] };
    expect(tsconfig.include.some((p) => p.startsWith("docs"))).toBe(false);
    for (const file of walk(join(ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
      // Import specifiers only (comments may cite the notes).
      expect(readFileSync(file, "utf8"), relative(ROOT, file)).not.toMatch(/(?:from\s*|import\s*\(\s*)["'][^"']*(?:docs\/research|google-docs-ot)/);
    }
    expect(manifest.files.some((f) => f.path.endsWith(".test.ts"))).toBe(false);
  });
});
