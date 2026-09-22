# Follow-up turn reliability — 2026-09-22

This receipt covers the ZCode-only fixes following the macOS report on build
`61ff1e28`. The sibling Codex checkout and pinned native runtime are unchanged.
The supplied user log archive is not a committed fixture.

## Evidence boundary

The report confirms bridge exit code 1 after the second submission and repeated
duplicate thread-index failures. That build omitted the fatal exception type;
the exact exception responsible for the reported exit cannot be recovered from
that archive. Independent isolated tests reproduced both native repeated thread
records and a bridge crash on cross-turn reused item IDs. These compatibility
defects are repaired here, without claiming the archive proved one unique cause.

## Changes

- Presentation identity encodes turn and native item IDs. Native commands retain
  original IDs; attachment restoration and pending permission association follow
  the correct turn. Duplicate items inside one turn remain invalid.
- Native thread-list records are validated before selecting the most recently
  updated record per ID; equal timestamps keep the first record and list position.
  No native session/history file is rewritten or deleted.
- Sidebar invalidation no longer waits on the ordered conversation notification
  chain. Existing subscription coalescing, ordinals, epochs and route ownership
  remain unchanged for desktop-continuous and web-remote-replayable consumers.
- Production failures include a fixed category and origin, excluding arbitrary
  error text, stack paths, message IDs and secrets. Shutdown cleanup still attempts
  native transport close if another resource fails to close.
- Model-catalog reuse belongs to the existing workspace hook, with invalidation
  boundaries tested separately from model inference latency.

## Executed desktop regression

The actual Linux Electron development entry, Host, rebuilt bridge and verified
pinned native binary ran against an isolated no-auth loopback provider. Every
assistant response intentionally reused the same native item ID. Six checks
passed: first-image dispatch, busy controls, busy plan rejection, first response,
second-turn queue admission, and third-turn automatic image dispatch/completion.
Three native turns completed, none were interrupted, and no page errors occurred.

Final integrated evidence: `/tmp/codex-ui-desktop-conversation-ZlAKW3/results.json`
and adjacent screenshots. Observed click-to-provider times were 239 ms for the
first turn and 177 ms for the second (including automation/polling overhead). These numbers
describe this local fixture, not a promise about external provider latency.

Reproduce with the existing QA runners and an isolated temporary profile:

```sh
CODEX_UI_QA_MOCK=1 CODEX_UI_QA_REUSE_ITEM_ID=1 node packages/ui/src/settings/codex/qa/desktop-probe.mjs
# Use only the loopback mockProvider URL printed by the fresh probe:
CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-conversation-check.mjs
```

The renderer Vite server and freshly bundled bridge prerequisites are documented
in `packages/ui/src/settings/codex/qa/README.md`. No user credentials or paid model
requests are involved. This is not a claim of an executed macOS GUI test; macOS
and Windows packaging and native checks run in the existing release workflow.

## Verification summary

- Bridge suite with the pinned native auxiliary-test binary: 320 passed, no skips.
- Actual pinned native plus bundled bridge smoke: passed, including reused IDs,
  attachments, queue admission and process restart/history reconstruction.
- Service/desktop/remote regression suite: 38 passed; one real packaged-archive
  test skipped because it requires separately assembled remote assets.
- Distribution/publishing regression suite: 44 passed.
- Codex UI parser/render/selection suite: 24 passed.
- StrictMode browser suite: 16 checks passed, zero page errors, final evidence
  `/tmp/codex-ui-interaction-e2e-15m8Xh/results.json`. Covers warm sends without
  new discovery RPCs, workspace switching, config-write invalidation, failures,
  and captured readers after reload/unmount (both ready and in-flight).
- Root typecheck, formatting and architecture checks passed. Root lint passed
  with 70 pre-existing warnings and zero errors. Runtime/shutdown and UI catalog
  patches passed independent read-only code review.

The automatic six-platform build/release workflow is unchanged. Its native smoke
now exercises cross-turn reused IDs on every target. A new release is available
only after that workflow finishes; these local results do not claim CI completion.
