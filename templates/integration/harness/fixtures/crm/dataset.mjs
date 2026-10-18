// SYNTHETIC CRM CONTRACT FIXTURE — canonical vendor-neutral dataset (host-only; never shown to models).
// generateDataset(seed, spec) is deterministic: seeded sha256-counter PRNG, no Math.random.
import { CANONICAL_STAGES, TAG_OPTIONS, createRng, slug } from "./common.mjs";

const PRODUCTS = [
  "Analytics add-on", "Support plan", "Data migration", "Seat expansion", "Onboarding services", "API access tier",
  "Security audit", "Pilot program", "Training package", "Premium SLA", "Integration bundle", "Regional rollout",
  "Compliance module", "Usage overage", "Sandbox licences", "Reporting suite", "Edge connectors", "Archive storage",
];

// Target-relative layout (1-based positions). Open deals at 2, 6, 11, 12 (two beyond the first 10).
const TARGET_LAYOUT = [
  { stage: "won-default", tags: [], nextStep: null },
  { stage: "qualify", tags: ["budget-hold", "legal-review"], nextStep: "Send pricing" },
  { stage: "lost-default", tags: ["at-risk"], nextStep: null },
  { stage: "won-enterprise", tags: ["renewal"], nextStep: "Kickoff scheduled" },
  { stage: "lost-enterprise", tags: [], nextStep: null },
  { stage: "propose", tags: [], nextStep: null },
  { stage: "won-default", tags: [], nextStep: null },
  { stage: "lost-default", tags: ["budget-hold"], nextStep: null },
  { stage: "won-default", tags: [], nextStep: null },
  { stage: "lost-default", tags: [], nextStep: null },
  { stage: "security-review", tags: ["renewal"], nextStep: null, closeout: true },
  { stage: "negotiate", tags: [], nextStep: "Book legal call" },
];
const DUPLICATE_LAYOUT = [
  { stage: "qualify", tags: [], nextStep: null },
  { stage: "security-review", tags: ["renewal"], nextStep: null, closeout: true },
  { stage: "negotiate", tags: [], nextStep: "Send pricing" },
  { stage: "won-default", tags: [], nextStep: null },
];
const FILLER_OPEN = ["propose", "discovery", "qualify"];
const FILLER_CLOSED = ["won-default", "lost-enterprise", "won-enterprise"];
// Creation interleave over 22 deals: T=target, D=duplicate, F=filler (target never contiguous with duplicate).
const INTERLEAVE = "TFTDTTFTDTTFTDTFTFTTDF";

export function generateDataset(seed, spec) {
  if (!spec?.target?.name || !spec?.target?.domain) throw new Error("spec.target {name, domain} required");
  if (!Array.isArray(spec.fillerNames) || spec.fillerNames.length !== 3) throw new Error("spec.fillerNames must have 3 names");
  const rng = createRng(String(seed), "dataset");
  const closeoutName = spec.family === "won-closeout" ? spec.closeoutDealName : undefined;
  if (spec.family === "won-closeout" && !closeoutName) throw new Error("won-closeout requires closeoutDealName");

  const target = { key: "company-target", name: spec.target.name, domain: spec.target.domain, role: "target" };
  const duplicate = { key: "company-duplicate", name: spec.target.name, domain: spec.duplicateDomain, role: "duplicate" };
  const fillers = spec.fillerNames.map((n, i) => ({ key: `company-filler-${i + 1}`, name: n, domain: `${slug(n)}.example`, role: "filler" }));
  const companies = [fillers[0], target, fillers[1], duplicate, fillers[2]];

  const products = rng.shuffle(PRODUCTS);
  const name = (company, product) => `${company} — ${product}`;
  const targetProducts = products.slice(0, 12);
  const targetDeals = TARGET_LAYOUT.map((l, i) => ({
    key: `deal-target-${String(i + 1).padStart(2, "0")}`,
    companyKey: target.key,
    name: l.closeout && closeoutName ? closeoutName : name(target.name, targetProducts[i]),
    ...l,
  }));
  const dupProducts = products.slice(12, 16);
  const dupDeals = DUPLICATE_LAYOUT.map((l, i) => ({
    key: `deal-duplicate-${i + 1}`,
    companyKey: duplicate.key,
    name: l.closeout && closeoutName ? closeoutName : name(duplicate.name, dupProducts[i]),
    ...l,
  }));
  const fillerDeals = [];
  for (const half of ["a", "b"]) {
    fillers.forEach((f, i) => {
      const open = half === "a";
      fillerDeals.push({
        key: `deal-filler-${i + 1}${half}`,
        companyKey: f.key,
        name: name(f.name, products[(16 + i * 2 + (open ? 0 : 1)) % products.length]),
        stage: open ? FILLER_OPEN[i] : FILLER_CLOSED[i],
        tags: !open && i === 0 ? ["renewal"] : [],
        nextStep: open && i === 1 ? "Intro call" : null,
      });
    });
  }
  const queues = { T: targetDeals, D: dupDeals, F: fillerDeals };
  const idx = { T: 0, D: 0, F: 0 };
  const deals = [];
  for (const ch of INTERLEAVE) {
    const d = queues[ch][idx[ch]++];
    deals.push({
      key: d.key,
      companyKey: d.companyKey,
      name: d.name,
      amount: rng.int(50, 2500) * 100,
      pipeline: CANONICAL_STAGES[d.stage].pipeline,
      stage: d.stage,
      stageClass: CANONICAL_STAGES[d.stage].stageClass,
      nextStep: d.nextStep ?? null,
      tags: [...d.tags],
      createdOrder: deals.length + 1,
    });
  }
  return {
    companies: companies.map((c, i) => ({ ...c, createdOrder: i + 1 })),
    deals,
    tagOptions: [...TAG_OPTIONS],
  };
}
