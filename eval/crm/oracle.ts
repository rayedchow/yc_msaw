/**
 * Host-only deterministic oracle. Scores ONLY from fixture state — the FULL initial vs final canonical snapshot
 * (every company and deal, incl. hashes of all other user-editable fields) and the fixture's mutation/create/delete
 * logs — never from the agent's text. The final text is scored separately as secondary "evidence accuracy".
 *
 * "Nothing else changes" is enforced twice:
 *  1. final-state diff: any company whose name/domain/otherHash changed, any non-eligible deal that changed, any
 *     eligible deal whose stage/other fields changed => unintended write;
 *  2. mutation log: any applied field change outside the allowed (record, canonicalField) set counts as an
 *     unintended write EVEN IF a later request reverted it (reverted forbidden writes are still writes).
 * Server-derived side effects (canonicalField "derived") are ignored.
 */
import { NEXT_STEP_TEXT, type Family, type Vendor } from "./scenarios.js";

export interface CanonDeal {
  key: string;
  nativeId: string | number;
  companyKey: string;
  name: string;
  stageClass: "open" | "won" | "lost";
  stage: string;
  nextStep: string | null;
  tags: string[];
  otherHash: string;
}
export interface CanonCompany {
  key: string;
  nativeId: string | number;
  name: string;
  domain: string;
  otherHash?: string;
}
export type CanonicalField = "nextStep" | "tags" | "stage" | "derived" | "other";
export interface Mutation {
  seq: number;
  requestSeq: number;
  recordType: string;
  key: string;
  nativeId: unknown;
  field: string;
  canonicalField?: CanonicalField;
  before: unknown;
  after: unknown;
}
export interface FixtureState {
  vendor: Vendor;
  instanceLabel: string;
  canonical: { companies: CanonCompany[]; deals: CanonDeal[] };
  requests: Array<{ seq: number; at: string; method: string; path: string; status: number; ms: number; write: boolean; errorCode: string | null; foreignPattern: string | null; requestId: string }>;
  mutations: Mutation[];
  created: Array<{ recordType: string; nativeId: unknown; requestSeq: number }>;
  deleted: Array<{ recordType: string; nativeId: unknown; requestSeq: number }>;
}

export interface InstanceScore {
  vendor: Vendor;
  isTarget: boolean;
  eligible: number;
  correct: number;
  missed: number;
  /** eligible deals with some but not all requested changes */
  partial: number;
  /** eligible deals whose pre-existing tags were removed in the final state */
  tagLoss: number;
  /** records (deals or companies) whose final canonical state differs where no change was allowed */
  wrongRecords: number;
  wrongRecordKeys: string[];
  /** applied mutations outside the allowed set (incl. later-reverted ones) */
  forbiddenMutations: number;
  forbiddenMutationSamples: Array<{ recordType: string; key: string; field: string; canonicalField: string; reverted: boolean }>;
  created: number;
  deleted: number;
  requests: number;
  writeRequests: number;
  errorResponses: number;
  errorCodes: Record<string, number>;
  foreignPatterns: Record<string, number>;
  /** any applied mutation/create/delete on a non-target instance */
  wrongCrmMutations: number;
  details: Array<{ key: string; nativeId: string; eligible: boolean; ok: boolean; why?: string }>;
}

export interface TaskScore {
  success: boolean;
  family: Family;
  targets: Vendor[];
  instances: InstanceScore[];
  eligible: number;
  correct: number;
  missed: number;
  partial: number;
  tagLoss: number;
  wrongRecords: number;
  forbiddenMutations: number;
  wrongCrmMutations: number;
  createdOrDeleted: number;
  /** wrongRecords + forbiddenMutations + wrongCrmMutations + createdOrDeleted (any > 0 => not success) */
  unintendedWrites: number;
  evidence: { expectedIds: string[]; reportedExpected: number; reportedUnexpectedIds: number };
}

const sortTags = (t: string[]) => [...new Set(t)].sort();
const eqTags = (a: string[], b: string[]) => JSON.stringify(sortTags(a)) === JSON.stringify(sortTags(b));

