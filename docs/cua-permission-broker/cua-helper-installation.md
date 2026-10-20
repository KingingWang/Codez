# Codez Computer Use 外置安装闭环

## 背景

Codez Computer Use Helper 必须作为独立 `.app` 运行，才能成为 macOS TCC 的独立责任进程。发布包把已签名 Helper 携带在 `Codez.app/Contents/Resources/cua-helper/` 中；运行时先校验并复制到稳定的用户级路径，再通过 LaunchServices 拉起。它不是 Electron 子进程，也不使用 `Contents/Library/Helpers`。

产品安装位置固定为：

```text
${CODEZ_HOME:-$HOME/.codez}/computer-use/Codez Computer Use.app
```

内部 `Codez Preview` 与生产版共享 `CODEZ_HOME` 里的任务、配置和凭据，但使用独立的 Helper
版本目录，避免两个不同 App 版本依次使用 CUA 时互相覆盖或触发降级保护：

```text
${CODEZ_HOME:-$HOME/.codez}/computer-use/preview/Codez Computer Use.app
```

该路径由桌面 Host 注入 `CODEZ_CUA_HELPER_INSTALL_VARIANT=preview`，只改变 CUA 运行组件位置，
不会改变业务数据根。两个 Helper bundle 的签名身份都保持 `dev.codez.cua-helper`，因此 macOS
Accessibility / Screen Recording 的授权主体仍显示为同一个 `Codez Computer Use`。

## 安装来源

正式产品只有一个安装来源：当前 Codez.app 内的
`Contents/Resources/cua-helper/Codez Computer Use.app`。缺失、无效或无法读取时直接
fail-closed；产品代码不会尝试网络下载，也没有下载兜底。因此构建与签名门禁必须保证这个
arm64 Helper 与主 App 一起交付。

以下覆盖只属于显式本地开发模式，不得作为产品分发配置：

- `CODEZ_CUA_HELPER_DOWNLOAD_URL`：完整 zip URL。
- `CODEZ_CUA_HELPER_DOWNLOAD_BASE_URL`：版本目录 base URL。
- `CODEZ_CUA_HELPER_VERSION`：本地下载包的期望 Helper 版本。
- `CODEZ_CUA_HELPER_TEAM_ID`：期望签名 TeamIdentifier。**未配置时默认锚定 Codez 官方 team `8A5X4JJ39T`（等价证书 pinning），不是"任意非 ad-hoc team"**；本变量仅用于开发或更换 team 时显式覆盖。
- `CODEZ_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`：仅供本机开发调试。此模式不下载，也不通过
  release 签名/Gatekeeper 验收；当来源是当前 checkout 显式提供的 bundled Helper 时，即使版本号
  相同，也必须比较产物内容并在发生变化时原子刷新安装，禁止静默复用旧 Helper。
- `CODEZ_CUA_PRODUCT_HELPER=0|false|off`（macOS/Windows）：显式关闭默认启用的产品 Helper resolver，
  关闭后不创建 host、不启动 Helper、不弹 TCC。未设置或显式 `1|true|on` 时，desktop-local
  按需启动外置 Helper，并把随机 socket/token 只注入给可信 shared `node_repl` host。

## 校验

安装器在替换现有 Helper 前必须先在 staging 目录校验。产品内嵌来源用构建 ID、签名、bundle id、
架构和 Gatekeeper 绑定，不依赖曾经被错误解析为 `0.0.0` 的运行时版本常量；本地下载来源仍检查版本：

- `Info.plist` 的 `CFBundleIdentifier` 必须是 `dev.codez.cua-helper`。
- 本地下载来源的 `CFBundleShortVersionString` 或 `CFBundleVersion` 必须等于期望版本。
- `Contents/MacOS/<CFBundleExecutable>` 必须包含当前目标 arch。
- `codesign --verify --deep --strict` 必须通过。
- `codesign -dv --verbose=4` 必须能读到非 ad-hoc `TeamIdentifier`，且必须等于期望 team（默认 `8A5X4JJ39T`，可用 `CODEZ_CUA_HELPER_TEAM_ID` 覆盖）。release 校验下 `expectedTeamIdentifier` 为空会被直接拒绝（fail-closed），不接受未锚定 team 的包。
- `spctl -a -vv -t exec` 必须通过，用于验证 Gatekeeper/notarization 结果。

校验失败时不能启动 Helper，也不能把 socket/token 注入给 shared `node_repl` host。

## 本地 dev 模式

> Helper 与模型侧 SDK/node_repl bridge 是两类独立资产。Helper 显示 ready 但工具仍不可用时，还需要检查
> [`cua-dev-mcp-runtime-assets.md`](./cua-dev-mcp-runtime-assets.md) 中的 Dev 构建、插件缓存与
> session MCP 注册链路。

`CODEZ_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1` 用于解决开发机没有 Developer ID 签名身份时的
迭代测试问题。产品 Helper resolver 默认启用，不需要额外开启变量；只有
`CODEZ_CUA_PRODUCT_HELPER=0|false|off` 才关闭。该模式保留 bundle id、版本、架构和 Mach-O 结构校验，
但允许 ad-hoc/unsigned 签名并跳过 Gatekeeper/notarization；通过后仍按产品路径用
LaunchServices 启动外置 Helper，并把随机 socket/token 注入给可信 shared `node_repl` host。

非打包 macOS desktop 在显式开启上述 unsigned-local 模式后，优先使用非空的
`CODEZ_CUA_BUNDLED_HELPER_APP_PATH` 作为本地 bundled source；未设置、空串或仅空白时回退到
`${CODEZ_HOME:-$HOME/.codez}/computer-use/dev/Codez Computer Use Dev.app`。路径缺失或校验失败时
fail-closed，绝不回退下载。正式打包 desktop 会忽略该开发态覆盖并始终使用
`Codez.app/Contents/Resources/cua-helper/Codez Computer Use.app`，因此 shell 不能改写生产来源。

