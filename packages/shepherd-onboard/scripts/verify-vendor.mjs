#!/usr/bin/env node
/**
 * Integrity check for the vendored Mac uploader (vendor.json):
 *  - every vendored file hashes to its recorded sha256;
 *  - `verbatim` files equal their donor hash;
 *  - `patched` files, with their recorded patches reversed, equal their donor hash byte for byte (so the shipped
 *    file is exactly donor + the listed patches, nothing else);
 *  - each patch file hashes to its recorded sha256;
 *  - runtime dependencies are exact versions and the lockfile pins them with integrity hashes.
 * Needs git (patches are reversed with `git apply`). Exit code 1 and a list of problems on any mismatch.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const readVendor = (pkgDir = PACKAGE_DIR) => JSON.parse(readFileSync(path.join(pkgDir, "vendor.json"), "utf8"));

/**
 * Writes the donor bytes of every vendored file under `dir` (same relative paths), by copying the shipped files
 * and reversing the recorded patches. `dir` must not be inside a git work tree's index scope; git is told not to
 * look above it.
 */
export function materializeDonor(dir, vendor = readVendor(), pkgDir = PACKAGE_DIR) {
  for (const f of vendor.files) {
    mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    copyFileSync(path.join(pkgDir, f.path), path.join(dir, f.path));
  }
  for (const p of [...vendor.patches].reverse()) {
    execFileSync("git", ["apply", "-R", path.join(pkgDir, p.path)], {
      cwd: dir,
      stdio: "pipe",
      // Treat `dir` as a plain directory even when it sits inside this repository's work tree.
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
    });
  }
  return dir;
}

export function verifyVendor(pkgDir = PACKAGE_DIR) {
  const vendor = readVendor(pkgDir);
  const errors = [];
  if (!/^[0-9a-f]{40}$/.test(vendor.donor?.commit ?? "")) errors.push("vendor.json: donor.commit must be a full 40-hex sha");
  for (const f of vendor.files) {
    const file = path.join(pkgDir, f.path);
    if (!existsSync(file)) {
      errors.push(`${f.path}: missing`);
      continue;
    }
    const sha = sha256(file);
    if (sha !== f.sha256) errors.push(`${f.path}: sha256 ${sha} != recorded ${f.sha256}`);
    if (f.status === "verbatim" && f.sha256 !== f.donorSha256) errors.push(`${f.path}: verbatim but recorded sha differs from donor`);
    if (f.status === "patched" && !(f.patches ?? []).length) errors.push(`${f.path}: patched without a recorded patch`);
  }
  for (const p of vendor.patches) {
    const file = path.join(pkgDir, p.path);
    if (!existsSync(file)) errors.push(`${p.path}: missing`);
    else if (sha256(file) !== p.sha256) errors.push(`${p.path}: sha256 ${sha256(file)} != recorded ${p.sha256}`);
  }
  if (!errors.length) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shepherd-onboard-donor-"));
    try {
      materializeDonor(dir, vendor, pkgDir);
      for (const f of vendor.files) {
        const sha = sha256(path.join(dir, f.path));
        if (sha !== f.donorSha256) errors.push(`${f.path}: shipped file minus its patches hashes ${sha}, donor is ${f.donorSha256}`);
      }
    } catch (e) {
      errors.push(`reversing patches failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const lockFile = path.join(pkgDir, "package-lock.json");
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")) : null;
  if (!lock) errors.push("package-lock.json: missing");
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) errors.push(`package.json: ${name} must be an exact version (got ${version})`);
    const entry = lock?.packages?.[`node_modules/${name}`];
    if (lock && (!entry || entry.version !== version || !/^sha512-/.test(entry.integrity ?? ""))) errors.push(`package-lock.json: ${name}@${version} not pinned with an integrity hash`);
  }
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    if (vendor.dependencies?.[name] !== version) errors.push(`vendor.json: dependency ${name} recorded as ${vendor.dependencies?.[name]}, package.json has ${version}`);
  }
  return { ok: errors.length === 0, errors, files: vendor.files.length, patches: vendor.patches.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = verifyVendor();
  if (!r.ok) {
    console.error(`vendored Mac uploader integrity check FAILED:\n- ${r.errors.join("\n- ")}`);
    process.exit(1);
  }
  const v = readVendor();
  console.log(`vendored Mac uploader OK: ${r.files} file(s) from ${v.donor.repo}@${v.donor.commit} (${r.patches} patch(es) reverse to the donor bytes)`);
}
