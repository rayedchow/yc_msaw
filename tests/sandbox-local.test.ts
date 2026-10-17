import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_EXEC_ERROR, LocalLease } from "../src/sandbox/local.js";
import { assertSandboxPath } from "../src/sandbox/modal.js";

describe("LocalLease", () => {
  it("maps sandbox paths, protects trees, never executes", async () => {
    const lease = await LocalLease.create();
    try {
      expect(() => lease.hostPath("relative")).toThrow();
      expect(() => lease.hostPath("/a/../b")).toThrow();
      await lease.writeFiles([{ path: "/memory/knowledge/a/b.md", content: "x" }]);
      await lease.protectTree("/memory/knowledge");
      await expect(fs.writeFile(lease.hostPath("/memory/knowledge/a/b.md"), "y")).rejects.toMatchObject({ code: "EACCES" });
      await lease.makeAgentDir("/work/scratch");
      await lease.agentFs.writeFile("/work/scratch/n.txt", "hi");
      expect((await lease.agentFs.readFile("/work/scratch/n.txt", { maxBytes: 10 })).data.toString()).toBe("hi");
      await fs.symlink(lease.hostPath("/memory/knowledge/a/b.md"), lease.hostPath("/work/scratch/link.md"));
      await expect(lease.agentFs.writeFile("/work/scratch/link.md", "pwn")).rejects.toThrow(/symlink/);
      await expect(lease.exec(["id"], { user: "agent", timeoutMs: 1000 })).rejects.toThrow(LOCAL_EXEC_ERROR);
      await expect(lease.start(["id"], { user: "agent", timeoutMs: 1000 })).rejects.toThrow(LOCAL_EXEC_ERROR);
    } finally {
      await lease.terminate();
      await lease.terminate();
    }
    await expect(fs.stat(lease.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("modal sandbox paths must be absolute and normalized", () => {
    expect(assertSandboxPath("/memory/knowledge")).toBe("/memory/knowledge");
    for (const bad of ["memory", "/a/../b", "/a//b", "/a/\u0000", "/"]) expect(() => assertSandboxPath(bad)).toThrow();
  });
});
