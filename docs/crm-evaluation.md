# CRM generalization evaluation

Question: do agents that learned procedures on some CRMs transfer them correctly to a very different CRM, and does
"specialize then surprise" differ from "start cold and learn several"? ERP agents specialized on one ERP were confused
by others; this benchmark measures the same risk for CRMs with real models and deterministic state oracles.

## What is real and what is synthetic

| Part | Status |
| --- | --- |
| Customer agents | REAL Fireworks models (Kimi `kimi-k3`, GLM `glm-5p3`, MiniMax `minimax-m3`) in isolated Pi 1.3 sessions; MiniMax via Pi's catalog transport (Fireworks Anthropic-messages endpoint) |
| Tools | procmem SDK `LiveToolRegistry` against a local procmem parent (memory MCP + subject-bound integration catalog); real MCP protocol |
| Traces | procmem SDK capture (`beginPiTrace`, conversationId `crmbench:<batch>:<cell>`, one runId per attempt, previousRunId on retry), full content-addressed blobs; scoring reads the STORED trace back |
| Memory builds | REAL `DailyBuildService -> runMemoryBuild` (Kimi root, GLM/MiniMax children, Modal workspaces) |
| CRM APIs | **SYNTHETIC CONTRACT FIXTURES** (`templates/integration/harness/fixtures/crm*`) of documented HubSpot / Pipedrive / Zoho CRM v8 / Attio v2 subsets (`eval/crm/CONTRACTS.md`). No vendor accounts or writes. |
| Docs | `eval/crm/docs/**`: paraphrased, pinned excerpts of official vendor docs (sources cited per page); HubSpot's proprietary spec is not vendored |
| Matrix adapters | host-authored raw-contract MCP children (`templates/integration/demo/crm/*`) on loopback: **local test publisher**, not Manufact |
| Adaptation demos | children really published to Manufact org `org-84350150-jpcs9`; their fixture upstreams run in Modal sandboxes behind encrypted tunnels |

## Design (predeclared in `.context/crm-eval-contract.md`, manifest `reports/crm-matrix-manifest-<batch>.json`)

- CRMs: A HubSpot + B Pipedrive (trained), C Zoho (near held-out), D Attio (far held-out). Near/far chosen from contract
  deltas before results (query style, typed values, multiselect PATCH-append vs PUT-replace, stage/status semantics).
- Task F1 (scored): for every OPEN deal of a named company/domain, set Next step and ADD a review tag keeping existing
  tags; nothing else may change. F2 (training only): mark a named deal won + add a tag.
- Training: 8 sessions; H = 4 HubSpot, M = 2 HubSpot + 2 Pipedrive; Kimi/GLM balanced. One build per curriculum from
  ONLY its own traces (namespaces `crmtr-h-*`, `crmtr-m-*`).
- Matrix: 3 models × {cold, H, M} × {A new org, C, D, C+D} = 36 fresh sessions; frozen memory revisions (cloned to
  `crmmem-*`, revision + tree hash checked before and after every cell) and frozen adapters/fixtures/docs (hashes
  checked against the manifest before and after the matrix). Held-out traces go to `crmev-*`, which no builder reads.
- Adaptation (same Pi object, 2 attempts each): far = M memory + host-seeded deficient Attio child -> real builder
  repair; cold = empty memory + generic HTTP tool -> real builder creates Zoho/Attio MCPs. Mechanism proof gates and
  task success are reported separately (`eval/crm/adapt.ts#computeGates`).

## Scoring

`eval/crm/oracle.ts`: full initial vs final canonical state of every company and deal of every visible CRM instance
(including hashes of all other user-editable fields) plus the fixture mutation log; any write outside the allowed
(record, field) set counts even if later reverted; writes to non-target CRMs are wrong-CRM writes. Answer-text ID
evidence is secondary. Fixture/oracle QA (62 tests incl. adversarial cases): `npx vitest run --config eval/crm/qa/vitest.config.ts`.
Scripted reference policies exist only for that QA and never produce traces.

## Running

```
npx tsx scripts/crm-gen-adapters.ts                 # regenerate adapter overlays (frozen before init)
npx tsx scripts/crm-infra-smoke.ts                  # unpaid infra smoke
npx tsx scripts/crm-run.ts --batch <id> --phase init|train|build|freeze|matrix|adapt-far|adapt-cold
npx tsx scripts/crm-report.ts --batch <id> [--aborted <id>]
npx tsx scripts/serve-demo-trace.ts --port 4320 --data-dir .context/crm-live   # live viewer
```

Limits: customers 18 turns / 48 tool calls / 240 s (training 16/40/300 s, adaptation 24/70/420 s per attempt);
builders per agent session maxSessions 1, maxTurns 40, maxToolCalls 160, maxDescendants 3, maxDepth 2,
maxConcurrentAgents 3, 15 min. Two explicit token ceilings (customer, builder: 20M input / 1M output each); a failed
budget checkpoint or provider auth error stops new paid calls.

Results are exploratory: one sample per cell, no statistical claims.
