# Codez desktop

This community fork uses the unmodified Codex app-server as its execution engine.
It is not an official OpenAI desktop application. No neighboring Codex checkout
is needed to build or install this project.

## Development

Use Node **24.14.0** and pnpm **10.33.2**:

```sh
pnpm install --frozen-lockfile
pnpm dev:desktop
```

The desktop starts a workspace-scoped bridge, which starts `codex app-server
--listen stdio://`. The development entry builds the bridge and prepares the
checksum-verified native executable automatically. Set `CODEZ_CODEX_COMMAND` to
an absolute executable path to explicitly select another development installation.
Packaged applications use the verified bundled executable.

Every CI run resolves the latest `KingingWang/codex` release into a run-scoped
manifest (`scripts/codex-runtime-resolve-latest.mjs`), using GitHub's per-asset
SHA256 digests; all six native builds share that manifest via the
`codez-manifest` artifact and the `CODEZ_CODEX_MANIFEST` environment variable.
The checked-in `scripts/codex-runtime-manifest.json` is only the
local-development fallback and can be refreshed with the same script. Queue APIs
require the experimental app-server handshake. Generated schemas can be
inspected with:

```sh
node scripts/codex-runtime-schema.mjs packages/codex-bridge/dist/schema
```

An explicitly configured `CODEZ_AGENT_SERVER_COMMAND` retains the advanced custom
runtime override. Such a process must speak Codez's desktop protocol; a raw Codex
executable does not speak that protocol and belongs in `CODEZ_CODEX_COMMAND`.

## Accounts and configuration

Open a workspace, then open **Settings → Codex**. Account login/logout, model and
reasoning choices, effective configuration, skills, MCP servers and plugins use
the native Codex APIs. Codex owns credentials and configuration; the desktop does
not copy tokens into Codez's legacy provider settings. Existing Codex CLI settings
and authentication are reused through its normal `CODEX_HOME` resolution.

Native login completion can be checked with the settings refresh action. Custom
model-provider configuration remains native Codex configuration. Errors from
managed policies and version-conflicted configuration writes are shown rather
than silently overwriting newer settings.

The fork has a separate product identity and desktop data root. Existing Codez
history is not automatically converted, and native Codex history is never claimed
to be a lossless import of Codez workflows or proprietary tool state.

## Conversation behavior

- Codex owns threads, turns, durable messages and the accepted input queue.
- Busy input can steer the current turn or enter the native queue. Native queues
  **automatically start when idle**, including on cold resume; they do not provide
  Codez's legacy held-queue/auto-drain switch.
  Starting a selected queued input is idle-only in Codex. The desktop does not
  promise an atomic "stop current turn and immediately promote this input" action;
  native auto-dispatch can race with that two-mutation approximation.
- Command correlation is persisted separately from native history. A lost reply
  can leave an **unknown outcome**. The bridge does not blindly resend a mutation.
- Approvals and questions are scoped to the native request and turn. Unknown
  approval types fail closed; reconnect does not synthesize an old approval.
- Editing or retrying paginated history changes conversation history only.
  It does **not** undo files. File rewind is unavailable rather than approximated
  with destructive Git operations.
- Uploaded images use native local-image inputs. UTF-8 text attachments become
  native text. Unsupported binary/audio/video/PDF inputs fail explicitly.
- AI Git commit-message generation uses a restricted ephemeral native thread,
  with no model tools, shell, MCP or persisted conversation; cancellation targets
  only that auxiliary turn. It never runs in the main conversation.
- Desktop and mobile attachment routes retain their distinct identities. Recovery
  uses a fresh authoritative snapshot; the bridge does not claim durable delta
  replay support it does not implement.

Git, file browsing and terminal operations remain desktop/Host services. Legacy
dynamic workflows, off-peak business services, cloud sharing and proprietary CUA
integrations must not be assumed to have Codex equivalents simply because the
desktop shell can render their old controls. Capability limitations are explicit.

## Remote workspaces

Installed desktops carry verified remote components for Linux/macOS x64/arm64;
Windows WSL uses the detected Linux target. For source development, prepare those
components before connecting:

```sh
pnpm prepare:remote-assets
pnpm dev:desktop
```

The existing deployment owner verifies and materializes bundled archives into a
target/SHA-scoped cache, then installs under `~/.codez-codex/server`. It does not
fall back to the old GLM runtime or upstream CDN. A pre-existing remote-download
preference cannot bypass the bundled Codex components.

Native authentication remains on the target machine (`CODEX_HOME` / normal Codex
home resolution). The desktop never copies local credentials to a remote host.
Bridge metadata and Codez application data are isolated under `~/.codez-codex`.
Local real-archive deployment is covered by tests; actual external SSH and WSL
transport acceptance still requires suitable target environments.

The agent launcher wrapper and prompt-attachment staging follow the same flavor
layout. Wrappers resolve `runtime_root` from the flavor server root
(`~/.codez-codex/server` for Codex, `~/.codez/server` for legacy) for both the
node binary and the agent bundle, and deployments rewrite the wrapper whenever
its content differs, on every backend (SSH/Docker/WSL). Prompt attachments stage
under `<data-base>/tmp/prompt-attachments` (`~/.codez-codex` for Codex).
References pointing at the pre-isolation legacy root (`~/.codez`) are still
recognized and cleaned up so in-flight attachments keep working; orphaned tmp
files uploaded before the switch are left in place and are not migrated.

## Verification and distribution

```sh
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm test:codex
node --test scripts/test-codex-bridge-smoke.mjs
```

The native bridge smoke uses a temporary Codex home and a loopback model fixture,
not the developer's credentials. It exercises actual native queue admission,
streaming, process restart, history and duplicate-command reconciliation.

`.github/workflows/codex-desktop.yml` builds native macOS, Windows and Linux
artifacts for x64 and arm64. Build artifacts include SHA256 manifests. Optional
signing uses protected GitHub environments; unsigned builds are labeled as such.
Every branch/tag push automatically publishes a downloadable GitHub Release after
all six native jobs pass. `main` produces stable releases; other refs produce
prereleases. Pull requests only validate and never publish. Manual runs publish by
default, with a `publish` switch to opt out. Explicit GitHub skip-CI commit markers
still skip the workflow, so do not use them when a release is wanted.

Each release is named `codez-build-<run-id>-<short-sha>` and points to the exact
built commit. The release job checks all eight installers against their SHA256
manifests, uploads only the installers to a temporary draft, checks the uploaded
asset digests, then makes it public. Checksum manifests are pipeline-internal and
not release assets. Failed uploads remain drafts and can be resumed by rerunning
the failed job. A rerun verifies an already-public release without replacing its
assets. Per-platform updater YAML files are not released.

Find installers under **KingingWang/Codez → Releases**, not only the workflow's
14-day Artifacts. Only a release built from the current main head is eligible for
Latest; older completed builds remain downloadable without replacing it.

The fork does not install upstream Codez updates. Automatic updates remain off
until a complete trusted fork feed, signing and platform update manifests are
configured. This prevents an update from replacing the adapter with upstream's
different runtime.
