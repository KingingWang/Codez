# Codez

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="Codez" width="128" height="128" />
</div>
<p align="center">
  <strong>基于 Codex 原生运行时的 AI 编程工作台（桌面应用 · Web 界面 · 终端 Agent）</strong>
</p>
<p align="center">
  <a href="https://github.com/KingingWang/Codez/releases/latest"><strong>⬇️ 下载最新版本 (Latest Release)</strong></a> ·
  <a href="https://github.com/KingingWang/codex"><strong>📦 Codex 运行时仓库</strong></a> ·
  <a href="https://github.com/zai-org/ZCode/blob/main/README.md"><strong>📄 上游 ZCode README</strong></a> ·
  <a href="docs/codex-desktop.md"><strong>📖 Codex 桌面说明</strong></a>
</p>
<p align="center">
  <a href="https://github.com/KingingWang/Codez/issues/new">问题反馈 (GitHub Issues)</a> ·
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">上游飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

**Codez**（[`KingingWang/Codez`](https://github.com/KingingWang/Codez)）是基于开源项目 [`zai-org/ZCode`](https://github.com/zai-org/ZCode) 深度改造的社区分支，桌面端默认以 [`KingingWang/codex`](https://github.com/KingingWang/codex)（Codex CLI / `app-server`）作为核心执行引擎。本项目为社区独立适配版，不是 OpenAI 或 Z.AI 的官方桌面应用。

## ⬇️ 最新版本下载

每次 `main` 分支通过全平台原生构建与冒烟测试后，GitHub Actions 会自动在 [**Releases 页面**](https://github.com/KingingWang/Codez/releases/latest)发布 6 个平台的安装包及自动更新元数据。请根据你的操作系统和芯片架构在下方表格中选择对应安装包：

| 操作系统    | 芯片架构                         | 推荐安装包格式                             | 下载入口（Latest Release）                                                                                                                             | 安装与更新说明                                                                                      |
| :---------- | :------------------------------- | :----------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| **macOS**   | Apple Silicon (`arm64` / M 系列) | `.dmg`（手动安装）<br>`.zip`（自动更新源） | [**前往 Latest Release 下载**](https://github.com/KingingWang/Codez/releases/latest)<br>文件名：`Codez-<版本>-mac-arm64-unsigned.dmg`                  | 拖入 `Applications` 即可。未签名构建首次打开如遇拦截，请执行下方 `xattr` 命令移除隔离属性。         |
| **macOS**   | Intel (`x64`)                    | `.dmg`（手动安装）<br>`.zip`（自动更新源） | [**前往 Latest Release 下载**](https://github.com/KingingWang/Codez/releases/latest)<br>文件名：`Codez-<版本>-mac-x64-unsigned.dmg`                    | 同上，支持同架构 `x64-latest` 频道应用内自动检查更新。                                              |
| **Windows** | `x64`（主流 PC）                 | `.exe`（NSIS 安装程序）                    | [**前往 Latest Release 下载**](https://github.com/KingingWang/Codez/releases/latest)<br>文件名：`Codez-<版本>-win-x64-unsigned.exe`                    | 支持自定义安装目录及 `x64-latest` 频道增量（blockmap）自动更新。                                    |
| **Windows** | `arm64`（Windows on ARM）        | `.exe`（NSIS 安装程序）                    | [**前往 Latest Release 下载**](https://github.com/KingingWang/Codez/releases/latest)<br>文件名：`Codez-<版本>-win-arm64-unsigned.exe`                  | 原生 ARM64 构建，支持 `arm64-latest` 频道增量自动更新。                                             |
| **Linux**   | `x64` (`amd64` / `x86_64`)       | `.AppImage` / `.deb`                       | [**前往 Latest Release 下载**](https://github.com/KingingWang/Codez/releases/latest)<br>文件名：`Codez-<版本>-linux-x64-unsigned.AppImage` 或 `.deb`   | `.AppImage` 赋予执行权限后直接运行并支持自动更新；Debian / Ubuntu 可用 `apt` / `dpkg` 安装 `.deb`。 |
| **Linux**   | `arm64` (`aarch64`)              | `.AppImage` / `.deb`                       | [**前往 Latest Release 下载**](https://github.com/KingingWang/Codez/releases/latest)<br>文件名：`Codez-<版本>-linux-arm64-unsigned.AppImage` 或 `.deb` | 适用于 ARM64 Linux 桌面环境，内置原生 `aarch64` Codex 运行时。                                      |

> **macOS 首次打开提示**：公开构建默认标记为 `-unsigned`（未配置 Apple 开发者签名证书）。若首次启动提示“已损坏”或被 Gatekeeper 拦截，请在终端执行：
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/Codez.app
> ```
>
> 执行时 macOS 右上角会弹出“管理其他 App”授权提示，请点击“允许”（若误点不允许，可在「系统设置 → 隐私与安全性 → App 管理」中为终端开启权限后重试）。

## 🔗 相关仓库与上游文档链接

| 项目 / 文档            | 链接地址                                                                                                           | 说明                                                                                                                                                                                   |
| :--------------------- | :----------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本项目 (Codez)**     | [https://github.com/KingingWang/Codez](https://github.com/KingingWang/Codez)                                       | 当前仓库：集成 Codex 原生桥接、桌面端、Web 与 CLI 的完整工作台                                                                                                                         |
| **本项目 Releases**    | [https://github.com/KingingWang/Codez/releases/latest](https://github.com/KingingWang/Codez/releases/latest)       | 全平台桌面端最新安装包（macOS / Windows / Linux，`x64` & `arm64`）                                                                                                                     |
| **引用的 Codex 项目**  | [https://github.com/KingingWang/codex](https://github.com/KingingWang/codex)                                       | 本项目桌面端与远端默认内置的原生 Codex CLI / `app-server` 运行时仓库（基于 [`openai/codex`](https://github.com/openai/codex) 定制，支持隐私安全与 Completions / Anthropic 等协议扩展） |
| **上游项目 (ZCode)**   | [https://github.com/zai-org/ZCode](https://github.com/zai-org/ZCode)                                               | 上游开源仓库（Z.AI 编程工作台）                                                                                                                                                        |
| **上游中文 README**    | [https://github.com/zai-org/ZCode/blob/main/README.md](https://github.com/zai-org/ZCode/blob/main/README.md)       | 上游原始中文文档（可直接点击查看上游原生用法与设计说明）                                                                                                                               |
| **上游英文 README**    | [https://github.com/zai-org/ZCode/blob/main/README.en.md](https://github.com/zai-org/ZCode/blob/main/README.en.md) | 上游原始英文文档                                                                                                                                                                       |
| **Codex 桌面适配说明** | [docs/codex-desktop.md](docs/codex-desktop.md)                                                                     | 本仓库关于 Codex 桥接架构、会话行为、远端部署与限制的详细技术说明                                                                                                                      |

## 🔄 本项目与上游 (`zai-org/ZCode`) 的核心区别

本项目在保持与上游 `zai-org/ZCode`（当前同步至 `v3.15.1`）UI 工作台、Git 树/Worktree、终端及插件生态同步的基础上，对底层执行引擎、远端链路、系统工具和分发机制进行了大幅重构：

| 维度                          | 本项目 (`KingingWang/Codez`)                                                                                                                                                                                                                                                                   | 上游项目 (`zai-org/ZCode`)                                                      |
| :---------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| **默认桌面执行引擎**          | 默认使用 [`KingingWang/codex`](https://github.com/KingingWang/codex) 原生二进制（`codex app-server --listen stdio://`），通过 [`packages/codex-bridge`](packages/codex-bridge) 转换为桌面 V4 协议；无需克隆相邻 Codex 源码即可开箱运行（设置 `CODEZ_DESKTOP_RUNTIME=legacy` 才回退旧运行时）。 | 默认使用仓库内置的 Node / JS Agent 运行时（`apps/zcode-cli` / GLM bundle）。    |
| **账号、模型与配置体系**      | 由「**设置 → Codex**」统一管理。直接读写原生 Codex 配置（`~/.codex/config.toml`、`models.json`），复用本机 `CODEX_HOME` 登录态与凭据，支持 OpenAI / Responses / Completions / Anthropic `wire_api`、自定义 Provider、MCP Servers、Agent Roles（子代理角色）、Skills 与 Memory 热重载。         | 使用 Z.AI 账号体系、Coding Plan 网关与内置 Provider 配置表。                    |
| **会话控制与队列语义**        | 原生支持运行中消息的 **Queue（排队自动接续）** 与 **Guide（`turn/steer` 下一步引导注入）** 双模式切换、Preempt（中断并立即发送）、安全文件回退（Safe File Rewind）、划词侧边对话（Selection Side Chat）、原生 `ApplyPatch` 差异卡片展示，以及多进程写冲突时的**只读会话降级 + 一键 Fork**。    | 采用旧版 Agent 内部队列与历史回滚机制。                                         |
| **远端工作区 (SSH / WSL)**    | 安装包与 Release 随附 SHA256 严格校验的 4 平台远端组件包（`darwin/linux` `x64/arm64`），连接远端或 WSL 时自动校验并部署原生 Codex + Bridge 到远端 `~/.codez-codex/server`，自动发现远端已有的 Codex CLI 历史会话，且**绝不将本地凭据拷贝到远端主机**。                                         | 从上游 CDN 或 mock-cdn 拉取/上传旧版 GLM Agent 运行时，并将本地凭据同步至远端。 |
| **Computer Use 与浏览器控制** | 迁移并内置开源 [`packages/codez-cua`](packages/codez-cua) 真实运行时与原生 Helper（基于 `@crowecawcaw/xa11y` 提供 Windows UIA、macOS AX、Linux AT-SPI 真实无障碍树、窗口级截图绑定与语义动作），并通过本地 MCP 桥接供原生 Codex 会话直接调用桌面浏览器与桌面应用控制。                         | 开源仓库中随附的 Computer Use 包为不可用占位实现（调用返回不可用错误）。        |
| **手机端端到端加密远控**      | 支持 Codex 引擎下的手机 Web 远控（`web-remote-replayable` 快照恢复链路），新增 E2EE 端到端加密传输、应用层 Gzip 压缩、断线退避自愈，并通过 GitHub Pages 自动部署加密远控前端。                                                                                                                 | 基础 relay 转发与旧版运行时绑定。                                               |
| **产品身份与本地数据隔离**    | 独立应用身份、协议（`codez-codex://`）与数据根目录（`~/.codez-codex`），与上游或旧版安装完全隔离、互不覆盖；内置反馈入口直接跳转至本项目 GitHub Issues。                                                                                                                                       | 使用 `zcode://` 协议、`~/.zcode` 数据目录及官方反馈工单服务。                   |
| **CI 发行与自动更新**         | GitHub Actions 自动拉取 [`KingingWang/codex`](https://github.com/KingingWang/codex) 最新完整 Release，构建 6 平台原生安装包并校验 SHA256，支持基于 GitHub Releases 分架构频道（`x64-latest` / `arm64-latest`）自动更新，完全脱离上游更新源。                                                   | 依赖内部签名流水线与私有 OSS/CDN 更新源。                                       |

## 🧭 选择开发入口

本仓库包含客户端（Desktop / Web）、后端服务、共享 UI、Codex 协议桥接器（`packages/codex-bridge`）、开源 Computer Use 运行时（`packages/codez-cua`），以及传统 Agent CLI 与运行时源码（`apps/codez-cli`）：

| 入口                            | 适用场景                                                                       | 常用启动命令                                    |
| :------------------------------ | :----------------------------------------------------------------------------- | :---------------------------------------------- |
| **Desktop（默认 Codex 引擎）**  | 开发或运行桌面端 Electron 应用（自动准备固定版本原生 Codex 与 `codex-bridge`） | `pnpm bootstrap && pnpm dev:desktop`            |
| **Desktop（旧版 Legacy 引擎）** | 显式调试旧版内置 Agent CLI 桌面运行时                                          | `CODEZ_DESKTOP_RUNTIME=legacy pnpm dev:desktop` |
| **Web / 命令行统一版**          | 在浏览器或终端 TUI 中使用工作台（无需 Electron）                               | `pnpm dev:web` 或 `codez --web`                 |
| **Agent CLI 源码开发**          | 直接在终端开发调试 `apps/codez-cli` 中的 TUI 与 CLI                            | `pnpm --filter @codez/cli dev`                  |

## 更新

- **2026-10-19**：更新至 Codez v3.16.2 版本。
- **2026-10-16**：更新至 Codez v3.16.1 版本。
- 2026-10-16：完整接入开源 Computer Use（`packages/codez-cua`）与原生 Codex 浏览器/桌面控制 MCP 桥接。
- 2026-10-10：更新至 Codez v3.15.1 版本。
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
| `pnpm build:codex-bridge`      | 单独构建桌面端与远端使用的 `@codez/codex-bridge` 协议适配层        |
| `pnpm prepare:codex-runtime`   | 下载并按 SHA256 校验本机目标平台的原生 Codex 运行时资源            |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤          |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。在默认的 Codex 模式下，启动脚本会自动构建 `packages/codex-bridge`、校验并准备固定版本的原生 Codex 二进制，再启动 Electron 和源码监听。若需指定本地自定义的 Codex 可执行文件，可设置环境变量 `CODEZ_CODEX_COMMAND=/abs/path/to/codex`。

需要独立开发数据目录时，可设置 `CODEZ_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
CODEZ_DATA_BASE_DIR="$HOME/.codez-dev-home" pnpm dev:desktop:test
```

### 远程功能（SSH/WSL）

- **默认 Codex 桌面模式**：源码开发时先执行 `pnpm prepare:remote-assets`（或 `pnpm bootstrap:with-remote`）准备校验后的远端 Codex 组件包，再运行 `pnpm dev:desktop`。部署器会将组件校验解压并安装至远端 `~/.codez-codex/server`，不回退旧版 GLM 运行时或上游 CDN，详见 [Codex 桌面说明 - Remote workspaces](docs/codex-desktop.md#remote-workspaces)。
- **旧版 Legacy 模式**：先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再启动桌面端；连接远程项目时资源选择「本地下载后上传」，开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程。

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

### UI Plugin 开发

参见 [UI Plugin：能力、API 与调试](UI_PLUGIN.md)，从 Excalidraw 的画布协作示例开始，了解插件安装更新、页面 API 和宿主联调入口。

**向 `codez-plugins` 提交插件 PR 时，必须在 PR 模板中声明是否为 UI Plugin，并填写插件名称。** 判断标准见[提交 PR 时声明插件类型](UI_PLUGIN.md#提交-pr-时声明插件类型)。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEZ_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.codez/`                                                                                                          |
| `CODEZ_SERVER_WORKSPACE`             | Web 后端的工作区路径                                                                                                                              |
| `CODEZ_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置                                                                                                  |
| `CODEZ_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                                                                                                                    |
| `CODEZ_DESKTOP_RUNTIME`              | 桌面运行时选择：默认 `codex`，设为 `legacy` 可显式切换回旧版 Agent 运行时                                                                         |
| `CODEZ_CODEX_COMMAND`                | 覆盖桌面端默认启动的原生 `codex` 可执行文件绝对路径                                                                                               |
| `CODEZ_CODEX_MANIFEST`               | 覆盖构建/准备阶段使用的原生 Codex 版本与 SHA256 清单路径（默认读取 [`scripts/codex-runtime-manifest.json`](scripts/codex-runtime-manifest.json)） |

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

| 目录                                                 | 职责                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包                       |
| `packages/codex-bridge`                              | 原生 Codex `app-server` 与 Codez 桌面/远端 V4 协议的双向桥接器 |
| `packages/codez-cua`                                 | 开源 Computer Use 运行时、权限 Broker 与跨平台无障碍 Helper    |
| `packages/web`                                       | Web 客户端与手机端加密远控前端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接                                |
| `packages/codez-server-cli`                          | 独立 Server 启动与进程管理                                     |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态                         |
| `packages/services`                                  | 业务服务与持久化                                               |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK                     |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现                                  |
| `apps/codez-cli`                                     | Agent CLI、TUI、运行时与工具                                   |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料                         |

## 提交前验证

修改代码或构建配置后，建议在仓库根目录执行：

```bash
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm architecture:check --changed
pnpm test:codex
```

## 项目声明

许可和第三方版权说明详见 [LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)；
功能范围、维护规则、执行与数据风险详见 [NOTICE.md](NOTICE.md)。
