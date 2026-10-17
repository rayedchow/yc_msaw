# Project Outline: An Agent-Native Layer for Human-Era Enterprise Systems

Track: Manufact, Best MCP Server for Agents (agents are the primary customer)
Event: YC "Make Something Agents Want"

---

## 1. Thesis

**Exa rebuilt search for agents instead of humans. We do the same for enterprise systems of record, and nobody has to replace their ERP.**

ERPs and CRMs from the 2010s (NetSuite, SAP, Dynamics, Salesforce, Sage Intacct) were designed for people clicking through screens. Their real interface is not the API. It is the screens plus a decade of **tribal knowledge** about how this particular company uses them, for example:

- `custbody_14 = T` is the real approval gate. The standard `approvalstatus` field is ignored.
- Never edit a bill in a closed period. Reverse it and re-post instead.
- Subsidiary 3 reports in EUR, but its intercompany entries are booked in USD.
- The "AP Aging – FINAL v2" saved search is the source of truth. The other four are stale.

Today a forward-deployed engineer (FDE) spends weeks on archaeology for every new customer: clicking around, reading audit logs, interviewing the controller, and then writing the integration by hand. Customers won't rip and replace systems they have customised for 10 years, and generic connectors (Composio, Merge, Nango) expose the *standard* API, which is exactly the part that doesn't contain the tribal knowledge.

**Our project is an MCP that agents connect to instead of the legacy system.** Behind it, a root agent:
1. **Explores** each customer's instance by itself: schema, data profiles, audit logs and sandbox probes.
2. **Turns** what it learns into tested facts and purpose-built tools.
3. **Deploys** them as a growing **tree of MCPs on Manufact** (system → tenant → workflow).
4. **Keeps iterating** on that tree: it repairs nodes when the customer's system drifts, and it promotes lessons that hold across customers up to the shared system level.

The FDE stops doing the archaeology. They answer a handful of specific questions the explorer couldn't resolve, and approve deployments.

---

## 2. How we stand out from the "company brain / process memory" teams

| | Company brain / process memory | Our project |
|---|---|---|
| Where knowledge comes from | Docs, Slack, meeting transcripts (what people *say* happens) | The system itself: schema, data distributions, audit trails, sandbox probes (what *actually* happens) |
| What's stored | Text and embeddings | **Facts compiled into tests** and **workflows compiled into MCP tools** |
| How agents use it | Retrieve, re-read, re-reason, then call raw APIs | Call one typed, intent-level tool that already encodes the quirks |
| Staleness | Gets out of date without anyone noticing | Every fact is a re-runnable probe. When it starts failing, the fact is flagged and a repair is triggered |
| Delivery | A knowledge base that sits next to the agent | A deployed, versioned MCP fleet on Manufact that the agent calls through |
| Who benefits | One company's agents | One customer's agents (tenant node), and every customer on that system (lessons promoted upward) |

**Line for judges:** company brains write tribal knowledge down. We compile it.

---

## 3. What "agent-native" means concretely

A human-era system gives you pages, menus, saved searches and an error popup. Agents need a different contract, so every tool in the tree follows these rules:

| Human-era behavior | Agent-native contract |
|---|---|
| Field names like `custbody_14`, `zz_flag2` | Semantic schema: `isControllerApproved: boolean`, with a description that explains the business meaning |
| Find the right one of 40 saved searches | Intent-level operations: `find_payable_bills({ period, minAmount, approvedOnly })` |
| Click Save and hope | **Plan, then commit.** Every write tool supports `dry_run`, which returns a change plan with a hash. `commit(plan_hash)` executes exactly that plan |
| Double-clicking creates duplicates | Built-in idempotency keys and checks of current state before acting |
| Error popups | Structured errors with a reason and a recovery step the agent can act on (`PERIOD_CLOSED → use reverse_and_repost`) |
| A 200-column record dump | Compact, token-budgeted outputs, with expansion on request |
| Trust the screen | Provenance on every answer: which facts and which tool version produced it |
| Learn quirks over months | Quirks are already encoded in the tool, and the agent can query them (`explain_fact`) |

---

## 4. Architecture

