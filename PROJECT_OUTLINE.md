# Project Outline: Company-Specific MCPs, Mined From Tribal Knowledge

Track: Manufact, Best MCP Server for Agents (agents are the primary customer)
Event: YC "Make Something Agents Want"
Name: walter

---

## 1. Thesis

**Every company runs HubSpot differently. Agents get the right data and the wrong answer.**

Business systems such as CRMs, ERPs, billing tools and homegrown apps were built for people who carry years of
**tribal knowledge** in their heads:

- A deal counts only once RevOps ticks `booked`. "Closed Won" alone doesn't count.
- Revenue is the `arr` field. `amount` also includes one-time services.
- The "Partner Sandbox" pipeline holds training data and is never counted.
- New leads are assigned by territory, but existing contacts keep their account owner.

None of this is in the vendor's docs or the vendor's MCP. A generic MCP has to work for every company, so it knows
nothing about any one of them.

**Our project:** connect a company's systems, and an agent **mines the company's rules out of the data and its
history**, asks people only what the data can't answer, and **compiles the rules into that company's own MCP
server**, hosted on Manufact. The MCP then keeps improving from how agents use it.

> Company brains write knowledge down. We compile it into tools.

---

## 2. Why this is the right shape (the arguments we tested)

### Manufact's objection to our first idea

The first idea was a root agent that improves the MCPs it uses. Manufact's response: *the people who own the agent
harness and the people who own the MCP are usually different. That separation is the point of MCP. You can't
improve someone else's server.*

That's correct, and this project respects it:

```
   Company's agents (Claude, Cursor, ChatGPT, internal bots, …)
                     │  one tool call
                     ▼
   Company MCP              built + maintained by us, OWNED by the company, hosted on Manufact
   get_commit(quarter) · import_leads(leads) · …
   company rules live here as code + tests
                     │
                     ▼
   HubSpot API / HubSpot's MCP · warehouse · billing      owned by their vendors, never modified
```

- **The vendor owns the generic layer:** objects, API, pagination. We never touch it.
- **The company owns the business layer:** what "commit" means, who owns a lead, which data counts. Nobody else can
  build this layer.
- **The MCP owner and the beneficiary are the same company.** It approves every change that writes data.
- **Inside the company, MCP decoupling still holds.** A platform team owns the MCP and many agent teams consume it.
  So the learning loop must **not** depend on traces from inside agent harnesses. It learns from what the MCP owner
  can see: the systems themselves, calls to its own server (Manufact logs), and an agent-facing `report_outcome`
  tool.

### "Why not the vendor MCP plus memory?"

Memory makes the agent read the rules and apply them correctly every time. Compiled tools run the rule in code: one
call, the same result on every model.

Measured on our simulated CRM (real Fireworks agents, held-out tasks):

| Setup | Success |
|---|---|
| Raw API, no help | **0/8** |
| Raw API + memory wiki built from earlier runs | **4/8**. Agents still slipped on rules spelled out on the page, and reading cost tokens |
| Compiled company MCP | target ≈ 8/8 at a fraction of the tokens (**not yet measured**) |

### "Why an MCP and not just tools inside one agent?"

Tools inside one agent help one agent. A company runs many agents on many models and harnesses. One MCP:
- is shared by all of them;
- keeps logic and credentials in one place;
- reaches every agent with a fix on its next call;
- sees every call in one place, which is the loop's failure signal.

If a company has exactly one agent built by one team, a tool updater is enough. The pitch assumes many agents.

### "Isn't this a company brain?"

| | Company brain | This project |
|---|---|---|
| Learns from | What people *wrote* (docs, chat) | What the system *did* (data, change history, agent failures) |
| Produces | Text to retrieve | Tools plus tests |
| The agent | Reads, reasons, can still get it wrong | Makes one call; the rule can't be skipped |
| When a rule changes | Text quietly goes stale | A test fails and the tool gets fixed |

The memory wiki we built earlier (procmem) **is** a company brain. It becomes the baseline in the proof chart, not
the product.

---

## 3. Built for agents, end to end

| Role | Who |
|---|---|
| Uses the MCP | **Agents only.** Intent-level tools, structured errors with a recovery step, compact outputs |
| Decides what gets built | **Agents.** Their failed calls, `report_outcome` reports and `needs_decision` results drive every change |
| Builds the MCP | **An agent** (explore → hypothesize → backtest → compile → verify) |
| Humans | Answer the few questions history can't settle; approve tools that write data |

Pitch it as "agents are the customer," never as "saves your engineers time."

Agent-native tool contract:

- **Intent-level tools,** like `get_commit(quarter)`, never `search_deals(filterGroups…)`.
- **Structured errors with a recovery step,** for example `{ code: "PERIOD_CLOSED", recover: "use reverse_and_repost" }`.
- **Every answer carries provenance:** which rules applied, at which version, and any unconfirmed `assumptions`.
- **Writes use plan, then commit:** `dry_run` returns a plan hash, and `commit(plan_hash)` executes exactly that plan.
- **Compact, token-budgeted outputs,** expanded on request.

