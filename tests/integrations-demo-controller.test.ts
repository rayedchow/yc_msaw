// Deterministic regressions for the real-demo feedback-loop controller (pure; no cloud, no evidence files).
import { describe, expect, it } from "vitest";
import { classifyAttempt, classifyBuildCycle, finalVerdict, nextStep, type AttemptObservation } from "../scripts/real-integration-e2e-controller.js";

const base: AttemptObservation = { promptError: null, traceDelivered: true, toolAvailable: true, integrationToolErrors: [], proofOk: false, answerHasFact: false, verifierError: null };
const okBuild = classifyBuildCycle({ status: "published", error: null, newDeployment: true, newMemoryRevision: true });

describe("feedback-loop controller", () => {
  it("a real integration 404 is fed to a build; success stops the loop", () => {
    const fail = classifyAttempt({ ...base, integrationToolErrors: [{ status: 404, message: "No commit found for the ref master" }] });
    expect(fail).toMatchObject({ outcome: "failed", failureClass: "integration", feedToBuild: true });
    expect(nextStep(fail, 0, 3, null)).toEqual({ action: "build_then_retry", cycle: 1 });
    const ok = classifyAttempt({ ...base, proofOk: true, answerHasFact: true });
    expect(nextStep(ok, 1, 3, okBuild)).toMatchObject({ action: "stop", verdict: "succeeded" });
  });

  it("a genuine post-repair failure gets another real build cycle, bounded by the budget", () => {
    const fail = classifyAttempt({ ...base, integrationToolErrors: [{ status: 500, message: "internal_error: cannot read properties" }] });
    expect(fail.feedToBuild).toBe(true);
    expect(nextStep(fail, 1, 3, okBuild)).toEqual({ action: "build_then_retry", cycle: 2 });
    expect(nextStep(fail, 2, 3, okBuild)).toEqual({ action: "build_then_retry", cycle: 3 });
    expect(nextStep(fail, 3, 3, okBuild)).toMatchObject({ action: "stop", verdict: "failed", blockedBy: "budget" });
  });

  it("never asks the LLM to fix infra, auth, quota, trace delivery or host verifier problems", () => {
    for (const o of [
      { ...base, promptError: "Fireworks HTTP 503 overloaded" },
      { ...base, traceDelivered: false },
      { ...base, toolAvailable: false },
      { ...base, verifierError: "GitHub truth unavailable (403 rate limit)" },
      { ...base, integrationToolErrors: [{ status: 429, message: "API rate limit exceeded" }] },
      { ...base, integrationToolErrors: [{ status: 403, message: "API rate limit exceeded for 1.2.3.4" }] },
    ]) {
      const c = classifyAttempt(o);
      expect(c.feedToBuild).toBe(false);
      expect(["infra", "verifier"]).toContain(c.failureClass);
      expect(nextStep(c, 0, 3, null)).toMatchObject({ action: "stop", verdict: "failed" });
    }
  });

  it("agent-level misses are fed (memory/procedure), wrong-answer with good proof too", () => {
    expect(classifyAttempt(base)).toMatchObject({ failureClass: "agent", feedToBuild: true });
    expect(classifyAttempt({ ...base, proofOk: true })).toMatchObject({ failureClass: "agent", feedToBuild: true });
  });

  it("stops honestly when a build fails on infra or changes nothing", () => {
    const fail = classifyAttempt({ ...base, integrationToolErrors: [{ status: 404, message: "x" }] });
    const infraBuild = classifyBuildCycle({ status: "failed", error: "provider HTTP 429 quota", newDeployment: false, newMemoryRevision: false });
    expect(infraBuild).toMatchObject({ ok: false, infra: true });
    expect(nextStep(fail, 1, 3, infraBuild)).toMatchObject({ verdict: "failed", blockedBy: "infra" });
    const noChange = classifyBuildCycle({ status: "no_change", error: null, newDeployment: false, newMemoryRevision: false });
    expect(nextStep(fail, 1, 3, noChange)).toMatchObject({ verdict: "failed", blockedBy: "no_change" });
    const agentBuildFail = classifyBuildCycle({ status: "failed", error: "validation_failed: 3 case(s) failed", newDeployment: false, newMemoryRevision: false });
    expect(nextStep(fail, 1, 3, agentBuildFail)).toMatchObject({ verdict: "failed", blockedBy: "build" });
  });

  it("final verdict follows the final validated attempt plus invariants, not earlier failed attempts", () => {
    const ok = classifyAttempt({ ...base, proofOk: true, answerHasFact: true });
    expect(finalVerdict({ finalAttempt: ok, invariants: { sameSession: true }, finalChecks: { memoryReopened: true } })).toEqual({ ok: true, failing: [] });
    expect(finalVerdict({ finalAttempt: ok, invariants: { sameSession: false }, finalChecks: {} })).toEqual({ ok: false, failing: ["sameSession"] });
    const bad = classifyAttempt({ ...base, integrationToolErrors: [{ status: 404, message: "x" }] });
    expect(finalVerdict({ finalAttempt: bad, invariants: {}, finalChecks: {} }).ok).toBe(false);
    expect(finalVerdict({ finalAttempt: null, invariants: {}, finalChecks: {} }).failing).toEqual(["finalAttempt.succeeded"]);
  });
});

