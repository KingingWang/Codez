# Codex desktop validation — 2026-09-22

## Scope

The adapter and distribution live entirely in ZCode. The sibling Codex checkout
was used read-only; its worktree remained clean. The runtime is pinned to
`KingingWang/codex` release `codex-20260921-084453`, commit `40b83ea62f`, with six
per-target SHA256 values in `scripts/codex-runtime-manifest.json`.

Tests that exercise native execution use temporary Codex homes, synthetic input
and a loopback model fixture. They do not mutate the developer's account, call a
paid model, install external plugins, or grant real tool approvals.

## Local results

| Check                                                            | Result                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm typecheck`                                                 | Passed, including bridge                             |
| `pnpm lint`                                                      | Passed; 70 pre-existing warnings, zero errors        |
| `pnpm fmt:check`                                                 | Passed                                               |
| `pnpm architecture:check --changed`                              | Zero violations                                      |
| Bridge tests with the pinned auxiliary-test binary               | 302 passed, zero skipped                             |
| Distribution regression tests                                    | 35 passed                                            |
| Service, Desktop and remote regression tests with CI environment | 38 passed; one real-package test is separately gated |
| Native UI parser/render/selection tests                          | 24 passed                                            |
| Real pinned Codex plus packaged bridge smoke                     | Passed                                               |

The native bridge smoke covers account/config reads, isolated auxiliary generation,
thread creation, image upload/preview, both native queued input and immediate
`turn/start` input, streaming, restart/snapshot recovery, command deduplication,
file-preserving queue edits, history epoch changes, deletion and revoked previews.
Both native `image.detail: null` and provisional `localImage.detail: null` have
regression coverage. Mock transport tests separately cover framing, bounds,
backpressure, native server-request resolution, stale approvals, malformed native
payloads, ambiguous mutations and workspace/identity isolation.

For reproducible desktop and browser interaction checks, see
`packages/ui/src/settings/codex/qa/README.md`. A rendered mock UI is not counted as
proof of actual Electron/Host/native execution.

The actual standard `dev.mjs` desktop entry passed six full-turn checks with a
fresh profile and pinned native runtime: first-message image input, streamed
response, busy setting locks, blocked busy `/plan` with draft retention, queued
image admission, and automatic native dispatch after the current turn completes.
Three native turns completed with zero renderer page errors. The separate browser
interaction suite covers native question/approval forms and settings mutations
against deterministic Host fixtures rather than a real account.

The first six-target CI run exposed two platform defects: macOS path aliases were
incorrectly rejected as a different workspace, and Windows Git Bash tar treated
drive-letter archive names as remote hosts. The bridge now verifies filesystem
aliases without changing Host identity; the native smoke uses a symlink/junction
workspace on every platform. Archive operations use an archive-parent cwd and a
relative `-f` argument. A separate macOS cold-start flake in the timeout test was
fixed with an explicit late-reply barrier, not by retrying mutations or disabling
the test. These fixes require a new native matrix run before acceptance.

## Distribution acceptance

The workflow is `.github/workflows/codex-desktop.yml`. It builds six native
OS/architecture combinations and uploads installers plus SHA256 manifests.
Every matrix job must pass on the final pushed commit before claiming all-platform
acceptance. Local Linux packaging does not validate macOS or Windows packaging.

The final local production Linux x64 AppImage and DEB were built successfully,
with root version `3.14.0` and independent product name `ZCode Codex`. Native code
and the bridge are outside ASAR; all 2,765 packaged application output files
matched the freshly built output. The four remote target sets contain 32 verified
manifest-selected resource files.

Real bundled remote deployment is checked separately by running
`packages/server/test/codexBundledRemoteAssets.test.ts` with
`ZCODE_TEST_BUNDLED_REMOTE_ASSETS_DIR` pointing at the produced archives. This uses
the real materializer and local-upload installer against a temporary remote home,
then executes the shipped Node, server, bridge and Codex resources.

## Explicit remaining limits

- Signing/notarization needs owner-managed credentials. Unsigned installers are
  named accordingly. Automatic updates are disabled; no upstream update feed is used.
- Real external SSH/WSL connections and real login/logout, OAuth and plugin installs
  were not exercised. Local deployment tests do not prove those external flows.
- Legacy dynamic workflows, proprietary CUA, cloud sharing and off-peak services
  are not native Codex equivalents. Unsupported operations fail explicitly.
- History editing/retry changes native conversation history, not workspace files.
  There is no fake file rewind or destructive Git reset fallback.
- A lost mutation reply can have an unknown outcome; mutations are not blindly
  retried. Reconnection uses authoritative snapshots, not a claimed durable delta log.
- Images and UTF-8 text attachments are supported; unsupported binary formats are
  rejected. Original text-attachment boundaries cannot be reconstructed from native
  merged text. Oversized unprojectable conversation content errors explicitly.

These limits are acceptance boundaries, not evidence that the corresponding legacy
features were migrated. See `docs/codex-desktop.md` for runtime and configuration use.