---

## 4. How it works

### 4.1 Connections: `.md` plus a secrets manager

Each third-party system is a connection:

- `connections/hubspot.md`: what the system is, its base URL, links to docs, the objects that matter, notes ("the
  Enterprise pipeline is ours"), and the allowed scopes (read-only vs write).
- `connections/warehouse.md`: a read-only database or warehouse (both API and DB access are supported).
- **Secrets manager:** credentials stored by name (`HUBSPOT_TOKEN`, `WAREHOUSE_URL`). The host injects them when a
  request is made. **No model ever sees a secret.**

### 4.2 The builder: an agent with tools to build, an MCP client to verify

- **Exploring uses generic tools,** not an MCP: authenticated HTTP requests (auth injected by the host), read-only
  SQL, and sandboxed scripts for profiling. An MCP's value is a curated, stable interface, and that interface doesn't
  exist until the builder makes it.
- **Verification goes through MCP.** The builder tests its draft server through a real MCP client, exactly as
  customer agents will use it.

### 4.3 The loop

1. **Mine:** profile fields, values, correlations and change history.
2. **Hypothesize:** turn patterns into candidate rules, each written as code.
3. **Backtest:** score each rule against historical decisions (§5).
4. **Ask:** send only what history can't decide to a human, as one evidence-backed question.
5. **Compile:** write intent-level tools with one test per rule.
6. **Ship:** deploy to a Manufact preview, run tests and cross-model evals, then promote.
7. **Evolve:** agent failures, `report_outcome` calls and broken backtests (when the business changes) trigger the
   next revision.

### 4.4 How it maps onto Manufact

| We need | Manufact provides |
|---|---|
| Write the server | mcp-use SDK |
| Host it for every agent | Manufact Cloud |
| Try each change safely | Preview URL per branch (to confirm: shipped?) |
| "Can every model use these tools?" | Cross-model evals on deploy (to confirm: shipped?) |
| See where agents fail | Logs and traces (to confirm: API access?) |
| Undo a bad change | Rollback (used today via the REST API) |

Manufact today hosts the MCPs people manage to build by hand. This project produces the ones nobody can build by
hand: one per company and system, each improving after it ships.

---

## 5. Discovering tribal knowledge: history is the answer key

To learn rules, the agent needs ground truth. In production, a forward-deployed engineer would replay tasks on
historical data and compare the result with what really happened. **The system's history already records what
humans decided**, so the agent can do that comparison itself.

| Rule | Historical evidence of human decisions |
|---|---|
| Lead ownership | Every past owner assignment, and who changed it |
| What counts as "commit" | Past quarters' reported numbers (a report table, a forecast snapshot, or a number the user supplies) |
| Company dedupe | Past merges and deletions |
| When a deal is "booked" | Field history: who flips `booked` and when |

**Method:**
1. **Hypothesize a rule:** "owner = territory of the contact's country."
2. **Write it as code.**
3. **Backtest it on historical decisions:** "explains 94% of assignments."
4. **Explain what's left:** "5 of the 6 misses are existing contacts that kept their account owner," which refines
   the rule.
5. **Replay whole tasks on a past period:** "compute Q3's commit as of Sept 30" and compare deterministically with
   the recorded number.
6. **Split by time:** learn on older quarters, test on the newest one. That's what shows a rule generalizes.

### Balancing agent-first with asking humans

Humans are the **source of truth of last resort**, never the designers.

- **The agent asks only when history can't decide:** two rules fit equally well, cases nobody can explain, or a
  policy with no historical evidence.
- **Questions are cheap to answer:** evidence attached, multiple choice ("These 7 deals disagree. Which rule wins?
  A / B"), delivered to an inbox or Slack.
- **Every answer becomes a test.**
- **Nothing blocks.** Until someone answers, the tool applies the safest rule and says so:
  `{ value, assumptions: [...] }`.
- **Agents generate questions too.** A tool that hits an uncovered case returns `needs_decision`, which becomes the
  next question.
- **Questions per rule is a cost we report.** Fewer questions means a better miner.

---

## 6. How we prove it

In the simulated CRM we control the generator, so **we know the true rules**.

1. **Plant rules,** then generate 2+ years of history by simulating employees who follow them: with noise, with
   exceptions, and with **one rule change midway** (drift).
2. **Score the miner on:**
   - rule recall and precision (found the planted rules, invented nothing);
   - backtest accuracy on the held-out quarter;
   - questions asked per rule;
   - whether it detected the drift.
3. **Score the outcome:** held-out agent success under four setups: raw API, memory wiki, mined MCP without
   questions, mined MCP with questions.
4. **Later, for real-world credibility:** a real HubSpot developer account with seeded history; "reproduce last
   quarter's number."

### Lessons from the runs so far (keep them)

- **Simulators must match the real vendor.** Twice the model was right and our fixture was wrong: HubSpot search
  allows `limit` 200 (not 100), and batch create returns a 207 with per-input results only when every input carries
  a unique `objectWriteTraceId`. Check fixtures against vendor docs before blaming the model.
- **Feedback must state the full expected end state, not just the violations.** Otherwise a rule nobody happened to
  break never reaches the learner, and agents overgeneralize. That's how existing contacts got reassigned.
- **Build sandboxes must outlive idle phases.** A 10-minute idle timeout killed builds whose root was waiting on
  children (fixed: 3 h lifetime, 60 min idle).
- **Keep laptops awake during live runs.** Network loss from sleep killed two runs.

---

## 7. Demo (2 minutes)

The miner and shipping steps are pre-recorded and sped up, and labelled that way. The agent calls run live on a fast
model (GLM 5p3 on Fireworks), plus a second vendor (e.g. Claude Haiku 5.5) to show the MCP works with any agent.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | An agent on the raw CRM answers "Q4 commit?" → **$493k** | "Agents can use HubSpot. They don't know *Acme's* HubSpot. The real answer is $605k." |
| 0:15–0:45 | Mining: rules appear with evidence and backtest scores; one question to Acme | "It digs the unwritten rules out of the data and history, and asks one question history can't answer." |
| 0:45–1:05 | Generated `get_commit` plus tests → Manufact preview → evals → promoted | "Rules become code and tests. Every change goes through a Manufact preview and evals." |
| 1:05–1:15 | The same agent makes one call → **$605k** | "One call. The agent read nothing. The rule can't be skipped." |
| 1:15–1:40 | A rule changes → a backtest fails → a fix ships via preview → a *different* agent gets it right | "When the business changes, the fix reaches every agent." |
| 1:40–2:00 | Chart: raw 0/8 · memory 4/8 · compiled (target) | "Company brains write it down. We compile it, on Manufact." |

The $493k / $605k figures come from a real GLM run on the Q4 forecast task.

---

## 8. UI principles

The UI is for humans, but it should make clear that agents are the users. The MCPs are the hero; the agent harness
stays out of sight.

The UI keeps the honeyflow grid style (dark): a ruled center column with four tabs, and a **terminal docked under
every tab** that shows what agents actually see. The agent view is never hidden behind a toggle.

- **Connections:** each system's `.md` and its secret (name only). Terminal: host-injected connection checks.
- **Discovery:** mined rules with evidence, held-out backtest scores and each rule's code, plus the one question for a
  human. Terminal: the miner's queries and backtests.
- **MCP:** tools with the rules compiled into each, a **Connect** panel (URL, Claude, Cursor) and versions
  (preview → tests → live). Terminal: an agent connecting (`initialize`, `tools/list`, `tools/call`) and the
  structured response with `rules_applied` and `assumptions`.
- **Live:** wrong vs right answer and the proof chart. Terminal: live MCP traffic from every agent; "Change a rule"
  shows a backtest breaking and v4 shipping.

Every screen is in `mock-ui/index.html` (open it directly; → steps through the 2-minute demo).

---

## 9. What exists in the repo (reuse)

| Piece | Where | Reuse as |
|---|---|---|
| Simulated Acme CRM with hidden rules + oracle | `eval/world/crm.ts` (branch `crm-integration`) | The demo system and the proof harness. It still needs generated **history** and planted drift |
| CRM transfer benchmark (HubSpot / Pipedrive / Zoho / Attio fixtures + docs) | `eval/crm/`, `templates/integration/demo/crm/` | Extra systems and contract fixtures |
| Recursive build harness, Modal sandboxes, transcripts | `src/harness/` | The builder agent |
| Integration repo, sealed validation, publish, rollback | `src/integrations/` | The compile → verify → ship pipeline. Change: produce owner-approved revisions instead of self-publishing |
| Trace SDK, live tool registry, OAuth | `src/sdk/` | Agent-side clients for the demo |
| Memory wiki (procmem) | `src/`, `/mcp` | The baseline in the proof chart |

New work:
- the miner (profiling, history mining, backtesting, the evidence-backed question);
- history generation with planted rules and drift in the simulator;
- intent-level MCP generation with provenance and `assumptions`;
- the `report_outcome` / `needs_decision` contract;
- Manufact preview and eval wiring;
- the UI.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Correlation mistaken for a rule | Backtest with a time split; only confirmed rules (by backtest or by a human) may drive write tools |
| History contains past mistakes | Measure rules as "explains X% of decisions"; ask about residual cases; never claim 100% |
| Writes damage data | Plan, then commit; human approval; prefer reversals over deletes |
| Secrets leak to models | Host-side injection only; tested redaction |
| Looks like a company brain | Demo shows one call and generated code, no wiki; brain is the baseline |
| Manufact features not available headlessly | Day-1 check; fall back to the REST API we already use |
| Demo fragility | Seeded simulator, pinned models, pre-recorded build, laptop kept awake |

## 11. Open questions

1. Does this fully answer Manufact's ownership concern? Ask them in one sentence before going all-in.
2. Which systems do Manufact's customers most want compiled first?
3. Are previews, evals and logs available through Manufact's API today?
4. (Named: walter.)
