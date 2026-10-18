/**
 * Predeclared CRM benchmark scenarios: vendors, task families, training curricula, matrix targets and the two
 * adaptation demonstrations. Everything a model sees comes from `taskPrompt`/`SYSTEM_PROMPT`; fixture seeds/specs
 * are host-only.
 */
export type Vendor = "hubspot" | "pipedrive" | "zoho" | "attio";
export const VENDORS: readonly Vendor[] = ["hubspot", "pipedrive", "zoho", "attio"];
export type Family = "exec-review" | "won-closeout";
export type ModelAlias = "kimi" | "glm" | "minimax";
export type MemoryCondition = "cold" | "H" | "M";
export type TargetKey = "A" | "C" | "D" | "CD";

export const VENDOR_LABEL: Record<Vendor, string> = { hubspot: "HubSpot", pipedrive: "Pipedrive", zoho: "Zoho CRM", attio: "Attio" };
export const VENDOR_SLUG: Record<Vendor, string> = { hubspot: "crm-hubspot", pipedrive: "crm-pipedrive", zoho: "crm-zoho", attio: "crm-attio" };
export const NEXT_STEP_TEXT = "Exec review 2026-11-03";

export interface DatasetSpec {
  instanceLabel: string;
  target: { name: string; domain: string };
  duplicateDomain: string;
  fillerNames: [string, string, string];
  family: Family;
  closeoutDealName?: string;
}

export interface OrgDef {
  key: string;
  name: string;
  domain: string;
  duplicateDomain: string;
  fillers: [string, string, string];
}

const org = (key: string, name: string, fillers: [string, string, string]): OrgDef => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return { key, name, domain: `${slug}.example`, duplicateDomain: `${slug}-holdings.example`, fillers };
};

/** Training organisations (independent synthetic orgs) and held-out evaluation organisations (never in training). */
export const ORGS: Record<string, OrgDef> = {
  org1: org("org1", "Tailspin Logistics", ["Blue Yonder Airlines", "Margie's Travel", "Trey Research"]),
  org2: org("org2", "Wingtip Outfitters", ["Graphic Design Institute", "School of Fine Art", "VanArsdel Ltd"]),
  org3: org("org3", "Proseware Health", ["Humongous Insurance", "Relecloud", "Southridge Video"]),
  org4: org("org4", "Lucerne Publishing", ["Northwind Foods", "Woodgrove Bank", "Consolidated Messenger"]),
  evA: org("evA", "Fabrikam Robotics", ["First Up Consultants", "Nod Publishers", "Datum Corporation"]),
  evC: org("evC", "Litware Analytics", ["City Power & Light", "Best For You Organics", "Fourth Coffee"]),
  evD: org("evD", "Coho Vineyard", ["Contoso Pharmaceuticals", "Liberty's Delightful", "Bellows College"]),
  evCD: org("evCD", "Alpine Ski House", ["Wide World Importers", "Adatum Labs", "Munson's Pickles"]),
  adFar: org("adFar", "Southridge Analytics", ["Phone Company", "Rainbow Paints", "Tasmanian Traders"]),
  adCold: org("adCold", "Blue Yonder Freight", ["Lamna Healthcare", "Olympia Supplies", "Pinnacle Arts"]),
};

export const INSTANCE_LABEL: Record<Vendor, (o: OrgDef) => string> = {
  hubspot: (o) => `${o.name} HubSpot account`,
  pipedrive: (o) => `${o.name} Pipedrive company`,
  zoho: (o) => `${o.name} Zoho CRM org`,
  attio: (o) => `${o.name} Attio workspace`,
};

export function closeoutDealName(o: OrgDef): string {
  return `${o.name} — Platform renewal`;
}

export function datasetSpec(o: OrgDef, vendor: Vendor, family: Family): DatasetSpec {
  return {
    instanceLabel: INSTANCE_LABEL[vendor](o),
    target: { name: o.name, domain: o.domain },
    duplicateDomain: o.duplicateDomain,
    fillerNames: o.fillers,
    family,
    ...(family === "won-closeout" ? { closeoutDealName: closeoutDealName(o) } : {}),
  };
}

/** One task = one prompt over one or two target CRM instances; every visible vendor gets its own fixture instance. */
export interface TaskDef {
  id: string;
  family: Family;
  org: OrgDef;
  targets: Vendor[];
  /** Vendors whose adapters/fixtures are visible in this session (targets ⊆ visible). */
  visible: Vendor[];
  /** Docs corpus vendors served to this session. */
  docsVendors: Vendor[];
  /** Fixture seed per visible vendor (host-only). */
  seeds: Record<string, string>;
}

export function makeTask(id: string, family: Family, o: OrgDef, targets: Vendor[], visible: Vendor[], docsVendors: Vendor[], seedBase: string): TaskDef {
  const seeds: Record<string, string> = {};
  for (const v of visible) seeds[v] = `${seedBase}:${id}:${v}`;
  return { id, family, org: o, targets, visible, docsVendors, seeds };
}

