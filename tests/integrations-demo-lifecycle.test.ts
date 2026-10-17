// Deterministic lifecycle checks for the real-demo producer (pure helpers; no live script, no evidence files).
import { describe, expect, it } from "vitest";
import { finalizeAgentRows, harnessStatusToDemo, TERMINAL_STATUSES, type DemoAgentRow } from "../scripts/real-integration-e2e-render.js";

const HARNESS_STATUSES = ["running", "completed", "failed", "budget_exhausted", "cancelled", "aborted"] as const;

describe("demo lifecycle", () => {
  it("maps every harness AgentStatus without inventing success (same mapping feeds state and events)", () => {
    expect(Object.fromEntries(HARNESS_STATUSES.map((s) => [s, harnessStatusToDemo(s)]))).toEqual({
      running: "running",
      completed: "succeeded",
      failed: "failed",
      budget_exhausted: "partial",
      cancelled: "interrupted",
      aborted: "interrupted",
    });
    for (const s of ["published", "succeeded", undefined, null, "weird"]) expect(harnessStatusToDemo(s)).toBe("unknown");
    for (const s of HARNESS_STATUSES) if (s !== "completed") expect(harnessStatusToDemo(s)).not.toBe("succeeded");
  });

  const rows = (): DemoAgentRow[] => [
    { id: "host", name: "host", role: "operator", status: "running" },
    { id: "builder", name: "builder", role: "operator", status: "running" },
    { id: "customer", name: "pi", role: "customer", status: "waiting", task: { attempt: 2, status: "succeeded", startedAt: "t" } },
    { id: "root", name: "root", role: "build", status: harnessStatusToDemo("completed") },
    { id: "child-1", parentId: "root", name: "c1", role: "build", status: harnessStatusToDemo("budget_exhausted") },
    { id: "child-2", parentId: "root", name: "c2", role: "build", status: "running" },
    { id: "child-3", parentId: "root", name: "c3", role: "build", status: "pending" },
  ];

  it("normal finish: no active rows remain, terminal statuses preserved, customer closes with its last task outcome", () => {
    const out = finalizeAgentRows(rows(), false, true);
    for (const r of out) expect(TERMINAL_STATUSES.has(r.status)).toBe(true);
    expect(Object.fromEntries(out.map((r) => [r.id, r.status]))).toEqual({ host: "succeeded", builder: "unknown", customer: "succeeded", root: "succeeded", "child-1": "partial", "child-2": "unknown", "child-3": "unknown" });
  });

  it("a waiting customer after a failed attempt is not ended as success; a failed run fails the host", () => {
    const r = rows();
    r[2]!.task = { attempt: 1, status: "failed", startedAt: "t" };
    const out = finalizeAgentRows(r, false, false);
    expect(out.find((x) => x.id === "customer")!.status).toBe("failed");
    expect(out.find((x) => x.id === "host")!.status).toBe("failed");
  });

  it("abort: active rows become interrupted (including a running customer task), others unknown", () => {
    const r = rows();
    r[2] = { id: "customer", name: "pi", role: "customer", status: "running", task: { attempt: 2, status: "running", startedAt: "t" } };
    const out = finalizeAgentRows(r, true, false, () => "end");
    const by = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(by.customer!.status).toBe("interrupted");
    expect(by.customer!.task).toEqual({ attempt: 2, status: "interrupted", startedAt: "t", finishedAt: "end" });
    expect(by["child-2"]!.status).toBe("interrupted");
    expect(by["child-3"]!.status).toBe("unknown");
    expect(by.root!.status).toBe("succeeded");
    expect(by.host!.status).toBe("failed");
  });
});
