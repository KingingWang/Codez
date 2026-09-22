# Codex desktop distribution

Status: implementation in progress.

The fork publishes ZCode Codex desktop builds from KingingWang/ZCode. Preserve
upstream history and license notices. Use an independent application identity,
desktop data directory and update feed; do not update a fork install to upstream.

Pin the Codex release and SHA256 for each of darwin/linux/win32 × x64/arm64.
Download only the selected target asset, validate before atomic staging, and
package it outside ASAR. A local explicit override is allowed for development;
release CI must use pinned, validated artifacts. No adjacent checkout dependency.

CI uses Node 24.14.0 and pnpm 10.33.2, frozen dependency installation, typecheck,
lint, architecture and adapter tests. Build six native targets with fail-fast
disabled to collect independent results, but never mask an individual failure.
Smoke-test Codex handshake and package resources. Upload installers and SHA256
manifests; release publishing is explicitly triggered, not performed on arbitrary
pull requests. Build jobs need read-only repository permissions.

macOS: DMG/ZIP; Windows: NSIS; Linux: AppImage/DEB initially. A platform is accepted
only after its actual job succeeds. Unsigned artifacts are labelled as such;
signature/notarization and automatic-update trust need configured credentials.
Do not silently substitute legacy remote support to make a package build succeed.
Local desktop builds must succeed independently of remote deployment readiness.
Remote consumers use bundled native archives; missing or invalid assets fail
explicitly rather than preparing or deploying the old GLM CLI.

Public desktop dev/build/bundle commands and standalone builder configuration default
to `ZCODE_DESKTOP_RUNTIME=codex`, including the isolated Codex product flavor.
Only explicit `ZCODE_DESKTOP_RUNTIME=legacy` retains upstream identity/runtime behavior.
The dev entry prepares the verified native binary and builds the bridge before starting
Electron, then passes the selected native path to Host. No manual build prerequisite.

## Runtime isolation and remote boundary

`codex` is an explicit product flavor, independent of test/production backend.
Main owns the desktop identity: ZCode Codex (ZCode Codex Dev when unpackaged),
the `zcode-codex` protocol and OS registration names. It must not consume
`zcode:` links or overwrite upstream desktop/Finder/Explorer registrations.
Electron userData/sessionData use that identity. Business storage keeps the
existing services path contract under an isolated base: by default
`~/.zcode-codex/.zcode/v2`; an explicit custom base is namespaced with
`.zcode-codex` too. Bootstrap settings stay anchored in the fork's home root,
and Main forwards the resolved base to Host before services are created.
No upstream settings/credentials/cache are migrated or reused implicitly.

```
compiled codex flavor → Main identity/bootstrap owner → isolated settings/base
                                                  └→ Host env → services paths
verified release asset → immutable staging → resource checks → packaged Codex
```

Runtime update checks for Codex resolve only to KingingWang/ZCode releases.
The private Desktop workspace package carries a valid development SemVer (`0.0.0`)
because standard `dev.mjs` launches Electron against that package and updater
construction reads its version before update-disable policy runs. No QA-only
updater replacement is permitted; release builder metadata overrides this with
the root release version.
Until merged architecture-specific update metadata and signing trust are
published, checks open that release page rather than invoking the upstream
manifest provider or auto-installing unsigned artifacts. Preview/production
retain their existing behavior.

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
- `deployShared.ts`, `deploy.ts`, `zcodeAgentDeploy.ts`, `connect.ts`: isolate
  `~/.zcode-codex/server`, deploy Codex instead of GLM/plugin packages, retain
  identity/lease/refresh guards, and pass explicit resolved remote paths.
- `packages/services/src/zcode-agent/codexBridgeCommand.ts`: resolve the
  deployed bridge via `ZCODE_CODEX_BRIDGE_PATH`; invoke the remote Node with
  the bridge and pass the pinned executable through `ZCODE_CODEX_COMMAND`.
- Remote Node uses 24.14.0 rather than the old producer's 22.16.0, with pinned
  checksums/notices. Codex app configuration stays owned by
  native Codex; desktop does not copy credentials to satisfy startup.

Acceptance: explicit flavor and fallback tests; disjoint bootstrap/data roots;
Codex-only deep-link parsing and OS registrations; manual updates cannot reach
the upstream provider; verified real bridge build; mocked remote component
integrity and explicit failure for unsupported deployment; root typecheck/lint
and desktop build with any cross-owner integration failures reported.