export function taskPrompt(t: TaskDef): string {
  const o = t.org;
  if (t.family === "won-closeout") {
    const v = t.targets[0]!;
    return [
      `Close-out in our ${VENDOR_LABEL[v]} CRM (${INSTANCE_LABEL[v](o)}): the deal "${closeoutDealName(o)}" of the company ${o.name} (primary domain ${o.domain}) has been signed.`,
      `Mark that deal as won and add the review tag \`closed-q4\` to the deal's Review tags field, keeping any review tags already on it.`,
      `Do not modify any other deal, company or field. When finished, reply with the ID of the deal you updated.`,
    ].join("\n");
  }
  const where =
    t.targets.length === 1
      ? `in our ${VENDOR_LABEL[t.targets[0]!]} CRM (${INSTANCE_LABEL[t.targets[0]!](o)})`
      : `in BOTH of these CRMs: ${t.targets.map((v) => `our ${VENDOR_LABEL[v]} (${INSTANCE_LABEL[v](o)})`).join(" and ")} — do the work separately in each CRM`;
  return [
    `Exec-review prep ${where}. Company: ${o.name} (primary domain ${o.domain}).`,
    `For every OPEN deal (not won and not lost) associated with this company: (1) set the deal's Next step field to exactly \`${NEXT_STEP_TEXT}\`; (2) add the review tag \`exec-review\` to the deal's Review tags field, keeping any review tags already on the deal.`,
    `Do not modify closed (won/lost) deals, deals of other companies, or any other field. When finished, reply with the IDs of the deals you updated${t.targets.length > 1 ? " in each CRM" : ""}.`,
  ].join("\n");
}

export const SYSTEM_PROMPT = [
  "You are an operations agent working for one customer organization. You act only through the tools you are given; no human is available, so complete the task end to end and then reply with a brief summary.",
  "Tools: memory__* is the organization's procedural memory, learned from previous agents' work. Call memory__open_memory first, then read $KNOWLEDGE/index.md and any relevant pages before acting.",
  "integration__<name>__* are the organization's live integrations: one integration per connected CRM (each bound to exactly one CRM instance of this organization) plus integration__crm-docs__* for searching pinned official API documentation.",
  "The set of tools and their schemas can change between requests; always use the tools available now. Only report what tools actually returned.",
].join("\n");

// ------------------------------------------------------------------ curricula and matrix (predeclared)
export const TRAIN_VISIBLE: Vendor[] = ["hubspot", "pipedrive"];

export interface TrainSession {
  curriculum: "H" | "M";
  model: ModelAlias;
  task: TaskDef;
}

export function trainingSessions(seedBase: string): TrainSession[] {
  const t = (curr: "H" | "M", id: string, fam: Family, o: OrgDef, v: Vendor, model: ModelAlias): TrainSession => ({
    curriculum: curr,
    model,
    task: makeTask(`tr${curr}-${id}`, fam, o, [v], TRAIN_VISIBLE, TRAIN_VISIBLE, seedBase),
  });
  return [
    t("H", "1", "exec-review", ORGS.org1!, "hubspot", "kimi"),
    t("H", "2", "exec-review", ORGS.org2!, "hubspot", "glm"),
    t("H", "3", "won-closeout", ORGS.org3!, "hubspot", "kimi"),
    t("H", "4", "won-closeout", ORGS.org4!, "hubspot", "glm"),
    t("M", "1", "exec-review", ORGS.org1!, "hubspot", "kimi"),
    t("M", "2", "won-closeout", ORGS.org3!, "hubspot", "glm"),
    t("M", "3", "exec-review", ORGS.org2!, "pipedrive", "glm"),
    t("M", "4", "won-closeout", ORGS.org4!, "pipedrive", "kimi"),
  ];
}

export const EVAL_TARGETS: Record<TargetKey, { org: OrgDef; targets: Vendor[]; role: string }> = {
  A: { org: ORGS.evA!, targets: ["hubspot"], role: "familiar A (HubSpot) on a new organization/data" },
  C: { org: ORGS.evC!, targets: ["zoho"], role: "near held-out C (Zoho CRM v8)" },
  D: { org: ORGS.evD!, targets: ["attio"], role: "far held-out D (Attio v2)" },
  CD: { org: ORGS.evCD!, targets: ["zoho", "attio"], role: "multiple unseen CRMs C+D in one task" },
};

export interface MatrixCell {
  cellId: string;
  model: ModelAlias;
  condition: MemoryCondition;
  target: TargetKey;
  task: TaskDef;
}

export function matrixCells(seedBase: string): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const target of ["A", "C", "D", "CD"] as TargetKey[]) {
    const e = EVAL_TARGETS[target];
    for (const model of ["kimi", "glm", "minimax"] as ModelAlias[])
      for (const condition of ["cold", "H", "M"] as MemoryCondition[]) {
        // Identical task id per target => identical fixture seeds/data across every model/condition of that target.
        const task = makeTask(`ev-${target}`, "exec-review", e.org, e.targets, [...VENDORS], [...VENDORS], seedBase);
        cells.push({ cellId: `${target}-${model}-${condition}`, model, condition, target, task });
      }
  }
  return cells;
}

/** Deterministic Fisher-Yates with a seeded mulberry32 (pinned execution order). */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
