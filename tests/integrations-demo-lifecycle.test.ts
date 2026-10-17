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

describe("demo evidence extraction (raw results only)", () => {
  const sha = "e43507d88d2e7545f54724fea6509ba00f40f57d";
  const bigText = "x".repeat(41_000) + "npx create-mcp-use-app my-server";
  const raw = {
    content: [{ type: "text", text: `mcp-use/mcp-use/README.md@v1.5.0 (sha ${sha}):\n${bigText}` }],
    details: { structuredContent: { owner: "mcp-use", repo: "mcp-use", path: "README.md", ref: "v1.5.0", sha, size: 19725, text: bigText, truncated: false, github: { status: 200, requestId: "C5DC:1", rateLimitRemaining: "59" } } },
  };
  const hex = (s: string) => `len${s.length}`;

  it("a ~41k structured tool payload keeps its metadata and passes the proof", async () => {
    const { extractGithubFileEvidence, githubProofOk } = await import("../scripts/real-integration-e2e-render.js");
    const e = extractGithubFileEvidence(raw, hex);
    expect(JSON.stringify(raw).length).toBeGreaterThan(41_000);
    expect(e).toMatchObject({ sha, ref: "v1.5.0", githubStatus: 200, requestId: "C5DC:1", textChars: bigText.length });
    expect(githubProofOk(e, { ref: "v1.5.0", sha }, { owner: "mcp-use", repo: "mcp-use", path: "README.md", ref: "v1.5.0" })).toBe(true);
  });

  it("bounded previews, text-only results, wrong ref/args or non-200 are rejected", async () => {
    const { extractGithubFileEvidence, githubProofOk } = await import("../scripts/real-integration-e2e-render.js");
    const preview = { truncated: true, originalChars: 41_500, preview: JSON.stringify(raw).slice(0, 30_000) };
    expect(extractGithubFileEvidence(preview)).toBeNull();
    expect(extractGithubFileEvidence({ details: preview })).toBeNull();
    expect(extractGithubFileEvidence({ content: raw.content })).toBeNull(); // text mentions the sha, but text is not evidence
    const e = extractGithubFileEvidence(raw)!;
    expect(githubProofOk(e, { ref: "v1.5.0", sha }, { ref: "main" })).toBe(false);
    expect(githubProofOk(e, { ref: "v1.5.0", sha: "0".repeat(40) }, { ref: "v1.5.0" })).toBe(false);
    expect(githubProofOk({ ...e, githubStatus: 404 }, { ref: "v1.5.0", sha }, { ref: "v1.5.0" })).toBe(false);
    expect(githubProofOk({ ...e, requestId: "" }, { ref: "v1.5.0", sha }, { ref: "v1.5.0" })).toBe(false);
    expect(githubProofOk(null, { ref: "v1.5.0", sha }, { ref: "v1.5.0" })).toBe(false);
  });
});

describe("demo event payload bounding", () => {
  it("keeps call identity on a ~41k payload while the payload stays bounded and scrubbed", async () => {
    const { boundEventData } = await import("../scripts/real-integration-e2e-render.js");
    const SECRET = "sk-live-SECRET-0123456789abcdef";
    const scrub = (s: string) => s.split(SECRET).join("[REDACTED]");
    const data = {
      callId: "call_65de0e5681684206ba9b7a3d",
      tool: "integration__github-read__read_file",
      source: "Pi tool_execution_end (live)",
      attempt: 2,
      evidence: { sha: "e43507d8", ref: "v1.5.0", githubStatus: 200, requestId: "C5DC:1" },
      details: { text: "y".repeat(41_000), leaked: SECRET },
      // not allowlisted: must not be lifted out of the bounded preview
      authorization: `Bearer ${SECRET}`,
      nested: { callId: "should-not-replace" },
    };
    const out = boundEventData(data, 12_000, scrub) as Record<string, unknown>;
    expect(out).toMatchObject({ callId: data.callId, tool: data.tool, source: data.source, attempt: 2, truncated: true, evidence: data.evidence });
    expect(out.originalChars).toBeGreaterThan(41_000);
    expect(String(out.preview).length).toBeLessThanOrEqual(12_001);
    expect(out).not.toHaveProperty("details");
    expect(out).not.toHaveProperty("authorization");
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out).length).toBeLessThan(13_000);
  });

  it("small payloads pass through unchanged (scrubbed); identity values are capped and scrubbed", async () => {
    const { boundEventData } = await import("../scripts/real-integration-e2e-render.js");
    const scrub = (s: string) => s.replaceAll("TOPSECRET", "[REDACTED]");
    expect(boundEventData({ callId: "c1", args: { ref: "v1.5.0" } }, 12_000, scrub)).toEqual({ callId: "c1", args: { ref: "v1.5.0" } });
    const big = boundEventData({ callId: `TOPSECRET${"z".repeat(500)}`, blob: "q".repeat(20_000) }, 1000, scrub) as Record<string, unknown>;
    expect(String(big.callId)).toMatch(/^\[REDACTED\]z+$/);
    expect(String(big.callId).length).toBe(200);
  });
});
