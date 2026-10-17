# Demo integration: github-read (REAL GitHub REST contents API)

Used by scripts/real-integration-e2e.ts.

- `seeded/` is a **SEEDED DEFECT**, hand-written by the host as yesterday's state. It is not model-authored.
  - The wrapper always sends `?ref=master` and exposes no `ref` parameter.
  - That works for repositories whose default branch is `master`.
  - For `mcp-use/mcp-use` (default branch `main`), the real api.github.com answers
    `404 {"message":"No commit found for the ref master"}`, and a tag such as `v1.5.0` cannot be requested at all.
- `suites/` holds **host-held sealed validation suites**. They run OFFLINE in the Modal sandbox (network blocked)
  against the FAKE-data fixture `templates/integration/harness/fixtures/github-contents.mjs`, which mirrors
  https://docs.github.com/en/rest/repos/contents.
  - `v1` is the day-1 behaviour.
  - `v2-regression` reflects the trace failure: explicit ref, default branch, and surfacing GitHub 404 messages.
  - `v2-heldout` is sealed variants: slash branch, commit sha, nested path.
  - All of this is fixture data. Every live proof uses the real api.github.com through the deployed child.

The repair itself is NOT here. The daily build agent researches, edits, tests, commits, promotes and publishes it.
