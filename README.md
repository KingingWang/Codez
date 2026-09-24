# Codez

Codez 是一个包含桌面应用、Web 界面和终端 Agent 的 AI 编程工作台。
这是社区适配版，不是 OpenAI 官方桌面应用。

本 fork 的桌面端默认使用 **Codex CLI / app-server**，通过本仓库中的
`packages/codex-bridge` 适配现有桌面协议，不需要修改或克隆相邻的 Codex 源码。
桌面安装包内置对应平台运行时；账户、模型、权限、MCP、技能和插件请使用「设置 → Codex」。
构建、行为差异和限制见 [Codex 桌面说明](docs/codex-desktop.md)。

首次开发桌面端时，从仓库根目录执行：

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` 会安装 workspace 依赖、准备本地桌面运行资源并执行基础构建。
它默认跳过远程运行资源；需要 SSH / WSL 或验证远程发行资源时，使用
`pnpm bootstrap:with-remote`。GitHub Actions 的 **Codez desktop** 工作流生成
Windows、macOS、Linux 的 x64 / arm64 安装包。未配置签名时产物标记为 unsigned，
不会自动安装上游更新。

下方的开发说明同时覆盖桌面、Web 和 Agent CLI。桌面默认不是旧 Agent 运行时；
需要显式测试旧桌面运行时可设置 `CODEZ_DESKTOP_RUNTIME=legacy`。

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="Codez" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

## 选择开发入口

## 更新

- 2026-9-23：更新至 Codez v3.14.3 版本。

## 快速开始

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/codez-cli/](apps/codez-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `pnpm install`                 | 安装依赖                                                           |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源；设置 `CODEZ_SKIP_REMOTE_ASSETS=1` 可跳过远程资源 |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                               |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle  |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤          |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `CODEZ_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
CODEZ_DATA_BASE_DIR="$HOME/.codez-dev-home" pnpm dev:desktop:test
```

### 远程功能（SSH/WSL）

先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时资源选择「本地下载后上传」。开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，不访问 CDN。

### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
CODEZ_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @codez/cli... build` 并重启服务。需要验证完整发行包时，按下方“Codez 命令行版”打包章节解压运行。

### Codez 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `codez` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
codez

# 启动 Web 界面
codez --web

# 指定项目和端口，不自动打开浏览器
codez --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
codez --help
codez --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `CODEZ_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:codez` 只生成发行包，不会替换 `PATH` 中已有的 `codez`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v codez` 检查，Windows 可用 `where.exe codez` 检查。

### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @codez/cli dev --help
pnpm --filter @codez/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @codez/cli... build
node apps/codez-cli/packages/cli/dist/codez.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `codez` 命令，用下方解压后的 `bin/codez.mjs`。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `CODEZ_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.codez/`         |
| `CODEZ_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `CODEZ_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `CODEZ_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 打包

第三方声明和发行物中的许可材料见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；
项目功能、数据处理和运行风险见 [NOTICE.md](NOTICE.md)。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 Codez 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Codez.app
```

该命令需要"管理其他 App"的权限：执行时 macOS 会在屏幕右上角弹出授权提示，必须点击"允许"后命令才能成功；若误点"不允许"，前往"系统设置 → 隐私与安全性 → App 管理"，为你的终端 App 开启权限后重试。

### Codez 命令行版

构建入口为 `pnpm build:codez`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `CODEZ_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:codez --base-url https://downloads.example.com/codez/

# 已配置 CODEZ_DIST_BASE_URL 时
pnpm build:codez

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:codez --skip-build

# 查看版本、输出目录等可选参数
pnpm build:codez --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/codez/`：

- `releases/<version>/codez-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.codez/runtime`，并在 `~/.local/bin` 创建 `codez` 命令。安装目录可通过 `CODEZ_DIST_HOME` 修改，命令目录可通过 `CODEZ_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
codez_version=$(node -p "require('./dist/codez/latest.json').version")
mkdir -p dist/codez/debug
tar -xzf "dist/codez/releases/$codez_version/codez-$codez_version.tar.gz" \
  -C dist/codez/debug
# 默认启动 TUI
node dist/codez/debug/codez/bin/codez.mjs

# 启动 Web
node dist/codez/debug/codez/bin/codez.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/codez-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/codez-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 提交前验证

修改代码或构建配置后，建议在仓库根目录执行：

```bash
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm architecture:check --changed
```

## 项目声明

许可和第三方版权说明详见 [LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；
功能范围、维护规则、执行与数据风险详见 [NOTICE.md](NOTICE.md)。