describe("upstream infra vs repairable child errors", () => {
  it("identifiable upstream outage/throttle text is infra even without a status; internal MCP 500 stays repairable", async () => {
    const { classifyAttempt, isUpstreamInfraError } = await import("../scripts/real-integration-e2e-controller.js");
    const base = { promptError: null, traceDelivered: true, toolAvailable: true, proofOk: false, answerHasFact: false, verifierError: null };
    for (const m of ["API rate limit exceeded for 1.2.3.4", "fetch failed: ECONNRESET", "getaddrinfo ENOTFOUND api.github.com", "GitHub error 503: Service Unavailable"]) {
      expect(isUpstreamInfraError({ status: null, message: m })).toBe(true);
      expect(classifyAttempt({ ...base, integrationToolErrors: [{ status: null, message: m }] })).toMatchObject({ failureClass: "infra", feedToBuild: false });
    }
    expect(classifyAttempt({ ...base, integrationToolErrors: [{ status: 502, message: "Bad Gateway" }] }).failureClass).toBe("infra");
    expect(classifyAttempt({ ...base, integrationToolErrors: [{ status: 500, message: "internal_error: Cannot read properties of undefined" }] })).toMatchObject({ failureClass: "integration", feedToBuild: true });
    expect(classifyAttempt({ ...base, integrationToolErrors: [{ status: 404, message: "GitHub error 404: No commit found for the ref master" }] })).toMatchObject({ failureClass: "integration", feedToBuild: true });
    // A mix of infra and a real defect is still a real defect worth a build.
    expect(classifyAttempt({ ...base, integrationToolErrors: [{ status: 503, message: "x" }, { status: 404, message: "No commit found" }] }).failureClass).toBe("integration");
  });
});

describe("file coalescing and mechanism proof", () => {
  it("keeps the original before and latest after per path across cycles", async () => {
    const { upsertFile } = await import("../scripts/real-integration-e2e-controller.js");
    const files: Parameters<typeof upsertFile>[0] = [];
    const f = (before: string | null, after: string | null) => ({ path: "mcps/x/src/github.ts", kind: "source" as const, before, after, beforeSha256: before, afterSha256: after, truncated: false });
    upsertFile(files, f("v0", "v1"), 1);
    upsertFile(files, f("v1", "v2"), 2);
    upsertFile(files, { ...f(null, "m1"), path: "memory/a.md", kind: "memory" }, 2);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ before: "v0", after: "v2", cycles: [1, 2] });
  });

  it("requires the genuine initial failure plus real source/deployment/memory repair observed automatically", async () => {
    const { mechanismProof } = await import("../scripts/real-integration-e2e-controller.js");
    const good = { cycle: 1, buildOk: true, memoryChanged: true, sourceChanged: true, newDeployment: true, sdkAutomatic: true, piAutomatic: true };
    const first = { failureClass: "integration" as const, outcome: "failed" as const };
    expect(mechanismProof({ prerequisites: { seed: true }, firstAttempt: first, expectedInitialFailure: true, cycles: [good] })).toEqual({ ok: true, failing: [] });
    expect(mechanismProof({ prerequisites: { seed: false }, firstAttempt: first, expectedInitialFailure: true, cycles: [good] }).failing).toContain("prerequisite.seed");
    expect(mechanismProof({ prerequisites: {}, firstAttempt: { failureClass: null, outcome: "succeeded" }, expectedInitialFailure: false, cycles: [] }).failing).toEqual(["initialFailure.genuineSeededIntegrationFailure", "repair.atLeastOneBuildCycle", "repair.integrationSourceAndDeployment", "repair.memoryUpdated"]);
    expect(mechanismProof({ prerequisites: {}, firstAttempt: first, expectedInitialFailure: true, cycles: [{ ...good, sdkAutomatic: false }] }).failing).toEqual(["sdk.automaticObservationOfEveryNewDeployment"]);
    expect(mechanismProof({ prerequisites: {}, firstAttempt: first, expectedInitialFailure: true, cycles: [{ ...good, piAutomatic: false }] }).failing).toEqual(["pi.automaticApplicationOfChangedSchema"]);
    // memory-only cycle after an integration cycle needs no SDK schema wait
    expect(mechanismProof({ prerequisites: {}, firstAttempt: first, expectedInitialFailure: true, cycles: [{ ...good, memoryChanged: false }, { cycle: 2, buildOk: true, memoryChanged: true, sourceChanged: false, newDeployment: false, sdkAutomatic: false, piAutomatic: null }] }).ok).toBe(true);
  });
});