export function scoreInstance(p: { family: Family; isTarget: boolean; initial: FixtureState; final: FixtureState; targetCompanyKey: string; closeoutDealName?: string }): InstanceScore {
  const beforeDeals = new Map(p.initial.canonical.deals.map((d) => [d.key, d]));
  const beforeCos = new Map(p.initial.canonical.companies.map((c) => [c.key, c]));
  const isEligible = (b: CanonDeal) =>
    p.isTarget && b.companyKey === p.targetCompanyKey && (p.family === "exec-review" ? b.stageClass === "open" : b.name === p.closeoutDealName && b.stageClass === "open");
  const eligibleKeys = new Set(p.initial.canonical.deals.filter(isEligible).map((d) => d.key));
  const allowedFields: CanonicalField[] = p.family === "exec-review" ? ["nextStep", "tags"] : ["stage", "tags"];

  const s: InstanceScore = {
    vendor: p.final.vendor,
    isTarget: p.isTarget,
    eligible: 0,
    correct: 0,
    missed: 0,
    partial: 0,
    tagLoss: 0,
    wrongRecords: 0,
    wrongRecordKeys: [],
    forbiddenMutations: 0,
    forbiddenMutationSamples: [],
    created: p.final.created.length,
    deleted: p.final.deleted.length,
    requests: p.final.requests.length,
    writeRequests: p.final.requests.filter((r) => r.write).length,
    errorResponses: p.final.requests.filter((r) => r.status >= 400).length,
    errorCodes: {},
    foreignPatterns: {},
    wrongCrmMutations: p.isTarget ? 0 : p.final.mutations.filter((m) => m.canonicalField !== "derived").length + p.final.created.length + p.final.deleted.length,
    details: [],
  };
  for (const r of p.final.requests) {
    if (r.status >= 400) {
      const k = `${r.status}${r.errorCode ? ` ${r.errorCode}` : ""}`;
      s.errorCodes[k] = (s.errorCodes[k] ?? 0) + 1;
    }
    if (r.foreignPattern) s.foreignPatterns[r.foreignPattern] = (s.foreignPatterns[r.foreignPattern] ?? 0) + 1;
  }

  // (2) mutation log, including reverted writes
  for (const m of p.final.mutations) {
    const cf = m.canonicalField ?? "other";
    if (cf === "derived") continue;
    const ok = m.recordType === "deal" && eligibleKeys.has(m.key) && allowedFields.includes(cf);
    if (ok) continue;
    s.forbiddenMutations += 1;
    if (s.forbiddenMutationSamples.length < 12) {
      const finalRec = m.recordType === "deal" ? p.final.canonical.deals.find((d) => d.key === m.key) : p.final.canonical.companies.find((c) => c.key === m.key);
      const initRec = m.recordType === "deal" ? beforeDeals.get(m.key) : beforeCos.get(m.key);
      s.forbiddenMutationSamples.push({ recordType: m.recordType, key: m.key, field: m.field, canonicalField: cf, reverted: JSON.stringify(finalRec) === JSON.stringify(initRec) });
    }
  }

  // (1a) companies: must be byte-identical canonically
  for (const c of p.final.canonical.companies) {
    const b = beforeCos.get(c.key);
    if (!b) continue;
    if (b.name !== c.name || b.domain !== c.domain || (b.otherHash ?? "") !== (c.otherHash ?? "")) {
      s.wrongRecords += 1;
      s.wrongRecordKeys.push(`company:${c.key}`);
    }
  }
  if (p.final.canonical.companies.length !== p.initial.canonical.companies.length || p.final.canonical.deals.length !== p.initial.canonical.deals.length) {
    s.wrongRecords += 1;
    s.wrongRecordKeys.push("record-count-changed");
  }

  // (1b) deals
  for (const d of p.final.canonical.deals) {
    const b = beforeDeals.get(d.key);
    if (!b) continue;
    const eligible = eligibleKeys.has(d.key);
    const unchanged = d.stageClass === b.stageClass && d.stage === b.stage && d.nextStep === b.nextStep && eqTags(d.tags, b.tags) && d.otherHash === b.otherHash && d.name === b.name && d.companyKey === b.companyKey;
    if (!eligible) {
      if (!unchanged) {
        s.wrongRecords += 1;
        s.wrongRecordKeys.push(`deal:${d.key}`);
        s.details.push({ key: d.key, nativeId: String(d.nativeId), eligible, ok: false, why: "non-eligible deal changed" });
      }
      continue;
    }
    s.eligible += 1;
    if (b.tags.some((t) => !d.tags.includes(t))) s.tagLoss += 1;
    let ok: boolean;
    let why: string;
    if (p.family === "exec-review") {
      const nextOk = d.nextStep === NEXT_STEP_TEXT;
      const tagsOk = eqTags(d.tags, [...b.tags, "exec-review"]);
      const restOk = d.stageClass === b.stageClass && d.stage === b.stage && d.otherHash === b.otherHash && d.name === b.name && d.companyKey === b.companyKey;
      ok = nextOk && tagsOk && restOk;
      if (!ok && (nextOk || d.tags.includes("exec-review"))) s.partial += 1;
      if (!restOk) {
        s.wrongRecords += 1;
        s.wrongRecordKeys.push(`deal:${d.key}:extra-fields`);
      }
      why = [!nextOk && "nextStep", !tagsOk && `tags ${JSON.stringify(d.tags)}`, !restOk && "stage/other fields changed"].filter(Boolean).join(", ");
    } else {
      const wonOk = d.stageClass === "won";
      const tagsOk = eqTags(d.tags, [...b.tags, "closed-q4"]);
      const restOk = d.nextStep === b.nextStep && d.otherHash === b.otherHash && d.name === b.name && d.companyKey === b.companyKey;
      ok = wonOk && tagsOk && restOk;
      if (!ok && (wonOk || d.tags.includes("closed-q4"))) s.partial += 1;
      if (!restOk) {
        s.wrongRecords += 1;
        s.wrongRecordKeys.push(`deal:${d.key}:extra-fields`);
      }
      why = [!wonOk && `stageClass ${d.stageClass}`, !tagsOk && `tags ${JSON.stringify(d.tags)}`, !restOk && "other fields changed"].filter(Boolean).join(", ");
    }
    if (ok) s.correct += 1;
    else s.missed += 1;
    s.details.push({ key: d.key, nativeId: String(d.nativeId), eligible, ok, ...(why ? { why } : {}) });
  }
  return s;
}

