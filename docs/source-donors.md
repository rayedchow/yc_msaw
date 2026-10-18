# Source integration provenance and archaeology

The source runtime starts with Aqueduct's existing sourcing code, rather than independent rewrites of its provider parsers. `packages/sources-runtime/PROVENANCE.json` records donor paths and byte hashes; narrowly adapted files have explicit patch reasons and regression evidence. This inventory records the repository snapshots inspected for the pivot. It is not a claim that every repository contains a collector or that every provider is connected.

| Repository | Inspected commit | Context |
|---|---|---|
| [askshepherd/aeye-shepherd](https://github.com/askshepherd/aeye-shepherd/tree/67f987a9c2b1cb39b29daf1fb7e15c4f72da5736) | `67f987a9c2b1` | Shepherd customer-operated Linux deployment for AEye |
| [askshepherd/silicon](https://github.com/askshepherd/silicon/tree/a7b050cb7717b639857b6ce7739d543626844270) | `a7b050cb7717` | Hardware knowledge bases |
| [askshepherd/silicon-connector-e2e](https://github.com/askshepherd/silicon-connector-e2e/tree/07b103201e9aa4e72553f36f0655d4d68fd2fff5) | `07b103201e9a` | Shepherd connector end-to-end test fixture |
| [askshepherd/gigabrain](https://github.com/askshepherd/gigabrain/tree/5448774e0a121570666adaa0c8ca18570df72be9) | `5448774e0a12` |  |
| [askshepherd/skills](https://github.com/askshepherd/skills/tree/86a198ce316653249597297c50324a3729f9eaf0) | `86a198ce3166` | Private Shepherd Codex skills and supporting tools |
| [askshepherd/shepherd-landing-page](https://github.com/askshepherd/shepherd-landing-page/tree/500b511d3ca2dd9aaf5c9b43771a4160fc6ec7ab) | `500b511d3ca2` |  |
| [askshepherd/aqueduct](https://github.com/askshepherd/aqueduct/tree/b26d3f46236a36d64f841539abff2b1ffdace5cf) | `b26d3f46236a` | Data transport for agents: OAuth connectors in, always-fresh raw file mirror out. No processing. |
| [askshepherd/shepherd-scheduling](https://github.com/askshepherd/shepherd-scheduling/tree/93949db8391171da94a32a4fc0190e071d3cc8ed) | `93949db83911` |  |
| [askshepherd/internal](https://github.com/askshepherd/internal/tree/bac11b8553166b5fbe7eb03ea0d9f3d6b32b7b06) | `bac11b855316` | what are you doing ishan??? |
| [askshepherd/founder-company-brain](https://github.com/askshepherd/founder-company-brain/tree/5d972417308a8cdf8c63c31c735bb6e239b641b2) | `5d972417308a` |  |
| [askshepherd/creditflow](https://github.com/askshepherd/creditflow/tree/a27f508257217ebf64a24cd15b0db59758001003) | `a27f50825721` |  |
| [askshepherd/manifest](https://github.com/askshepherd/manifest/tree/8bd38be9ca0226254a88fc979048469f7d0bcff5) | `8bd38be9ca02` | Conversational ML research agent with thread-weaving architecture |
| [askshepherd/DRIFT](https://github.com/askshepherd/DRIFT/tree/c405fcdbc94bd87ab426c1535834b3ce06787654) | `c405fcdbc94b` |  |
| [askshepherd/demo-repository](https://github.com/askshepherd/demo-repository/tree/327082ffc094b77054105d02df706a507ef4a3cb) | `327082ffc094` | A code repository designed to show the best GitHub has to offer. |
| [rayedchow/yc_msaw](https://github.com/rayedchow/yc_msaw/tree/abe11999162e18b1f909555778bce442cbd6859e) | `abe11999162e` |  |

The target application base is `rayedchow/yc_msaw` branch `codex/procedural-memory` at `5c1fac0a8f0e1e6db0948d85c1d6f997d6a73724`. The target's default branch was an outline; the application branch contains the WorkOS/OIDC resource server and durable object store retained by this pivot.

## History that matters

- Aqueduct's July 2 transport split document describes the raw filesystem thesis: `docs/data-transport-repo-split.md`. Current Aqueduct also contains graph/wiki functionality; this port excludes those execution lanes.
- Google Docs OT, tab/suggestion handling, raw snapshots, freshness and replay behavior are distributed across Aqueduct and Gigabrain. Preserve the richer parser behavior and its tests rather than substituting generic exported text. Writer access and undocumented endpoint failures remain visible in coverage.
- Gigabrain's `codex/google-oauth-composio` branch at `21feb7132893710b0c734afc12ac043aad760d55` includes later OAuth changes. Its ancestor `0863b26624dc24f479807a6ef0a00beac97302fe` adds Composio Google OAuth and Docs diff events. The current main's DWD-only policy does not establish that OAuth support never existed.
- The existing Gigabrain Mac client defines the iMessage upload protocol. Aqueduct's iMessage helpers alone do not constitute a working receiver. The port must preserve canonical/legacy message identity and edit/retraction history, with device identity bound by the server.
- AEye/Silicon's Confluence surface calls an external integration gateway. The collector available within these repositories is Aqueduct's Nango implementation. Gateway client code is not evidence that its server-side implementation is present.
- May Google tool providers recovered from Gigabrain are references for read APIs, not evidence of a continuously running sync collector. Later branch implementations take priority when they contain the intended behavior.

Repository and branch scans found September work in Silicon, but have not established a separate September Google Docs OT implementation. Do not attribute code to that work without a verified commit/path.
