# Codex desktop validation — 2026-09-22

## Scope

The adapter and distribution live entirely in Codez. The sibling Codex checkout
was used read-only; its worktree remained clean. The runtime is pinned to
`KingingWang/codex` release `codex-20260921-084453`, commit `40b83ea62f`, with six
per-target SHA256 values in `scripts/codex-runtime-manifest.json`.

Validated production source: `a1dcf9d162af4e2705bf96841df98fbffcc72c38` on
`KingingWang/Codez`, branch `feat/codex-desktop-adapter`. Any later documentation-only
acceptance commit does not change the code used to produce these installers.

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
the test. Windows startup now explicitly canonicalizes the execution directory;
test cleanup sends EOF for orderly native shutdown and preserves any primary
failure rather than masking it with a locked temporary-directory error.

## Distribution acceptance

The workflow is `.github/workflows/codex-desktop.yml`. It builds six native
OS/architecture combinations and uploads installers plus SHA256 manifests.
Every matrix job must pass on the final production source commit before claiming all-platform
acceptance. Local Linux packaging does not validate macOS or Windows packaging.

GitHub Actions run: `KingingWang/Codez` / `35713167778`, source `a1dcf9d`.
Final workflow conclusion: **success**. The remote-assets job and all six native
build jobs completed successfully, including their real Codex smoke checks.
All six installer artifacts were confirmed present, nonempty, unexpired and backed
by GitHub's SHA256 artifact digest. Each installer artifact also contains its own
per-file SHA256 manifest. Desktop artifacts have a 14-day retention period.

| Target        | Installers    | Artifact                            |
| ------------- | ------------- | ----------------------------------- |
| macOS x64     | DMG           | `codez-darwin-x64-unsigned`   |
| macOS arm64   | DMG           | `codez-darwin-arm64-unsigned` |
| Windows x64   | NSIS EXE      | `codez-win32-x64-unsigned`    |
| Windows arm64 | NSIS EXE      | `codez-win32-arm64-unsigned`  |
| Linux x64     | AppImage, DEB | `codez-linux-x64-unsigned`    |
| Linux arm64   | AppImage, DEB | `codez-linux-arm64-unsigned`  |

The additional `codex-remote-assets` artifact contains the four remote native
target sets. No release/tag or upstream update was published by this delivery.
The workflow's release job is intentionally skipped for this feature-branch push.

The final local production Linux x64 AppImage and DEB were built successfully,
with root version `3.14.0` and independent product name `Codez`. Native code
and the bridge are outside ASAR; all 2,765 packaged application output files
matched the freshly built output. The four remote target sets contain 32 verified
manifest-selected resource files.

The real packaged Linux application (not a development server or modified ASAR)
also passed all six full-turn checks on the source commit above. Evidence included
the actual Host, bridge and `codex app-server --listen stdio://` process paths,
three completed native turns and zero renderer page errors. All QA-owned
processes were then stopped.

Local build SHA256 receipts (CI builds publish their own checksum manifests):

| Local resource     | SHA256                                                             |
| ------------------ | ------------------------------------------------------------------ |
| Linux x64 AppImage | `a1ba7e5745ecf60c42d84fabc51f7f5db105fb9f017a968331d52f08471a856b` |
| Linux x64 DEB      | `cd60aaf90fcfad6ae9d1e206b2497704d2ff001dab9e2b98b6c5039aef09a647` |
| Packaged bridge    | `47edc7b75b3a1527e02903256a630f926c644b518d19f3a90bc630115f1d75f7` |
| Packaged ASAR      | `ecb9bd651b4d9198abc8d3d582c101359ccfedc4e6206deef85503a90eb1324e` |

Real bundled remote deployment is checked separately by running
`packages/server/test/codexBundledRemoteAssets.test.ts` with
`CODEZ_TEST_BUNDLED_REMOTE_ASSETS_DIR` pointing at the produced archives. This uses
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
- Sidebar archive/unarchive remains desktop-owned task-list metadata; it is not
  synchronized with native Codex CLI thread archive state.
- A lost mutation reply can have an unknown outcome; mutations are not blindly
  retried. Reconnection uses authoritative snapshots, not a claimed durable delta log.
- Images and UTF-8 text attachments are supported; unsupported binary formats are
  rejected. Original text-attachment boundaries cannot be reconstructed from native
  merged text. Oversized unprojectable conversation content errors explicitly.

These limits are acceptance boundaries, not evidence that the corresponding legacy
features were migrated. See `docs/codex-desktop.md` for runtime and configuration use.