```
           Agents (Claude, GPT, Cursor, internal agents)
                          │  one stable MCP endpoint
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ ROOT MCP  (mcp-use v2, deployed on Manufact)                      │
│  agent-facing: find · invoke · plan/commit · report_outcome ·     │
│                explain_fact · onboard_system                      │
│  internal:     Router · Explorer · Forge · Evaluator · Gardener   │
└──────┬─────────────────────────────┬─────────────────────────────┘
       │ routes calls                │ drives deployments via
       ▼                             ▼ Manufact control-plane MCP / CLI / GitHub
┌──────────────── MCP TREE ON MANUFACT ─────────────────────────────┐
│ erp-core (system node: auth, pagination, governance limits,       │
│           period locks, generic entities)                         │
│   ├── erp@acme    (tenant node: Acme's custom fields, approval    │
│   │     │          rules, subsidiaries, trusted saved searches)   │
│   │     ├── tool: find_payable_bills        v3 ● promoted         │
│   │     ├── tool: post_accrual_batch        v1 ● promoted         │
│   │     └── branch cap/accrual/v2           ○ preview (candidate) │
│   └── erp@globex  (tenant node)                                   │
│ crm-core                                                          │
│   └── crm@acme ...                                                │
└───────────────────────────────────────────────────────────────────┘
       ▲                                     ▲
       │ read-only profiling and audit logs  │ write probes (sandbox only)
  Customer PROD instance               Customer SANDBOX instance

Fact Ledger (Postgres): facts, evidence, scope, confidence, probes,
versions, receipts, traces, outcomes, lineage
```

### The tree: what is a node

| Level | Holds | Deployed as | Isolation |
|---|---|---|---|
| **System node** (`erp-core`) | Knowledge that is true for every instance: auth, rate and governance limits, pagination, period-lock semantics | Manufact project. Also published as a shared package that tenant nodes depend on | No customer data |
| **Tenant node** (`erp@acme`) | That customer's tribal knowledge as facts, plus its workflow tools | **One Manufact project per tenant**, with that tenant's credentials kept in its own environment secrets | A hard per-customer boundary |
| **Workflow tool** | One intent-level operation (`find_payable_bills`) | A tool inside the tenant node (not a separate deployment, so the number of deployments doesn't explode) | Inherits the tenant's isolation |
| **Candidate** | A proposed revision | A git branch, which becomes a **Manufact preview URL** | Sandbox credentials only |

Agents never see this tree. They connect to the root, and the router resolves `(tenant, system, intent)` to a node, a tool and a version.

### Root agent components

| Component | Job |
|---|---|
| **Router** | Resolves an intent to a node and tool by checking whether the tool's contract matches what's being asked, not by keyword similarity alone. Proxies the call. Logs the trace |
| **Explorer** | Self-exploration. Builds and maintains the tenant's model of the system (see §5) |
| **Forge** | Coding agent. Turns facts and a workflow spec into a typed tool inside the tenant node's repo, using a restricted template, Zod, `tsc` and Vitest |
| **Evaluator** | Runs fact probes, workflow tests, regression suites and held-out cases. Replays them **over MCP against the Manufact preview**. Runs Manufact's cross-model evals |
| **Gardener** | Maintains the tree: promote, roll back, deprecate, merge near-duplicates, **promote cross-tenant lessons up to the system node**, clean up stale previews |

---

## 5. Self-exploration: how the system learns tribal knowledge

The Explorer works like an FDE's first two weeks, but runs in hours and keeps a record of its evidence.

**Phase 1: Map (read-only, safe on prod)**
- Pull the system's metadata: NetSuite metadata catalog or SuiteQL, Salesforce `describe`, SAP OData `$metadata`. List standard entities, custom fields, custom record types and workflows.
- **Data profiling:** for each custom field, measure how often it's filled, its distinct values, how it correlates with standard fields, and whether it was used recently. *A custom field that is filled on 98% of approved bills and almost never on unapproved ones is probably the real approval flag.*
- **Process mining from audit logs** (system notes, field history): who changes what, in what order, and how long between steps. This shows the *actual* process, e.g. "the controller always sets `custbody_14` after the AP clerk, and payment runs only pick up bills where it's set."

**Phase 2: Hypothesize**
- Each finding becomes a candidate **fact**: `{claim, scope, evidence, confidence, probe}`.
- Example: `claim: "Bills are payable only if custbody_14 = T", scope: tenant:acme, evidence: [profile#12, auditlog-pattern#4], confidence: 0.86`.

**Phase 3: Probe (sandbox writes; read checks on prod)**
- **Differential probing:** do an action in the sandbox and compare the system's state before and after to learn side effects. Example: "Creating a bill over $50k triggers an approval workflow and sets status to Pending B."
- **Boundary probing:** try editing a closed period, test duplicate detection, push a rate limit until it trips. Record exactly what fails and how.
- Each confirmed fact gets an **executable probe**, a re-runnable test that checks the fact still holds.

**Phase 4: Ask the FDE (only when needed)**
- If probing can't settle a question, the Explorer writes a **sharp question with evidence**, not "how does your AP work?". For example: *"`custbody_14` and `custbody_22` both look like approval flags (they agree 91% of the time). In 37 recent bills they disagree. Which one should gate payment? [table attached]"*
- The answer becomes a fact with `source: human`.
- The target is roughly 5–10 questions per tenant instead of weeks of meetings, with the FDE acting as a reviewer instead of an archaeologist.

**Phase 5: Compile**
- Facts plus a workflow spec go to the Forge, which writes a tool. The tool's tests come from the facts (each fact's probe becomes an assertion) plus the workflow's own outcome checks.

