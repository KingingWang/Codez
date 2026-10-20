# Codez

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="Codez" width="128" height="128" />
</div>
<p align="center">
  <strong>AI Coding Workspace Powered by the Native Codex Runtime (Desktop App · Web UI · Terminal Agent)</strong>
</p>
<p align="center">
  <a href="https://github.com/KingingWang/Codez/releases/latest"><strong>⬇️ Download Latest Release</strong></a> ·
  <a href="https://github.com/KingingWang/codex"><strong>📦 Codex Runtime Repo</strong></a> ·
  <a href="https://github.com/zai-org/ZCode/blob/main/README.en.md"><strong>📄 Upstream ZCode README</strong></a> ·
  <a href="docs/codex-desktop.md"><strong>📖 Codex Desktop Docs</strong></a>
</p>
<p align="center">
  <a href="https://github.com/KingingWang/Codez/issues/new">Report an Issue (GitHub Issues)</a> ·
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">Upstream Feishu Community</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

**Codez** ([`KingingWang/Codez`](https://github.com/KingingWang/Codez)) is an independent community fork of [`zai-org/ZCode`](https://github.com/zai-org/ZCode) that replaces the default desktop and remote execution engine with the native [`KingingWang/codex`](https://github.com/KingingWang/codex) (`codex app-server`). It is not an official OpenAI or Z.AI desktop application.

## ⬇️ Download Latest Release

Every `main` push that passes all six native platform builds and smoke checks is automatically published to [**GitHub Releases**](https://github.com/KingingWang/Codez/releases/latest). Pick the installer matching your OS and CPU architecture below:

| OS          | Architecture                       | Recommended Format                          | Download (Latest Release)                                                                                                                              | Installation & Auto-Update Notes                                                                                  |
| :---------- | :--------------------------------- | :------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| **macOS**   | Apple Silicon (`arm64` / M-series) | `.dmg` (installer)<br>`.zip` (auto-updater) | [**Get from Latest Release**](https://github.com/KingingWang/Codez/releases/latest)<br>File: `Codez-<version>-mac-arm64-unsigned.dmg`                  | Drag `Codez.app` into `Applications`. For unsigned builds blocked on first launch, run the `xattr` command below. |
| **macOS**   | Intel (`x64`)                      | `.dmg` (installer)<br>`.zip` (auto-updater) | [**Get from Latest Release**](https://github.com/KingingWang/Codez/releases/latest)<br>File: `Codez-<version>-mac-x64-unsigned.dmg`                    | Same as above; receives in-app updates from the `x64-latest` channel.                                             |
| **Windows** | `x64` (Standard PC)                | `.exe` (NSIS installer)                     | [**Get from Latest Release**](https://github.com/KingingWang/Codez/releases/latest)<br>File: `Codez-<version>-win-x64-unsigned.exe`                    | Supports custom install directories and differential (`blockmap`) updates on `x64-latest`.                        |
| **Windows** | `arm64` (Windows on ARM)           | `.exe` (NSIS installer)                     | [**Get from Latest Release**](https://github.com/KingingWang/Codez/releases/latest)<br>File: `Codez-<version>-win-arm64-unsigned.exe`                  | Native ARM64 build with `arm64-latest` differential auto-updates.                                                 |
| **Linux**   | `x64` (`amd64` / `x86_64`)         | `.AppImage` / `.deb`                        | [**Get from Latest Release**](https://github.com/KingingWang/Codez/releases/latest)<br>File: `Codez-<version>-linux-x64-unsigned.AppImage` or `.deb`   | Make `.AppImage` executable (`chmod +x`) to run directly with auto-update, or install `.deb` on Debian/Ubuntu.    |
| **Linux**   | `arm64` (`aarch64`)                | `.AppImage` / `.deb`                        | [**Get from Latest Release**](https://github.com/KingingWang/Codez/releases/latest)<br>File: `Codez-<version>-linux-arm64-unsigned.AppImage` or `.deb` | Native ARM64 Linux desktop packages bundling the `aarch64` Codex runtime.                                         |

> **macOS First-Launch Note**: Public builds are labeled `-unsigned` when built without Apple Developer signing credentials. If macOS Gatekeeper blocks the first launch, run:
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/Codez.app
> ```
>
> Click **Allow** when macOS prompts for permission to manage other apps (or enable your terminal under **System Settings → Privacy & Security → App Management**).

## 🔗 Related Repositories & Upstream Links

| Project / Document           | Link                                                                                                               | Description                                                                                                                                                                                                      |
| :--------------------------- | :----------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **This Repository (Codez)**  | [https://github.com/KingingWang/Codez](https://github.com/KingingWang/Codez)                                       | Community AI coding workspace integrating the native Codex bridge, Desktop, Web, and CLI                                                                                                                         |
| **Codez Releases**           | [https://github.com/KingingWang/Codez/releases/latest](https://github.com/KingingWang/Codez/releases/latest)       | Prebuilt native installers for macOS, Windows, and Linux (`x64` & `arm64`)                                                                                                                                       |
| **Referenced Codex Project** | [https://github.com/KingingWang/codex](https://github.com/KingingWang/codex)                                       | The native Codex CLI / `app-server` runtime bundled by this project (customized from [`openai/codex`](https://github.com/openai/codex) with privacy hardening and Completions / Anthropic wire protocol support) |
| **Upstream Project (ZCode)** | [https://github.com/zai-org/ZCode](https://github.com/zai-org/ZCode)                                               | Upstream open-source repository by Z.AI                                                                                                                                                                          |
| **Upstream English README**  | [https://github.com/zai-org/ZCode/blob/main/README.en.md](https://github.com/zai-org/ZCode/blob/main/README.en.md) | Original upstream English documentation                                                                                                                                                                          |
| **Upstream Chinese README**  | [https://github.com/zai-org/ZCode/blob/main/README.md](https://github.com/zai-org/ZCode/blob/main/README.md)       | Original upstream Chinese documentation                                                                                                                                                                          |
| **Codex Desktop Guide**      | [docs/codex-desktop.md](docs/codex-desktop.md)                                                                     | Detailed technical documentation on the Codex bridge, conversation behavior, remote deployment, and limitations                                                                                                  |

## 🔄 Key Differences from Upstream (`zai-org/ZCode`)

While staying synced with upstream `zai-org/ZCode` (currently `v3.15.1`) for the workbench UI, Git/Worktree management, terminal, and plugin ecosystem, this project substantially re-architects the execution runtime, remote workspace pipeline, native tooling, and release system:

| Area                                | This Fork (`KingingWang/Codez`)                                                                                                                                                                                                                                                                                      | Upstream (`zai-org/ZCode`)                                                                                  |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| **Default Desktop Engine**          | Runs the native [`KingingWang/codex`](https://github.com/KingingWang/codex) binary (`codex app-server --listen stdio://`) adapted via [`packages/codex-bridge`](packages/codex-bridge). No adjacent Codex checkout is needed (`CODEZ_DESKTOP_RUNTIME=legacy` opts back into the old runtime).                        | Uses the built-in Node/JS Agent runtime (`apps/zcode-cli` / GLM bundle).                                    |
| **Accounts, Models & Config**       | Managed under **Settings → Codex**. Reads/writes native Codex configuration (`~/.codex/config.toml`, `models.json`), reuses existing `CODEX_HOME` authentication, and supports OpenAI / Responses / Completions / Anthropic `wire_api`, custom providers, MCP servers, Agent Roles, skills, and hot-reloaded memory. | Uses Z.AI accounts, Coding Plan gateways, and built-in provider catalogs.                                   |
| **Conversation & Queue Control**    | Native per-send **Queue** (auto-dispatch on idle) vs. **Guide** (`turn/steer` into the next model step), Preempt (interrupt and start), Safe File Rewind, Selection Side Chat, native `ApplyPatch` diff cards, and **read-only degradation with one-click Fork** on multi-writer lock conflicts.                     | Uses legacy internal agent queues and rollback mechanics.                                                   |
| **Remote Workspaces (SSH / WSL)**   | Ships SHA256-verified remote bundles (`darwin/linux` `x64/arm64`) into `~/.codez-codex/server`, automatically discovers external Codex CLI history on the remote machine, and **never copies local credentials to remote hosts**.                                                                                    | Pulls/uploads legacy GLM agent bundles from CDN / `mock-cdn` and syncs local credentials to remote targets. |
| **Computer Use & Browser Control**  | Bundles the open-source [`packages/codez-cua`](packages/codez-cua) runtime and native Helper (`@crowecawcaw/xa11y` for real Windows UIA, macOS AX, and Linux AT-SPI accessibility trees, window-bound screenshots, and semantic actions), bridged to native Codex sessions via local MCP.                            | Ships a stub Computer Use package in the open-source repo that returns an unavailable error.                |
| **Encrypted Mobile Remote Control** | Supports mobile Web remote control (`web-remote-replayable`) over Codex with end-to-end encryption (E2EE), relay-gzip compression, recovery backoff, and automated GitHub Pages deployment.                                                                                                                          | Basic relay forwarding tied to the legacy runtime.                                                          |
| **Product Identity & Isolation**    | Isolated app identity, URL scheme (`codez-codex://`), and data root (`~/.codez-codex`) so it never collides with upstream installations; in-app feedback routes directly to this repository's GitHub Issues.                                                                                                         | Uses `zcode://`, `~/.zcode`, and official feedback ticket services.                                         |
| **CI Releases & Auto-Update**       | Resolves the latest complete [`KingingWang/codex`](https://github.com/KingingWang/codex) release at build time, publishes SHA256-verified 6-target installers to GitHub Releases, and auto-updates via per-arch channels (`x64-latest` / `arm64-latest`).                                                            | Relies on internal signing pipelines and private OSS/CDN update feeds.                                      |

## 🧭 Choose an Entry Point

This repository contains the clients (Desktop & Web), backend services, shared UI, Codex protocol bridge (`packages/codex-bridge`), open-source Computer Use runtime (`packages/codez-cua`), and legacy Agent CLI and runtime source code (`apps/codez-cli`):

| Entry Point                        | Use Case                                                                                            | Command                                         |
| :--------------------------------- | :-------------------------------------------------------------------------------------------------- | :---------------------------------------------- |
| **Desktop (Default Codex Engine)** | Develop or run the Electron desktop app (automatically stages pinned native Codex + `codex-bridge`) | `pnpm bootstrap && pnpm dev:desktop`            |
| **Desktop (Legacy Engine)**        | Explicitly test the legacy built-in Agent CLI desktop runtime                                       | `CODEZ_DESKTOP_RUNTIME=legacy pnpm dev:desktop` |
| **Web / Unified CLI Distribution** | Run the browser or terminal TUI workbench locally without Electron                                  | `pnpm dev:web` or `codez --web`                 |
| **Agent CLI Source Development**   | Develop and debug the `apps/codez-cli` TUI and CLI directly                                         | `pnpm --filter @codez/cli dev`                  |

## Updates

- **2026-10-19**: Updated to Codez v3.16.2.
- **2026-10-16**: Updated to Codez v3.16.1.
- 2026-10-16: Integrated open-source Computer Use (`packages/codez-cua`) and native Codex browser/desktop MCP bridge.
- 2026-10-10: Updated to Codez v3.15.1.
- 2026-9-23: Updated to Codez v3.14.3.

## Quick start

Install Git, Node.js **24.14.0**, and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. Run all development and packaging commands below from the repository root.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies, prepares local desktop runtime assets, and runs `build:bootstrap`.

The Agent CLI and runtime source code lives in [apps/codez-cli/](apps/codez-cli/) as a regular directory included when you clone this repository. No separate checkout or Git submodule initialization is required.

Additional setup and build commands:

| Command                        | Purpose                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                 | Install dependencies                                                                                                                |
| `pnpm prepare:desktop-runtime` | Prepare desktop runtime assets; set `CODEZ_SKIP_REMOTE_ASSETS=1` to skip remote assets                                              |
| `pnpm prepare:remote-assets`   | Prepare remote runtime assets separately                                                                                            |
| `pnpm bootstrap:with-remote`   | Set up dependencies and local and remote assets, then build the relevant packages sequentially; skip the desktop application bundle |
| `pnpm build:codex-bridge`      | Build the `@codez/codex-bridge` protocol adapter for desktop and remote hosts                                                       |
| `pnpm prepare:codex-runtime`   | Download and verify the pinned native Codex runtime for the current platform                                                        |
| `pnpm build`                   | Recursively run each workspace package's build script, including its asset preparation steps                                        |

The default `bootstrap` skips remote asset preparation and is suitable for local desktop development. Run the corresponding preparation command when working with remote workspaces or validating remote distribution assets.

## Development and Usage

### Desktop

```bash
pnpm dev:desktop

# Use the test environment
pnpm dev:desktop:test
```

`pnpm dev:desktop` defaults to `pnpm dev:desktop:prod` and uses production service configuration. In default Codex mode, the startup script builds `packages/codex-bridge`, verifies and stages the pinned native Codex binary, then starts Electron and source watchers. Set `CODEZ_CODEX_COMMAND=/abs/path/to/codex` to point to a custom local Codex executable.

Set `CODEZ_DATA_BASE_DIR` to use a separate development data directory. For example, on macOS / Linux:

```bash
CODEZ_DATA_BASE_DIR="$HOME/.codez-dev-home" pnpm dev:desktop:test
```

### Remote Workspaces (SSH / WSL)

- **Default Codex Desktop Mode**: Run `pnpm prepare:remote-assets` (or `pnpm bootstrap:with-remote`) before `pnpm dev:desktop` to stage verified remote Codex archives. The deployment service installs them under `~/.codez-codex/server` on the remote host without falling back to the legacy GLM runtime or upstream CDN. See [Codex desktop documentation - Remote workspaces](docs/codex-desktop.md#remote-workspaces).
- **Legacy Mode**: Run `pnpm bootstrap:with-remote` to prepare `mock-cdn` assets, then `CODEZ_DESKTOP_RUNTIME=legacy pnpm dev:desktop` and choose local upload when connecting.

### Web Development

Use development mode when editing Web or backend source code:

```bash
pnpm dev:web

# Set the backend workspace (macOS / Linux)
CODEZ_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

This starts both the Web development server (default: `http://localhost:5173`) and the backend (default: `http://localhost:3030`). Open the Web development server in your browser. `/ws` and general `/api` requests are proxied to the local backend; `/api/v1/oauth/token` is proxied separately to the configured product service.

After changing Agent source code, run `pnpm --filter @codez/cli... build` and restart the service. To validate the complete distribution, extract and run it as described under Packaging → Codez CLI distribution below.

### Codez CLI distribution

The command-line distribution includes the TUI, Web client, and Agent behind one `codez` command. With no arguments it starts the TUI; a leading `--web` starts Web mode; all other arguments go to the existing Agent CLI. Both modes run locally without Electron.

```bash
# Start the terminal UI by default
codez

# Start the Web interface
codez --web

# Set the project and port without opening a browser automatically
codez --web --workspace /path/to/project --port 3030 --no-open

# Show CLI or Web options
codez --help
codez --web --help
```

In Web mode, it uses the current directory as the workspace, listens on `127.0.0.1` without token authentication by default, selects an available port, and opens a browser. Use the URL printed in the terminal and press `Ctrl+C` to stop the service. For LAN access, use `--host 0.0.0.0`; listening on a non-local address generates an access token by default. Use the token-bearing URL printed in the terminal. Set a token with `--token`, or disable token authentication with `--no-token`.

When starting the general Web service's HTTP entry directly, configure API/WebSocket authentication with `CODEZ_SERVER_AUTH_TOKEN`. When creating the service programmatically, use the `authToken` option.

See Packaging below for build instructions. `pnpm build:codez` only creates the distribution; it does not replace an existing `codez` on `PATH`. If the command still points to an older installation or another checkout, check it with `command -v codez` on macOS / Linux or `where.exe codez` on Windows.

### CLI Source Development

Use the source entry when developing the TUI or Agent:

```bash
pnpm --filter @codez/cli dev --help
pnpm --filter @codez/cli dev

# Build the CLI and its workspace dependencies
pnpm --filter @codez/cli... build
node apps/codez-cli/packages/cli/dist/codez.cjs --help
```

This entry runs the Agent CLI directly and does not handle the distribution's `--web` switch. Use `pnpm dev:web` for Web development, or the extracted `bin/codez.mjs` shown below to test the unified command.

### UI Plugin development

See the [UI Plugin guide](UI_PLUGIN.en.md) for the Excalidraw workflow, supported APIs, plugin installation and updates, and host debugging.

**Plugin PRs in `codez-plugins` must declare whether they affect a UI Plugin and list the plugin names in the PR template.** See the [required plugin-type declaration](UI_PLUGIN.en.md#declare-the-plugin-type-in-pull-requests).

## Configuration

The root [.env.example](.env.example) provides sample service URLs and build configuration. Copy it to `.env` as needed and place local overrides in `.env.local`. Select the Desktop development environment with `dev:desktop:test` or `dev:desktop:prod`.

| Setting                              | Purpose                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEZ_DATA_BASE_DIR`                | Base directory for application data, stored under its `.codez/` subdirectory                                                                            |
| `CODEZ_SERVER_WORKSPACE`             | Workspace path for the Web backend                                                                                                                      |
| `CODEZ_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider configuration file; uses the built-in configuration when unset                                                                 |
| `CODEZ_DIST_BASE_URL`                | Download base URL used by the CLI distribution installer                                                                                                |
| `CODEZ_DESKTOP_RUNTIME`              | Desktop runtime selector: defaults to `codex`; set `legacy` for the old Agent runtime                                                                   |
| `CODEZ_CODEX_COMMAND`                | Absolute path override for the native `codex` executable launched by the bridge                                                                         |
| `CODEZ_CODEX_MANIFEST`               | Path override for the native Codex release & SHA256 manifest (defaults to [`scripts/codex-runtime-manifest.json`](scripts/codex-runtime-manifest.json)) |

Runtime variables can be set explicitly in the environment of the startup command. See [config/README.md](config/README.md) for the default configuration shipped with the client.

## Packaging

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for third-party notices and
[NOTICE.md](NOTICE.md) for project behavior, data handling, and execution risks.

### Desktop

```bash
pnpm bundle:desktop

# Set the target platform and CPU architecture
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

The default target is macOS arm64, and the default output directory is `packages/desktop/dist/`. `--os` accepts `mac`, `win`, or `linux`; `--arch` accepts `x64` or `arm64`. Packaging and signing require the tools and configuration for the target platform.

Install: open the DMG and drag Codez into Applications. Local builds are unsigned; if macOS blocks the first launch, run:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Codez.app
```

This command needs permission to manage other apps: macOS shows a consent prompt in the top-right corner of the screen, and you must click "Allow" for it to succeed. If you accidentally deny it, enable your terminal app under System Settings → Privacy & Security → App Management and run the command again.

### Codez CLI distribution

Run `pnpm build:codez` to build the CLI/TUI, backend, and Web client, collect the TUI native libraries, workers, and runtime dependencies, then assemble the distribution. Running the distribution still requires Node.js; use the version specified in `mise.toml`.

Before packaging, set the download base URL with `CODEZ_DIST_BASE_URL` in `.env`, `.env.local`, or the process environment, or pass it through `--base-url`. The URL below is a placeholder; replace it with your hosting URL when publishing:

```bash
pnpm build:codez --base-url https://downloads.example.com/codez/

# When CODEZ_DIST_BASE_URL is already configured
pnpm build:codez

# Repackage existing Agent, backend, and Web build outputs
pnpm build:codez --skip-build

# Show options for the version, output directory, and more
pnpm build:codez --help
```

The version defaults to the root `package.json` version. Output is written to `dist/codez/`:

- `releases/<version>/codez-<version>.tar.gz`: runtime package.
- `releases/<version>/sha256.txt`: checksum file.
- `latest.json` and `install.sh`: version index and installer.

Upload the entire directory to the configured download base URL. The installer downloads the runtime package from that URL, installs it to `~/.codez/runtime` by default, and creates the `codez` command in `~/.local/bin`. Override these directories with `CODEZ_DIST_HOME` and `CODEZ_DIST_BIN_DIR`, respectively.

Existing Lite users should switch to the new build command, environment variables, and installer. Installation does not remove old Lite directories or migrate/delete session data.

To test a packaged build locally, extract and run it directly without uploading or installing it:

```bash
codez_version=$(node -p "require('./dist/codez/latest.json').version")
mkdir -p dist/codez/debug
tar -xzf "dist/codez/releases/$codez_version/codez-$codez_version.tar.gz" \
  -C dist/codez/debug
# Start the TUI by default
node dist/codez/debug/codez/bin/codez.mjs

# Start Web mode
node dist/codez/debug/codez/bin/codez.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

Open `http://127.0.0.1:3030` to validate the complete flow, with one backend serving the Web pages and running the Agent. The port must be available; if `pnpm dev:web` is already running, choose another `--port`.

## Repository Structure

| Directory                                            | Responsibility                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main, Host, Renderer, and desktop packaging                                    |
| `packages/codex-bridge`                              | Bidirectional adapter between native Codex `app-server` and the Codez V4 protocol       |
| `packages/codez-cua`                                 | Open-source Computer Use runtime, capability broker, and cross-platform Helper          |
| `packages/web`                                       | Web client and encrypted mobile remote-control frontend                                 |
| `packages/server`                                    | HTTP / WebSocket services and remote connections                                        |
| `packages/codez-server-cli`                          | Standalone server startup and process management                                        |
| `packages/ui`                                        | Shared React components, hooks, and Zustand state                                       |
| `packages/services`                                  | Business services and persistence                                                       |
| `packages/shared`, `packages/rpc`, `packages/client` | Shared protocols and types, RPC framework, and Agent client SDK                         |
| `packages/provider`, `packages/provider-node`        | Common provider capabilities and Node implementations                                   |
| `apps/codez-cli`                                     | Agent CLI, TUI, runtime, and tools                                                      |
| `scripts`, `config`, `third-party`                   | Build and maintenance scripts, built-in configuration, and third-party notice materials |

## Pre-submit checks

After changing code or build configuration, run these commands from the repository root:

```sh
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm architecture:check --changed
pnpm test:codex
```

## Project Notice

See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for
licensing and third-party copyright information. See [NOTICE.md](NOTICE.md) for
feature scope, maintenance policy, execution risks, and data handling.
