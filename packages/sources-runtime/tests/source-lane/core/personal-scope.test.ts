import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  boundOwnerCoverage,
  inScopeDirs,
  isScopeTenantId,
  personalSegment,
  scopeLocalPath,
  scopePublicPath,
  scopeTenantIdOf,
} from "../../../src/source-lane/core/personal-scope.js";
import type { CoverageReport } from "../../../src/source-lane/core/types.js";
import { TENANT_RE } from "../../../src/source-lane/internal/app.js";

/** Pure contracts of personal owner scopes (personal-connection-attribution). Synthetic data only. */
const YC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("personal owner scopes", () => {
  const who = { tenantNs: "t-0123456789abcdef0123", issuer: "https://issuer.test", subject: "user_bob" };
  const seg = personalSegment(who);
  const scope = { scopeTenantId: scopeTenantIdOf(who.tenantNs, seg), parentTenantId: who.tenantNs, segment: seg };

  it("derives an unaddressable scope tenant and a segment no provider layout can produce", () => {
    expect(seg).toMatch(/^@u-[0-9a-f]{24}$/);
    expect(personalSegment(who)).toBe(seg);
    expect(personalSegment({ ...who, subject: "user_carol" })).not.toBe(seg);
    expect(scope.scopeTenantId).toBe(`${who.tenantNs}.${seg.slice(1)}`);
    expect(TENANT_RE.test(scope.scopeTenantId)).toBe(false); // no internal route can name it
    expect(isScopeTenantId(scope.scopeTenantId)).toBe(true);
    expect(isScopeTenantId(who.tenantNs)).toBe(false);
  });

  it("publishes only the scope's personal directories, under its segment, and maps back", () => {
    const pub = scopePublicPath(scope, "sources/granola/_raw/tenant/meeting_note:n1/2026-10/granola:n1:1.json");
    expect(pub).toBe(`sources/granola/${seg}/_raw/tenant/meeting_note:n1/2026-10/granola:n1:1.json`);
    expect(scopeLocalPath(scope, pub)).toBe("sources/granola/_raw/tenant/meeting_note:n1/2026-10/granola:n1:1.json");
    expect(scopeLocalPath(scope, "sources/granola/Legacy-meeting-1/summary.md")).toBeNull();
    expect(() => scopePublicPath(scope, "sources/gmail/bob@acme.test/x.md")).toThrow();
    expect(() => scopePublicPath(scope, "sources/notion/index.md")).toThrow();
    expect(inScopeDirs("sources/imessage/Mom/2026-10.md")).toBe(true);
    expect(inScopeDirs("sources/slack/C1/x.md")).toBe(false);
  });

  it("keeps a heartbeat inside yc_msaw's status-report limits however many members connect accounts", async () => {
    const { StatusReportSchema } = await import(pathToFileURL(path.join(YC_ROOT, "src/sources/http.ts")).href);
    const org: CoverageReport[] = Array.from({ length: 40 }, (_, i) => ({ provider: "jira", scope: `site:s${i}`, state: "complete", reason: "x".repeat(400) }));
    const scoped: CoverageReport[] = [];
    for (let m = 0; m < 300; m++) {
      const owner = `owner:${personalSegment({ ...who, subject: `user_${m}` })}/`;
      for (const p of ["granola", "zoom", "imessage"]) {
        for (const s of ["credential", "inventory", "poll", "export"]) scoped.push({ provider: p, scope: `${owner}${s}`, state: m === 7 && s === "poll" ? "blocked" : "complete", reason: "r".repeat(300), lastSuccessAt: "2026-10-18T10:00:00.000Z" });
      }
    }
    const bounded = boundOwnerCoverage(org, scoped);
    expect(bounded.slice(0, org.length)).toEqual(org); // the organization's reports are whole and first
    expect(bounded.length).toBeLessThanOrEqual(480);
    expect(Buffer.byteLength(JSON.stringify({ providers: bounded }), "utf8")).toBeLessThan(256 * 1024);
    expect(() => StatusReportSchema.parse({ providers: bounded, runtime: { version: "t" } })).not.toThrow();
    const member7 = bounded.filter((r) => r.scope.startsWith(`owner:${personalSegment({ ...who, subject: "user_7" })}/`));
    expect(member7.find((r) => r.provider === "granola")).toMatchObject({ state: "blocked", scope: expect.stringMatching(/\/summary$/) });
    expect(member7.find((r) => r.provider === "granola")!.reason).toContain("poll");
    // Small enough: nothing is summarized.
    expect(boundOwnerCoverage(org.slice(0, 2), scoped.slice(0, 8))).toEqual([...org.slice(0, 2), ...scoped.slice(0, 8)]);
  });
});