---

## 6. Self-improvement on Manufact (the root iterating on the tree)

"Self-improving" here means the **procedures and code improve, with evidence**. Model weights don't change.

### What triggers a revision

| Trigger | Example |
|---|---|
| **Agent failure** | `report_outcome(failed)` with a trace: "bills from subsidiary 3 were missing" |
| **Drift** | A nightly fact probe fails: Acme added a second approval stage, or renamed a field |
| **Schema change** | The metadata diff shows a new custom field or record type |
| **New workflow request** | An agent asks for an operation the tenant node doesn't have yet |
| **Cross-tenant signal** | The same fact gets confirmed in N tenants, so the Gardener proposes moving it up to the system node |

### The revision loop (every step runs through Manufact)

1. **Branch.** The root creates `cap/<tool>/v<n+1>` in the tenant node's repo.
2. **Forge.** The coding worker writes the change. Earlier tests can't be deleted, so the test suite only grows.
3. **Preview.** The Manufact GitHub App builds a **per-branch preview URL**.
4. **Evaluate on the preview, over MCP:**
   - fact probes (against the sandbox)
   - workflow tests checked against the system's true state (an oracle), not the tool's own output
   - every earlier version's tests (regressions)
   - held-out cases the worker never saw
   - **Manufact cross-model evals:** can GPT, Claude and Gemini each choose and call the tool correctly from its description alone?
   - **Shadow comparison:** replay recent production calls in `dry_run` on the old and new versions and compare the plans
5. **Read logs.** Manufact build and runtime logs, pulled through the control-plane MCP, go back to the Forge when something fails. Iterations are capped.
6. **Promote by risk tier:**
   - *read-only tools*: automatic promotion when everything passes
   - *write tools*: an FDE approves through a **Receipt card in Claude or ChatGPT** (built as an MCP App view): diff, facts changed, tests passed, shadow plan comparison, and an Approve button
7. **Merge to main**, which triggers the production deploy. The router moves to the new version. Rollback means re-pinning the previous deployment.

### Moving lessons up the tree

- A fact starts in a tenant node. If it is **structural** (about how the system behaves, not about customer data) and confirmed independently in ≥N tenants, the Gardener opens a PR to promote it to the system node.
- The system node's package version goes up, and that triggers a **canary rollout across tenant nodes**. Each tenant must pass its own regression suite before it picks up the change.
- So tenant #10 starts with everything learned from the first nine. Onboarding time and FDE questions should go down from one tenant to the next. **That curve is the moat, and it's what we put on screen.**

---

## 7. Manufact: research and how we use it

**What Manufact is** (formerly mcp-use, YC; about 7M SDK downloads and about 10k GitHub stars):
- **mcp-use SDK v2 (TS/Py):** `MCPServer`, `server.tool({ name, inputSchema, outputSchema, annotations, view })`, Zod types, built on the official TS SDK v2, stateless runtime, one-line OAuth adapters.
- **MCP Apps / Views:** React views bound to tools that render inside ChatGPT and Claude.
- **Manufact Cloud:** GitHub App deploys on every push, a **preview URL per branch or PR**, custom domains with SSL, and a claimed push-to-live time under 60 seconds.
- **Cloud Inspector**, **cross-model evals on every deploy**, **logs, JSON-RPC traces, session replay and regression alerts**.
- **CLI** (`@mcp-use/cli`, `npx mcp-use deploy`, `mcp-use client ... tools call`).
- **Control-plane MCP** at `https://mcp.manufact.com/mcp`, which agents can use to manage servers, deployments and logs.