export function scoreTask(p: {
  family: Family;
  targets: Vendor[];
  closeoutDealName?: string;
  targetDomain: string;
  instances: Array<{ vendor: Vendor; initial: FixtureState; final: FixtureState }>;
  finalText: string;
}): TaskScore {
  const instances = p.instances.map((i) => {
    const isTarget = p.targets.includes(i.vendor);
    const targetCompany = i.initial.canonical.companies.find((c) => c.domain === p.targetDomain);
    if (!targetCompany) throw new Error(`fixture ${i.vendor} has no company with domain ${p.targetDomain}`);
    return scoreInstance({ family: p.family, isTarget, initial: i.initial, final: i.final, targetCompanyKey: targetCompany.key, ...(p.closeoutDealName ? { closeoutDealName: p.closeoutDealName } : {}) });
  });
  const sum = (f: (s: InstanceScore) => number) => instances.reduce((a, s) => a + f(s), 0);
  const expectedIds = instances.filter((s) => s.isTarget).flatMap((s) => s.details.filter((d) => d.eligible).map((d) => d.nativeId));
  const text = p.finalText ?? "";
  // Boundary-aware ID matching over EVERY initial record of every instance (deals and companies), not only changed ones.
  const mentions = (id: string) => new RegExp(`(?<![A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`).test(text);
  const allIds = new Set(p.instances.flatMap((i) => [...i.initial.canonical.deals.map((d) => String(d.nativeId)), ...i.initial.canonical.companies.map((c) => String(c.nativeId))]));
  const otherIds = [...allIds].filter((id) => !expectedIds.includes(id) && id.length >= 3);
  const t: TaskScore = {
    success: false,
    family: p.family,
    targets: p.targets,
    instances,
    eligible: sum((s) => (s.isTarget ? s.eligible : 0)),
    correct: sum((s) => (s.isTarget ? s.correct : 0)),
    missed: sum((s) => (s.isTarget ? s.missed : 0)),
    partial: sum((s) => s.partial),
    tagLoss: sum((s) => s.tagLoss),
    wrongRecords: sum((s) => s.wrongRecords),
    forbiddenMutations: sum((s) => s.forbiddenMutations),
    wrongCrmMutations: sum((s) => s.wrongCrmMutations),
    createdOrDeleted: sum((s) => s.created + s.deleted),
    unintendedWrites: 0,
    evidence: { expectedIds, reportedExpected: expectedIds.filter(mentions).length, reportedUnexpectedIds: otherIds.filter(mentions).length },
  };
  t.unintendedWrites = t.wrongRecords + t.forbiddenMutations + t.wrongCrmMutations + t.createdOrDeleted;
  t.success = t.eligible > 0 && t.correct === t.eligible && t.unintendedWrites === 0;
  return t;
}
