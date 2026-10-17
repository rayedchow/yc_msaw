// Host-owned file operations on one integration repo, executed as the AGENT uid
// so the OS (not this script) is the final authority on what is writable: the
// working tree is agent-owned, .git / dependencies / harness are root-owned.
// The host already validated the repo-relative path; this script additionally
// refuses symlinked components and anything resolving outside the repo.
// Input JSON on stdin; one JSON result object on stdout.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const req = JSON.parse(fs.readFileSync(0, "utf8"));
const repo = req.repo;
// Pre-baked deps / build output are skipped at the repo root. A ".git" entry anywhere is
// reported (the real git dir lives outside the worktree; any .git here is agent-made).
const SKIP = new Set(["node_modules", ".mcp-use"]);

function done(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
function bad(code, message) {
  done({ ok: false, code, message });
}

function resolveSafe(rel, { mustExist } = {}) {
  const parts = rel === "" ? [] : rel.split("/");
  let cur = repo;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === "ENOENT") {
        if (mustExist) bad("not_found", `No such file or directory: ${rel}`);
        return path.join(repo, ...parts);
      }
      throw e;
    }
    if (st.isSymbolicLink()) bad("symlink_refused", `Path component is a symlink: ${parts.slice(0, i + 1).join("/")}`);
    if (i < parts.length - 1 && !st.isDirectory()) bad("not_a_directory", `${parts.slice(0, i + 1).join("/")} is not a directory`);
  }
  return cur;
}

function walk(dir, rel, out, limit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) return;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (rel === "" && SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.name === ".git") out.push({ path: r, type: "nested-git" });
    else if (e.isSymbolicLink()) out.push({ path: r, type: "symlink", target: fs.readlinkSync(abs) });
    else if (e.isDirectory()) walk(abs, r, out, limit); else if (e.isFile()) out.push({ path: r, type: "file", bytes: fs.statSync(abs).size });
    else out.push({ path: r, type: "other" });
  }
}

try {
  switch (req.op) {
    case "list": {
      const start = resolveSafe(req.path ?? "", { mustExist: true });
      if (!fs.statSync(start).isDirectory()) bad("not_a_directory", `${req.path} is not a directory`);
      const entries = [];
      walk(start, req.path ?? "", entries, req.limit ?? 2000);
      done({ ok: true, entries, truncated: entries.length >= (req.limit ?? 2000) });
      break;
    }
    case "read": {
      const abs = resolveSafe(req.path, { mustExist: true });
      const st = fs.statSync(abs);
      if (!st.isFile()) bad("not_a_file", `${req.path} is not a regular file`);
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const max = Math.min(req.maxBytes ?? 256 * 1024, 1024 * 1024);
        const buf = Buffer.alloc(Math.min(st.size, max));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        done({ ok: true, bytes: st.size, truncated: st.size > n, base64: buf.subarray(0, n).toString("base64") });
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    case "write": {
      const abs = resolveSafe(req.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o755 });
      resolveSafe(req.path); // re-check components after mkdir
      const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
      try {
        fs.writeSync(fd, Buffer.from(req.base64, "base64"));
      } finally {
        fs.closeSync(fd);
      }
      done({ ok: true, bytes: Buffer.from(req.base64, "base64").length });
      break;
    }
    case "delete": {
      const abs = resolveSafe(req.path, { mustExist: true });
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) fs.rmSync(abs, { recursive: true });
      else fs.unlinkSync(abs);
      // prune empty parents (not the repo root)
      let dir = path.dirname(abs);
      while (dir.startsWith(repo + path.sep) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      }
      done({ ok: true });
      break;
    }
    case "scan": {
      // Whole-tree policy scan (including ignored paths except node_modules/.mcp-use at the root).
      const entries = [];
      walk(repo, "", entries, 20_000);
      const symlinks = entries.filter((e) => e.type === "symlink").map((e) => e.path);
      const nestedGit = entries.filter((e) => e.type === "nested-git").map((e) => e.path);
      const special = entries.filter((e) => e.type === "other").map((e) => e.path);
      const files = entries.filter((e) => e.type === "file");
      const gitmodules = files.some((f) => f.path === ".gitmodules" || f.path.endsWith("/.gitmodules"));
      const gitattributes = files.filter((f) => f.path === ".gitattributes" || f.path.endsWith("/.gitattributes")).map((f) => f.path);
      const large = files.filter((f) => f.bytes > (req.maxFileBytes ?? 1024 * 1024)).map((f) => f.path);
      done({ ok: true, fileCount: files.length, totalBytes: files.reduce((a, f) => a + f.bytes, 0), symlinks, nestedGit, special, gitmodules, gitattributes, large, truncated: entries.length >= 20_000 });
      break;
    }
    case "hash": {
      // Content hash of an exact-tree checkout: sha256 over sorted "path\0sha256(content)\n" lines.
      // Optional root-level exclusions for host-generated outputs (e.g. mcp-env.d.ts).
      const exclude = new Set(Array.isArray(req.exclude) ? req.exclude : []);
      const entries = [];
      walk(repo, "", entries, 50_000);
      for (let i = entries.length - 1; i >= 0; i--) if (exclude.has(entries[i].path)) entries.splice(i, 1);
      if (entries.some((e) => e.type !== "file")) bad("unexpected_entry", `Checkout contains non-regular files: ${entries.filter((e) => e.type !== "file").map((e) => e.path).slice(0, 5).join(", ")}`);
      const lines = entries
        .map((e) => `${e.path}\0${createHash("sha256").update(fs.readFileSync(path.join(repo, e.path))).digest("hex")}\n`)
        .sort();
      done({ ok: true, files: entries.length, sha256: createHash("sha256").update(lines.join("")).digest("hex") });
      break;
    }
    default:
      bad("unknown_op", `Unknown op ${req.op}`);
  }
} catch (e) {
  bad(e.code === "EACCES" || e.code === "EPERM" ? "permission_denied" : "fs_error", String(e.message ?? e));
}
