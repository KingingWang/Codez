# Codex desktop distribution

Status: unsigned six-target distribution accepted on 2026-09-22. GitHub Actions
run `35713167778` passed on source `a1dcf9d`; see
`docs/codex-desktop-validation.md` for evidence and the remaining signing,
automatic-update and external remote-validation boundaries.

The fork publishes Codez desktop builds from KingingWang/Codez. Preserve
upstream history and license notices. Use an independent application identity,
desktop data directory and update feed; do not update a fork install to upstream.

Each workflow run resolves the latest KingingWang/codex release and its GitHub
asset digests into a run-scoped manifest shared by all jobs; incomplete or
malformed releases fail closed. Download only the selected target asset,
validate before atomic staging, and package it outside ASAR. The checked-in
manifest remains the local-development fallback; CI must use the run-resolved,
validated manifest. No adjacent checkout dependency.

CI uses Node 24.14.0 and pnpm 10.33.2, frozen dependency installation, typecheck,
lint, architecture and adapter tests. Build six native targets with fail-fast
disabled to collect independent results, but never mask an individual failure.
Smoke-test Codex handshake and package resources. Upload installers and SHA256
manifests. Every branch/tag push builds and automatically publishes a public
release after all six targets pass; pull requests never publish. Build jobs need
read-only repository permissions.

The Linux regression gate also explicitly runs the UI tests for workspace-scoped automation model reads, valid default-model submission, and clean-repository Git tools. These tests live outside `settings/codex/` and must not be lost by relying on that directory glob alone. Test-path coverage is asserted by the workflow regression test; native six-target build, smoke and release gates stay unchanged.

## Per-push release publication

## Product identity

Codez is the fork's public product name. Repository, package, command,
environment-variable, desktop registration, deep-link, data-root, artifact, and
release names use the `Codez` / `codez` / `CODEZ` spelling. The legacy Codez
service host and service path remain unchanged when they identify an external
API contract rather than this product.

The release job is the only publication owner and the only job with contents-write
permission. It accepts artifacts from its own successful workflow run, verifies
all six installer/checksum sets, uploads them to a draft, verifies the uploaded
names, sizes and SHA256 digests, then publishes that draft. A failed build or upload
must not expose a partial public release. The upload set covers each target's
installers plus its updater metadata (channel `<arch>-latest*.yml` and
differential `*.blockmap` files), so published releases feed the Codex flavor's
automatic updates directly.

```text
push → remote assets → six native builds → verify checksums → draft upload
                                                         → verify assets → public release
```

Each run uses `codez-build-<run-id>-<short-sha>` targeting the exact built
commit. Reruns reuse that identity: incomplete drafts may resume; a complete public
release is verified without overwriting its assets. Unexpected ownership, commit,
assets or digests fail closed. Spaces in public asset names are normalized to dots
with corresponding regenerated checksum manifests, avoiding GitHub name rewriting.

Push runs do not share a branch concurrency group: a later push must not replace
an earlier pending build. Only superseded PR checks may be cancelled. Main pushes
publish stable releases; other refs publish prereleases. Only a build that still
matches the current main head is eligible to become Latest, preventing an older
slow build from deliberately replacing a newer main result. Manual dispatch keeps
an explicit publish switch, enabled by default. The workflow token creates release
tags without a separate user-token push loop. GitHub's explicit workflow-skip commit
markers and platform/account execution limits remain external trigger constraints.

Acceptance includes trigger/concurrency/permission tests; six-target completeness,
checksum corruption and duplicate/path rejection; draft upload failure; same-run
rerun; published-release immutability; and one actual main-push release with all
six targets and public download assets. Existing validated source/installer records
remain historical evidence, not proof of this new publishing path.

macOS: DMG; Windows: NSIS; Linux: AppImage/DEB initially. A platform is accepted
only after its actual job succeeds. Unsigned artifacts are labelled as such;
signature/notarization and automatic-update trust need configured credentials.
Do not silently substitute legacy remote support to make a package build succeed.
Local desktop builds must succeed independently of remote deployment readiness.
Remote consumers use bundled native archives; missing or invalid assets fail
explicitly rather than preparing or deploying the old GLM CLI.

Public desktop dev/build/bundle commands and standalone builder configuration default
to `CODEZ_DESKTOP_RUNTIME=codex`, including the isolated Codex product flavor.
Only explicit `CODEZ_DESKTOP_RUNTIME=legacy` retains upstream identity/runtime behavior.
The dev entry prepares the verified native binary and builds the bridge before starting
Electron, then passes the selected native path to Host. No manual build prerequisite.