**How each Manufact feature is used:**

| Our need | Manufact primitive |
|---|---|
| A tree node | A Manufact project (one per system node and one per tenant node) |
| A candidate revision | A git branch with its own preview URL |
| Tenant credential isolation | Separate environment secrets for each project |
| The root agent managing the fleet | The **control-plane MCP**: the root is an agent operating Manufact through MCP |
| Correctness gate | Our evaluator replays tests over MCP against preview URLs |
| Agent-legibility gate | Manufact cross-model evals |
| Repair signal | Runtime logs, traces and regression alerts, which flow into revision triggers |
| Human approval for writes | An MCP App view (Receipt card) |
| Rollback | Re-pinning a previous deployment |

**What's distinctive about this integration:** most Manufact users are *humans deploying one MCP*. Here the Manufact customer is an **agent running a fleet of MCPs**: it creates projects, ships branches, reads logs, gates on evals and promotes changes, all through Manufact's own MCP. That's the track's thesis applied to Manufact itself.

> **Day-1 checks:** exact control-plane MCP tool names; how to get a branch's preview URL programmatically; project/preview limits per plan; whether one repo can deploy several servers. Fallbacks: the CLI (`npx mcp-use deploy`) and the GitHub deployment-status API.

---

## 8. Hackathon demo (about 4 minutes)

**Setup:** *LedgerSim*, a simulated 2010s-era ERP with human-era quirks: cryptic custom fields, status codes like `A/B/C`, an "inactive" flag in place of deletion, saved searches, period locks, governance-unit rate limits, and audit logs. Two tenants with different configurations: **Acme** and **Globex**. *(Optional credibility boost: point the Explorer read-only at a free real Salesforce Developer org to show Phase 1 working on a real system.)*

1. **The gap.** An agent is asked: "List Q3 approved, unpaid vendor bills over $10k for Acme and flag any without a PO." Using the generic `erp-core` tools it returns **the wrong set**, because it trusts `approvalstatus`. The oracle shows 14 wrong rows.
2. **Explore.** `onboard_system(acme)`. Live feed: metadata mapped, 212 custom fields profiled, the audit-log pattern found, *custbody_14 identified as the real approval gate (0.86)*, sandbox probe confirms it, and one question goes to the FDE with an evidence table. The FDE answers in chat.
3. **Compile and deploy.** The Forge builds `find_payable_bills` into `erp@acme`, a Manufact preview goes live, probes, oracle tests and cross-model evals pass, and it's promoted. The agent re-runs the task: **0 wrong rows, 1 call**.
4. **Second tenant.** `onboard_system(globex)`. It inherits the system-level facts, finds that Globex uses standard approval but has multi-currency subsidiaries, and asks **0 questions**. The node is live in a fraction of Acme's time. Meanwhile "closed periods reject edits with error 4012" is confirmed in both tenants, so it's **promoted to `erp-core`**.
5. **Drift.** We change Acme's configuration live by adding a second approval stage. A fact probe fails, the root opens `v2`, the preview passes the new test plus all of v1's tests, and it's promoted. Nobody touched it.
6. **Close.** An MCP App view shows the **live tree** (nodes, versions, previews, the promoted lesson) and a Receipt card. On screen: the onboarding curve (Acme vs Globex: time, FDE questions, task accuracy).

---

## 9. Complications and how we handle them

