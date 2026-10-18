# @procmem/shepherd-onboard: Mac uploader engine

This is the Mac uploader for the sources runtime's **iMessage** and **coding-sessions** device lanes. It is the
Shepherd `shepherd-onboard` engine, vendored and pinned from `askshepherd/gigabrain@5448774e0a121570666adaa0c8ca18570df72be9`
(`packages/shepherd-onboard`). It is the newest version of that CLI: the original local checkout, its later
checkpoints and its working tree all carry the same file. The engine is the program the Shepherd macOS app runs in
the background. Capture and upload behaviour are the donor's, unchanged except for the patches below.

## What is here

| Path | Origin |
| --- | --- |
| `bin/shepherd-onboard.js` | donor, plus `patches/0001-coding-sessions-source-sync-full-inventory.patch` |
| `source-selection.cjs`, `wiki-readiness.cjs`, `assets/` | donor, byte for byte |
| `tests/donor/*.test.ts` | the donor's CLI unit tests, plus `patches/0002-donor-tests-run-from-package.patch` |
| `vendor.json` | donor repo/commit/path, the git blob and sha256 of every vendored file, patch hashes, dependency pins |
| `scripts/verify-vendor.mjs` | proves that the shipped files are the donor plus the listed patches, and that dependencies are pinned |
| `scripts/install-launch-agent.mjs` | installs a LaunchAgent that runs **this** CLI (see below) |
| `tests/e2e/`, `tests/vendor.test.ts`, `tests/install-launch-agent.test.ts` | new: client -> production runtime tests |

Dependencies are exact versions, locked with integrity hashes in `package-lock.json`:

- `@photon-ai/imessage-kit` 3.0.0 (MIT; reads chat.db read-only through `better-sqlite3`);
- `ws` 8.21.0;
- `@modelcontextprotocol/sdk` 1.32.1 (used only by the engine's Shepherd MCP subcommands).

The engine itself is `UNLICENSED`: Shepherd AI, Inc. proprietary code, under the same terms as the Aqueduct sources
in `packages/sources-runtime`. Do not publish this package.

### Patch 0001: `source_sync` is a full inventory again

gigabrain `36067d43` capped a coding-sessions `source_sync` scan at 1,000 files per tool. The receipt stayed honest
(`capHit: true`), so a device with more files could never report a full inventory, and the donor's own test failed.
This patch restores the `d6561caf` semantics and keeps the `providers` filter:

- A `source_sync` scans every local transcript. `maxFiles` bounds rescans, not the inventory.
- A sync is bounded only when the command says `fullInventory: false`. Its receipt then reports
  `fullInventory: false, capHit: true` and coverage stays `partial`.
- Nothing is ever deleted because of a receipt.

### Not included

- The askshepherd memory/MCP CLI (`bin/shepherd.js`) and its skills.
- The Electron onboarding app (`packages/shepherd-onboard-app`). It signs in to Shepherd's hosted brain API, which
  yc_msaw does not serve.
- Signing and notarization, which are deferred.

**Office audio is not supported here.** The engine still contains the donor's office-audio collector, which
records the microphone and sends audio to third-party speech-to-text services (Speechmatics, Deepgram and others).
Its voice-enrolment sync calls `/api/office-audio/speaker-profiles`, which the runtime does not serve. It is
untested against the runtime, and `install-launch-agent.mjs` refuses it.

## Install and run on a Mac (Node 22 or later)

```sh
npm ci --prefix packages/shepherd-onboard
npm run verify --prefix packages/shepherd-onboard          # integrity of the vendored bytes
alias shepherd-onboard="node $PWD/packages/shepherd-onboard/bin/shepherd-onboard.js"
```

1. Mint a device in yc_msaw (shown once):
   - iMessage: `POST /v1/sources/devices/imessage/setup` returns `messagesConfig`.
   - Coding sessions: `POST /v1/sources/devices/coding-sessions/setup` returns `codingSessionsConfig`.
2. Write the config on the Mac. The key goes on stdin, never in argv:
   - `jq '.messagesConfig + {allowedChatIds:[…]}' setup.json | shepherd-onboard write-messages-config`. Only the
     selected chats are read and uploaded. Run `shepherd-onboard messages-chats` to list chat ids; it needs Full Disk
     Access.
   - `jq '.codingSessionsConfig + {providers:{openai:true,anthropic:true}}' setup.json | shepherd-onboard write-coding-sessions-config`
3. When you are ready to collect, install the background agent with
   `node packages/shepherd-onboard/scripts/install-launch-agent.mjs messages|coding-sessions --config <configPath>`.
   - Add `--dry-run` to print the plist first.
   - The engine's own `install-*-agent` points launchd at `npx -y askshepherd@latest`, the unpinned public package;
     this wrapper pins it to this checkout's `node` and `bin/shepherd-onboard.js`.
   - The Messages agent needs Full Disk Access for that `node` binary.
4. To make coverage complete, the device owner requests a source sync through yc_msaw:
   `POST /v1/sources/devices/<provider>/<bindingId>/commands`. Revoke the device with
   `DELETE /v1/sources/bindings/<bindingId>`; the runtime refuses it on its next request, and unsent data stays in
   the Mac's local retry queue.

## Tests

```sh
npm ci --prefix packages/sources-runtime     # the end-to-end tests drive the production runtime in process
npm ci --prefix packages/shepherd-onboard
npm test --prefix packages/shepherd-onboard
```

The suite has four parts:

- **Vendor pin.** Hashes, patch reversal and dependency pins match `vendor.json`, and tampering is detected.
- **Donor CLI tests.** 54 tests from gigabrain, including the `source_sync` full-inventory test that fails on the
  unpatched donor.
- **LaunchAgent wrapper.** Dry runs only; launchd is never touched.
- **End to end, client -> runtime.** These start the real runtime app (PGlite, real migrations, production
  iMessage and coding-sessions modules, and their HTTP yc_msaw authority against a local verify endpoint):
  - `coding-sessions-agent --once` on 1,006 synthetic transcripts. The runtime's `source_sync` gets an uncapped
    receipt, the upload goes in batches of at most 50, and coverage is `complete`. The unpatched donor, rebuilt
    from the patch, reproduces the cap.
  - A bounded sync gives an honest partial receipt and no deletions.
  - yc_msaw outage: 503 and a local retry queue. Revocation: 401, the runtime revokes the device, and coverage is
    `blocked`.
  - `messages-agent` (macOS) on a synthetic `~/Library/Messages/chat.db` and AddressBook under a throwaway HOME:
    - only the selected chats are uploaded;
    - tapbacks, attachment metadata (never bytes), group chats and contact names;
    - live WAL pickup, edits and unsend history;
    - an all-history `messages_source_sync` receipt makes coverage `complete`;
    - revocation leaves unsent messages queued on the Mac.
  - `MessagesBatchSender` splits 1,201 messages into 3 requests of at most 500.

The end-to-end files fail, rather than skip, when `packages/sources-runtime` is not installed. The chat.db capture
test needs macOS (imessage-kit refuses other platforms); everything else runs anywhere Node 22 runs. No real
Messages database, contacts or coding history is read.

Known donor quirks, kept as is:

- Contact names are built as `first || ' ' || middle || ' ' || last`, so a contact with no middle name renders as
  "Grace  Hopper" (two spaces).
- The final backfill status is posted without being awaited, so iMessage coverage turns `complete` a moment after
  the receipt rather than at the receipt.