标准 `pnpm dev:desktop` 启动脚本必须同时注入当前 checkout 的 bundled Helper 路径和
`CODEZ_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`。两者缺一不可：只有路径时 Host 不会进入本地开发
信任与同版本内容刷新分支，容易继续启动 `~/.codez` 中版本号相同但 native ABI 已过期的 Helper。

```text
dev 启动
  -> 注入 checkout Helper 路径 + unsigned-local 标记
  -> 校验并比较已安装 Helper 与 checkout 产物
  -> 内容不同则原子刷新
  -> LaunchServices 启动 Helper，等待 broker ready
```

该模式不自动下载 Helper，避免把缺失的本地产物静默替换成远端 signed 产物，也避免把 signed
产物误覆盖成开发产物。它只能证明本地 App/Helper/socket/token 流程可运行，不能证明稳定
TCC 身份或 release 可交付性。

联合验证尚未发布的 codez-cua 源码时，先在 producer 仓库执行 `pnpm build`，再给两条构建链
传入同一个绝对目录：

```bash
CODEZ_CUA_HELPER_RUNTIME_PACKAGE_DIR=/absolute/path/to/codez-cua \
  pnpm build:cua-helper -- --version <version>
CODEZ_CUA_RUNTIME_PACKAGE_DIR=/absolute/path/to/codez-cua \
  pnpm --filter @codez/cli build
```

两个变量只覆盖本次构建输入，不修改 lockfile。未设置时继续使用仓库固定依赖；不能只覆盖
Helper 而让插件内联旧 frontend，否则跨版本行为会被误判成 Helper 回归。

## 安装与原子替换

产品将 App 内的 Helper 复制到同一安装根目录下的 staging；显式本地开发下载则先下载、解压到
staging。两者校验通过后使用同一套 promotion：

1. 已有 Helper 重命名为同目录 backup。
2. staging Helper 重命名到最终路径。
3. promotion 失败时回滚 backup。
4. 成功后删除 backup 和临时目录，并写入 `.codez-cua-helper-meta.json`。

该流程避免跨卷 `rename`，并确保不会把未校验的 Helper 放到产品路径。

## quarantine 不变量

安装器必须保证**落盘的 Helper 不含 `com.apple.quarantine`**。背景：随包 Helper 只有
ad-hoc 签名（见上文校验一节的 release 现状），带隔离属性时 macOS Gatekeeper 会在
LaunchServices/exec 拉起时拒杀（SIGKILL 或"已不能再打开"），Helper 永远走不到
credential bootstrap；权限流把这种启动失败误读成"未授权"后会反复发起 TCC 请求，
形成录屏弹窗死循环。复制（`copyBundle`）会保留 xattr，因此隔离属性必须显式剥离：

- staging 复制完成后、`verifyBundle(staging)` 之前，对 staging 递归剥离
  `com.apple.quarantine`（`/usr/bin/xattr -dr`），随后探针确认已净。
- 同版本快路径（已安装且版本一致直接复用）也要探针检查已安装副本；带隔离属性时
  原地递归剥离，作为存量坏安装的自愈路径，用户无需手动 `xattr`。
- 剥离后探针仍发现隔离属性 → fail-closed，报 `helper_quarantine_present`，
  不启动 Helper、不注入 socket/token。
- 只剥离 `com.apple.quarantine` 这一个属性；不放宽 bundle id、架构、安装目录
  或签名链的任何校验，也不新增配置开关。

## Hardened runtime entitlements（最小集）

Helper 是独立的 TCC 授权主体（Accessibility / Screen Recording / 输入），不是普通 Electron
renderer，entitlement 必须是最小集。已批准的集合**恰好**为（`packages/desktop/build/entitlements.helper.plist`，
由 `packages/desktop/test/runtime-asset-scripts.test.ts` 的 release gate 断言，任何新增都会失败）：

- `com.apple.security.cs.allow-jit` —— Node SEA 内嵌 V8 在 hardened runtime（W^X）下 JIT 需要 `MAP_JIT`。
- `com.apple.security.cs.allow-unsigned-executable-memory` —— V8 JIT 在部分 macOS/Node 组合下仍需要可写可执行内存；
  仅在 `allow-jit` 不足以让 SEA 正常 JIT 时保留。**风险接受边界**：该 entitlement 会削弱 W^X 保护，因此配合
  “启动 env 净化（`sanitizeHelperLaunchEnv` 剔除 `DYLD_*`/`LD_*`/`NODE_OPTIONS`，两条 LaunchServices 路径共用）”
  - “移除 `allow-dyld-environment-variables`” 一起，确保没有外部注入通道能利用它。**验证/收敛命令**（在签名后的 release
    Helper 上）：`codesign -d --entitlements :- "Codez Computer Use.app"`；若在干净环境下移除本 entitlement 后 SEA 仍能
    正常 JIT（启动 + 执行一次 broker 请求不崩），应进一步移除（follow-up：release runner 上验证）。

**已移除**：`com.apple.security.cs.disable-library-validation`（R14）—— Helper 只加载随包同一 Team
（默认 `8A5X4JJ39T`）签名的 `ax_macos.node`，library validation 无需放开；`com.apple.security.cs.allow-dyld-environment-variables`
（R10）—— 防止 `DYLD_*` 注入这个高权限主体。主 App（`entitlements.mac.plist`）的更宽配置**不得**直接沿用到 Helper。