| Risk | Mitigation |
|---|---|
| **Exploring prod is dangerous** | Prod is read-only. Writes happen only in the sandbox. Every probe is classified as read or write before it runs |
| **Sandbox ≠ prod** (sandboxes are often stale copies) | Facts are tagged by environment. Facts learned in the sandbox are re-checked read-only against prod before they're trusted |
| **Wrong inferences** (correlation isn't the rule) | Confidence levels. Only facts that a probe confirmed or a human confirmed can drive write tools. Inferred-only facts can't |
| **Privacy / customer data in the fact ledger** | Facts are stored as schema and statistics, not raw records. PII is redacted. One project per tenant on Manufact |
| **Promoting lessons up leaks tenant information** | Only structural facts about how the system behaves are promoted, never values, and only after confirmation in ≥N tenants |
| **The model grades its own homework** | A separate model call writes tests without seeing the code. Mutation checks ensure the tests fail against a naive version. Assertions are checked against the system's true state. Held-out cases |
| **Tree explosion and cost** | Workflows are tools inside tenant nodes, not separate deployments. Candidates are branches that get cleaned up. Near-duplicates are merged |
| **A system-node change breaks a tenant** | Pinned versions, canary rollout across tenants, and each tenant's own regression suite gating the upgrade |
| **Self-modification on write paths** | Promotion depends on risk: read-only tools auto-promote; write tools need FDE approval plus a clean shadow plan comparison. Plan/commit with hashes. Reversals preferred over deletes |
| **Credentials** | Tenant credentials live only in that tenant's Manufact environment secrets. The Forge and generated code never see them. Previews get sandbox credentials only |
| **Prompt injection through docs, field labels or record data** | Restricted template, network allowlist, banned imports, diff size limits. Data reaches the Forge only as statistics |
| **Latency of onboarding and revisions** | Async jobs with MCP progress notifications. Agents keep using the current promoted version while a revision is built |
| **Manufact API unknowns** | Day-1 spike. CLI and GitHub fallbacks |
| **Demo fragility** | Seeded simulator, pinned models, capped iterations, a recorded fallback run |

---

## 10. Stack

- **Root MCP:** TypeScript, mcp-use v2, Zod, deployed on Manufact
- **Tree nodes:** mcp-use template repos (one per system and one per tenant), Manufact projects, branch previews
- **Manufact control:** control-plane MCP as the primary path, `@mcp-use/cli` and the GitHub API as fallbacks
- **Agents:** Anthropic TS SDK tool-use loop for the root's internals (Explorer, Forge, Evaluator); a separate client agent for the demo task
- **LedgerSim:** Hono service with a metadata endpoint, audit log, sandbox and prod modes, seedable tenants and faults, and an admin oracle
- **Fact Ledger:** Postgres (Neon) or SQLite
- **Views:** MCP App views for the Tree and the Receipt card

## 11. Build plan

1. **Hours 0–2:** Manufact spike (create a project, push a branch, get the preview URL, call it over MCP). LedgerSim with the Acme and Globex configs.
2. **Hours 2–5:** Root MCP with the router and the agent-facing verbs. `erp-core` node. A naive agent failing the task.
3. **Hours 5–8:** Explorer phases 1–4 (metadata, profiling, audit-log mining, sandbox probe, FDE question).
4. **Hours 8–11:** Forge and Evaluator: tests derived from facts, the revision loop, preview replay, promotion.
5. **Hours 11–13:** Second tenant, moving a lesson up to `erp-core`, the drift-repair path.
6. **Hours 13+:** Tree and Receipt views, the onboarding-curve chart, rehearsal, recorded fallback.

## 12. Beyond the hackathon

- Every customer onboarded makes the next one on the same system cheaper. The system nodes become the definitive **agent-native version of NetSuite, SAP and Salesforce**, built from real usage rather than vendor docs.
- The tenant fact ledger is a **living, tested specification of how a company actually runs** on its systems. That's useful for audits, migrations and new hires, not only agents.
- The hard, defensible part is measuring **which lessons generalize** (tenant → system) and which only fit one customer's configuration.

---

Sources: [manufact.com](https://manufact.com) · [mcp-use GitHub](https://github.com/mcp-use/mcp-use) · [YC Launch: Manufact](https://www.ycombinator.com/launches/O2c-manufact-mcp-use-build-and-deploy-mcp-servers-for-ai-agents-mcp-apps-for-chatgpt-claude-users) · [Manufact: preview URL per branch](https://ai.manufact.com/task/blog/preview-url-per-branch-mcp-server) · [Manufact: automatic evals on deploys](https://ai.manufact.com/task/blog/automatic-evals-mcp-server-deploys) · [RuntimeWire: Manufact Cloud launch](https://runtimewire.com/article/manufact-mcp-cloud-launch)