## Runtime isolation and remote boundary

`codex` is an explicit product flavor, independent of test/production backend.
Main owns the desktop identity: Codez (Codez Dev when unpackaged),
the `codez-codex` protocol and OS registration names. It must not consume
`codez:` links or overwrite upstream desktop/Finder/Explorer registrations.
Electron userData/sessionData use that identity. Business storage keeps the
existing services path contract under an isolated base: by default
`~/.codez-codex/.codez/v2`; an explicit custom base is namespaced with
`.codez-codex` too. Bootstrap settings stay anchored in the fork's home root,
and Main forwards the resolved base to Host before services are created.
No upstream settings/credentials/cache are migrated or reused implicitly.

Remote auxiliaries follow the same flavor layout. Agent launcher wrappers are
generated from the current layout root: `runtime_root` defaults to
`$HOME/.codez-codex/server` (codex) or `$HOME/.codez/server` (legacy), resolving
both the node binary and the agent bundle from it, and deployments rewrite the
wrapper on content mismatch on every backend (SSH/Docker/WSL), not only WSL.
Prompt attachments stage under `<data-base>/tmp/prompt-attachments` where the
data base is `~/.codez-codex` for codex and `~/.codez` for legacy. References
under the pre-isolation `~/.codez` root stay recognized and cleanable; orphaned
pre-switch tmp files are left in place without migration.

```
compiled codex flavor → Main identity/bootstrap owner → isolated settings/base
                                                  └→ Host env → services paths
verified release asset → immutable staging → resource checks → packaged Codex
```

Runtime update checks for Codex resolve only to KingingWang/Codez releases.
The private Desktop workspace package carries a valid development SemVer (`0.0.0`)
because standard `dev.mjs` launches Electron against that package and updater
construction reads its version before update-disable policy runs. No QA-only
updater replacement is permitted; release builder metadata overrides this with
the root release version.

## Automatic updates (Codex flavor)

Codex installs auto-update from KingingWang/Codez GitHub releases through
electron-updater's GitHub provider. The upstream server manifest provider and
its stable/preview channel switching never apply to this flavor, and
`autoUpdater.allowPrerelease` stays `false`. Builds use a per-architecture
channel (`x64-latest` / `arm64-latest`): the publish config channels the
per-target updater metadata into distinct file names, so the six targets of one
release publish side by side without overwriting each other. At runtime the
main process passes that channel explicitly in `setFeedURL` — electron-updater's
GitHub provider resolves the channel only from the feed options (or
`autoUpdater.channel`) and never re-reads the baked `app-update.yml` once a feed
is installed, so an omitted channel silently falls back to `latest` and 404s on
`latest-mac.yml`. electron-updater appends its platform suffix to that channel
and fetches exactly one metadata file from the release marked Latest, then
verifies the SHA512 checksums recorded there before installing:

| platform | updater asset set per target                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `Codez-<version>-mac-<arch>[-unsigned].dmg`, `.dmg.blockmap`, `.zip`, `.zip.blockmap`, `<arch>-latest-mac.yml`                            |
| Windows  | `Codez-<version>-win-<arch>[-unsigned].exe`, `.exe.blockmap`, `<arch>-latest.yml`                                                         |
| Linux    | `Codez-<version>-linux-<arch>[-unsigned].AppImage`, `.AppImage.blockmap`, `.deb`, `x64-latest-linux.yml` / `arm64-latest-linux-arm64.yml` |

macOS updates require the zip artifact (dmg cannot drive Squirrel.Mac); the dmg
stays the manual-install option. The deb is installer-only and never
participates in updates. Checksum manifests and release upload validation cover
the exact asset sets above; anything else fails closed.

The release job still creates a draft, uploads and verifies the full set, then
publishes: current-main stable builds become Latest, other refs stay
non-Latest prereleases that `allowPrerelease=false` never offers. Runtime
behavior keeps the shared desktop policy: `autoDownload` remains `false`, the
user's auto-download preference drives any background download, and no
unconditional background install happens. Preview/production flavors retain
their existing manifest-provider behavior.

Unsigned builds are not signature-gated: Windows NSIS skips signature
verification when no publisher name is baked, and Linux has no signature gate.
macOS compares an update against the running app's code-signature identity, so
unsigned builds carry no certificate identity to pin either. Update integrity
therefore rests on the metadata SHA512 checksums fetched over HTTPS from
GitHub; introducing signing later must keep one stable Developer ID identity.

Installs older than the first updater-enabled release can never discover it
because their updater was disabled; they must install that one version manually
from the release page. Afterwards updates are automatic.

Remote Codex requires a native Codex binary plus bridge, Node compatible with
the bridge, server bundle, PTY and search components. A Codex component is not
a GLM component and must not be renamed to satisfy the old deployer. Producer
manifests and hashes are distinct; deployment must also adopt a fork-specific
remote root, component mount rules, startup env and bridge path resolution.
Consumers implement this contract through the existing deployment owner. Actual
external SSH/WSL transport remains separate from local artifact/install validation.

`scripts/codex-runtime-remote-assets.mjs` prepares all four darwin/linux x64/arm64
targets. Each desktop installer, including Windows for Linux WSL, carries these
archives outside ASAR in `resources/codex-remote/`. Development staging uses
`packages/desktop/bundled-resources/codex-remote/`. No target is compiled locally.

The remote-assets job builds the existing standalone server once per target and
assembles Node 24.14.0 (official SHASUMS pins), Codex/bridge, target PTY prebuilds,
repository search tools, notices and per-file hashes. It never builds the legacy
agent. The six native desktop jobs download the same complete remote assets artifact.
Build and packaging verify every selected archive, and package only current manifest
entries, excluding stale archives left by earlier builds.

The consumer contract is the existing `RemoteAssetManifest` schema:

```
codex-remote/
  releases/<appVersion>/manifest-<platformArch>.json
  releases/<appVersion>/runtime-<platformArch>.json
  components/<platformArch>/<id>/<archiveSHA256>.tar.gz
```

Manifest fields: `schemaVersion: 1`, `appVersion`, `platformArch`, `components`.
Each component has `id`, `version`, `sha256`, `artifactPath`, `mount`; artifact paths
are relative to `codex-remote/`. Mounts are `server`, `node/<platformArch>`,
`node-pty/<platformArch>`, `codex`, and `tools/<platformArch>/{bfs,ripgrep,ugrep}`
on Linux. macOS preserves the existing remote tool contract (ripgrep 13 only),
not the different desktop-local search plan. Tool versions retain archive revisions.
The Codex component id is `codex-runtime`; the other component ids are unchanged.
Materialization must use a target-scoped cache, since `codex` is a fixed mount.
Runtime descriptors record the integrated component mounting, fork-root, startup-env
and deployed bridge resolver contracts rather than a stale `deploymentReady` flag.
SSH/WSL transport validation remains explicitly `not-run` until exercised against
real targets; that validation record is informational, not a feature-disable switch.
Bundled archives require target-scoped materialization before the deployer consumes
them; an archive root must never be passed as an already-extracted mock CDN root.
Main passes `bundledRemoteAssetsDir` and a Codex-only cache through Host to the
server's existing deployment owner, without upstream CDN/mock fallback. The server
selects the detected target and verifies then materializes its manifest snapshot
before entering the existing install path; Main does not extract or select targets.
Home/root placeholders
require explicit remote-home resolution, never unquoted shell interpolation.

The package helper can also produce a flat standalone server archive for isolated
smoke; it is not a second deployment protocol. `scripts/codex-runtime-remote-smoke.mjs`
extracts verified native components and checks Node/server execution offline.

Integrated consumer boundaries:

- `packages/server/src/remote/remoteAssetCache.ts`: recognize `codex-runtime`
  and its mount; retain archive/hash validation.
- `deployShared.ts`, `deploy.ts`, `codezAgentDeploy.ts`, `connect.ts`: isolate
  `~/.codez-codex/server`, deploy Codex instead of GLM/plugin packages, retain
  identity/lease/refresh guards, and pass explicit resolved remote paths.
- `packages/services/src/codez-agent/codexBridgeCommand.ts`: resolve the
  deployed bridge via `CODEZ_CODEX_BRIDGE_PATH`; invoke the remote Node with
  the bridge and pass the pinned executable through `CODEZ_CODEX_COMMAND`.
- Remote Node uses 24.14.0 rather than the old producer's 22.16.0, with pinned
  checksums/notices. Codex app configuration stays owned by
  native Codex; desktop does not copy credentials to satisfy startup.

Acceptance: explicit flavor and fallback tests; disjoint bootstrap/data roots;
Codex-only deep-link parsing and OS registrations; manual updates cannot reach
the upstream provider; verified real bridge build; mocked remote component
integrity and explicit failure for unsupported deployment; root typecheck/lint
and desktop build with any cross-owner integration failures reported.
