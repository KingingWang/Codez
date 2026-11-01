# 数据同步在 Codex 原生后端下的诚实标注

Status: implemented 2026-11-01。范围只有 `packages/ui/src/data-sync/**`、其文案与测试；
不改服务侧实现（`packages/services/src/data-sync/**`），不实现 Codex 适配器。
上位功能规格见 [docs/remote/data-sync.md](../docs/remote/data-sync.md)。

## 问题

跨设备数据同步的六个推送分类（子智能体、插件、MCP、技能、命令、钩子）读写的都是 **Codez 自有存储**
（`~/.codez/**`），而本 fork 桌面端默认执行后端是 Codex 原生桥接（`packages/codex-bridge`），
Codex 读的是另一套存储（`$CODEX_HOME/config.toml`、`$CODEX_HOME/agents`、`$CODEX_HOME/hooks.json`、
`$CODEX_HOME/skills` 与 `~/.agents/skills`）。两端在 UI 上没有任何分流，于是出现最坏的一类现象：

1. 用户在「数据同步」执行推送 → UI 报成功（它确实成功写了它认识的那套存储）→ Codex 会话里
   MCP / 子智能体 / 钩子 / 技能启用态没有任何变化。
2. 反向：用户在 Codex 设置面板改了配置，data-sync 的哈希比较看不见，永远不提示「有待同步差异」，
   用户以为设备已经是最新。

## 产品裁决（本 spec 的前提，不再讨论）

**Codex 的原生配置不纳入跨设备同步。** 因此本轮不做 Codex 适配器，只做「诚实标注」止损：
让用户在同步入口就知道哪些分类在 Codex 后端下不会生效、为什么、应该去哪里改。

## 判定信号与唯一来源

- 事实源是各端 Host 的 `systemService.info().agentRuntimeMode`（`packages/shared/src/protocol.ts:74-79`），
  由 Host 装配时按真实 command resolver 决定（`packages/services/src/node.ts:1636-1641`、`:1712`、`:3085`）。
  Renderer 只读结果，不从构建时间、平台或 Agent 代际猜测。
- UI 层公认的解析入口是 `resolveRootProviderStartupMode`
  （[packages/ui/src/root/rootProviderStartupMode.ts:10-24](../packages/ui/src/root/rootProviderStartupMode.ts)）：
  `agentRuntimeMode === "codex"` 才是 codex，字段缺失或查询失败一律回落 legacy，与
  `packages/ui/src/provider-bootstrap-ui/CONTRACT.md` 的 fail-safe 语义一致。data-sync 直接复用它，
  不新造第二个解析器。
- data-sync 是**跨端**功能：source = 本机 base services，target = 设备的 source-settings attachment。
  两端各自读一次自己的 `systemService.info()`（`ISystemService` 已注册进 source-settings 集合，
  `packages/desktop/src/host/sourceSettingsServiceCollection.ts:66`；data-sync 本来就两端都调用
  `systemService.info()` 取 home，见 `packages/ui/src/data-sync/app/marketplacePluginSync.ts:164`、`:296`）。
  不新增 RPC 通道，也不改服务侧合同。
- 不用 V4 hello 的 `capabilities.codex`：它按 workspace 的 Agent 连接投影
  （`packages/ui/src/capabilities/useCodexNativeHost.ts`、`codexCapabilities.ts`），而数据同步弹窗
  刻意不打开 workspace tab、不新建 Agent（`packages/ui/src/data-sync/CONTRACT.md`），target 端根本没有
  可 hello 的会话面；且 attachment hello 的能力集受 base 门禁裁剪（HEAD `ba4a3303`），不是稳定的后端事实。
- **不在 data-sync 缓存后端判定**：解析结果只活在弹窗/分区的一次挂载里，随 services 身份与 online
  换代重新解析，迟到结果按 services 身份丢弃（与弹窗 generation 的既有语义同构）。设备行的
  「上次同步」仍然只来自 `IDeviceSyncStateService`，不掺入后端事实。
- 这是一条跨模块边：`resolveRootProviderStartupMode` 属于 `provider-bootstrap-ui` 模块的公开入口，
  因此 `data-sync` 的 `requires` 同步加入 `provider-bootstrap-ui`
  （`packages/ui/src/data-sync/module.ts` 与 `architecture-policy.yaml` 两处一致）。
  宁可声明依赖，也不在 data-sync 里再写一遍 `agentRuntimeMode === "codex"` 的解释。

## 逐类别核对结论（代码证据）

| 分类               | data-sync 实际读写                                                                                                                                                                                                                                                                                         | Codex 实际读                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 结论                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 子智能体           | 目录 `<storage.dir>/agents`（默认 `~/.codez/agents`，`packages/services/src/subagents/subagentStorage.ts:19-21`、`:31-39`；导入 `packages/services/src/data-sync/subagentDataSync.ts:153`）；启用态 `<storage.dir>/v2/agents-state.json`（`subagentStorage.ts:27-29`，写入 `subagentDataSync.ts:266-280`） | `${CODEX_HOME}/agents` 与 `<项目>/.codex/agents`（`packages/codex-bridge/src/control-agents.ts:34-38`；`specs/codex-desktop-subagents.md:14-22`）                                                                                                                                                                                                                                                                                                             | 不生效                                                                                                                                                                                   |
| MCP                | `~/.codez/cli/config.json` 的 `mcp.servers`（descriptor `packages/services/src/mcp-sync/mcpSyncService.ts:41-47`，路径 `:127-129`，导入 `packages/services/src/data-sync/mcpDataSync.ts:184`）；`.codez` 无 server 时只读回退 `~/.agents/mcp.json`（`mcpSyncService.ts:50-56`）                            | `$CODEX_HOME/config.toml` 与 `<项目>/.codex/config.toml`（`packages/codex-bridge/src/control-mcp.ts:70`、`:114-117`；`specs/codex-desktop-mcp-settings.md:30`、`:73-78`）                                                                                                                                                                                                                                                                                     | 不生效                                                                                                                                                                                   |
| 技能               | 来源 `~/.codez/skills` + `~/.agents/skills`（`packages/services/src/skill-sync/skillSyncService.ts:36-41`、`:45-69`），**统一写入远端 `~/.codez/skills`**（`packages/services/src/data-sync/skillDataSync.ts:418`）；启用态 `~/.codez/cli/config.json` 的 `skills`（`skillDataSync.ts:54-56`、`:504`）     | 独立技能根是 `$CODEX_HOME/skills`、`~/.agents/skills`、系统技能根与插件缓存（相邻 Codex 检出 `codex-rs/exec-server/src/discoverV2/capability_locations.rs:36-37`、`:69-78`），目录由原生 `skills/list` 给出（`packages/codex-bridge/src/control-presentation.ts:162-186`）；启用态在 config 层的 `[skills].config`（`codex-rs/config/src/skills_config.rs:39-55`），经原生 `skills/config/write` 写入（`packages/codex-bridge/src/request-scope.ts:160-170`） | 不生效（写入侧）：Codex 也扫 `~/.agents/skills`，所以**来源列表**里的技能可能确实是本机 Codex 正在用的文件，但同步只会把它写到目标端 `~/.codez/skills`，Codex 不扫这个根，启用态也不互通 |
| 命令               | 来源 `~/.codez/commands` + `~/.agents/commands`（`packages/services/src/data-sync/commandDataSync.ts:37-38`、`:80-90`），统一写入 `~/.codez/commands`（`:143-146`）                                                                                                                                        | 无：Codex 原生没有自定义斜杠命令运行时，也没有 `commands/list`（`specs/codex-desktop-hooks.md:9-10`），设置页 `commands` 一直在 `isCodexUnsupportedSection`（`packages/ui/src/settings/codex/codexSettingsData.ts:407-409`）                                                                                                                                                                                                                                  | 不生效（`.agents/commands` 也不被 Codex 扫描，不存在文件层重叠）                                                                                                                         |
| 钩子               | `~/.codez/cli/config.json` 的 `hooks`（`packages/services/src/data-sync/hookDataSync.ts:39-42`、`:262-269`）                                                                                                                                                                                               | `${CODEX_HOME}/hooks.json`、`<项目>/.codex/hooks.json` 与 `config.toml` 的 `[hooks]`，启停在 `[hooks.state."<key>"]`（`packages/codex-bridge/src/control-hooks.ts:10-13`、`:44`、`:68`；`specs/codex-desktop-hooks.md:6-7`、`:33`）                                                                                                                                                                                                                           | 不生效                                                                                                                                                                                   |
| 插件 · inline      | 目录 `~/.codez/plugins/<name>`（`packages/services/src/plugin-sync/pluginSyncService.ts:123-125`；导入 `packages/services/src/data-sync/inlinePluginDataSync.ts:376`）+ `~/.codez/cli/config.json` 的 `plugins.dirs`（`pluginSyncService.ts:119`，写入 `inlinePluginDataSync.ts:431`）                     | Codex 只认原生插件状态：已安装缓存在 `$CODEX_HOME/plugins/cache`（`codex-rs/core-plugin-common/src/installed.rs:11`，发现 `capability_locations.rs:78`）                                                                                                                                                                                                                                                                                                      | 不生效                                                                                                                                                                                   |
| 插件 · marketplace | 不落文件：走 `IPluginManagementService.addPluginMarketplace / installPlugin / setPluginEnabled / configurePlugin`（`packages/ui/src/data-sync/app/marketplacePluginSync.ts:333-420`）                                                                                                                      | 同一入口在 Codex 运行时被路由到真实 attachment（`packages/services/src/codez-agent/codezAgentService.ts:4499-4510`）→ bridge 控制面 `plugins/install`、`plugins/marketplace/add`（`packages/codex-bridge/src/control-plane.ts:22-33`、`control-plugins.ts:226`）→ Codex 原生插件状态（`specs/codex-zcode-plugin-compatibility.md:5-40`）                                                                                                                      | **生效**：Codex 拥有安装文件与启用态                                                                                                                                                     |
| 模型提供商         | 只读面板，不参与勾选与推送；最近结果来自 Main 协调器的 Provisioning lane（`packages/ui/src/data-sync/CONTRACT.md`）                                                                                                                                                                                        | Provider 事实由 Main 单向下发，不是 data-sync 的推送路径                                                                                                                                                                                                                                                                                                                                                                                                      | 与本轮无关，保持原样                                                                                                                                                                     |

「用户配置」不是独立分类：`userConfigSyncService` 是子智能体 / 命令 / 钩子共用的通道
（`packages/services/src/data-sync/userConfigSyncService.ts`），按上表三行分别判定。

## 产品规则

判定只在两个事实上：`sourceCodex`（本机 Host）与 `targetCodex`（设备 attachment）。

1. **targetCodex = true**（数据落地的机器跑 Codex）：
   - 结论为「不生效」的分类整类**不可同步**：不加载、不出现在勾选与「推送全部」里，导航与概览行
     显示「Codex 不同步」标记，点进去只看到解释（原因 + 应该去哪个 Codex 面板改）。
     这不是灰度或降级开关，而是避免继续产生「成功但不生效」的结果。
   - 「插件」分类是**部分生效**：保留 marketplace 行（经 Agent 落到 Codex 原生插件状态），
     inline 行从两端列表中排除（写入 `~/.codez/plugins` 对 Codex 无效，留着只会被勾选后报成功）。
     分类页显示一条如实说明：marketplace 会生效、inline 不同步。
2. **sourceCodex = true**（本机跑 Codex）：无论 target 是什么，弹窗与设置页分区都显示一条口径提示：
   这里列出的「本机」条目只来自 Codez 自有存储，不包含 Codex 面板里配置的 MCP / 子智能体 / 钩子 /
   技能启用态；要改这些配置请去「设置 → Codex」对应面板。推送不被禁用——数据仍然会正确落到
   legacy 目标端的 Codez 运行时。
3. **两端都不是 Codex**：行为与文案完全不变（不误伤 legacy 桌面、Web 与手机远控）。
4. **判定未知**（查询失败、旧 Host 缺字段、attachment 未就绪）按 legacy 处理：不加标记、不禁用。
   标注是止损手段，宁可少标也不能把可用路径标成不可用。
5. 文案必须说明原因与去处，不能只说「不支持」：点明 Codex 原生后端、它的配置由 Codex 自己管、
   跨设备同步目前只覆盖 Codez 自有存储、以及对应的 Codex 设置面板。中英双语同时提供。

## 状态所有者与事件顺序

```text
Host systemService.info().agentRuntimeMode（source 端 / target 端各一份，唯一事实源）
        └─ resolveRootProviderStartupMode（既有 UI 解析器，失败回落 legacy）
             └─ useDataSyncRuntimeModes（data-sync/app：唯一的后端判定 owner，按 services 身份换代）
                  ├─ domain/resolveDataSyncCategoryAvailability（纯函数：分类 → 可同步 / 部分 / 不可同步）
                  ├─ DataSyncDialog：过滤传给 useDataSyncDialog 的分类适配器 + 渲染标记与解释
                  │    └─ useDataSyncDialog 只加载/推送它拿到的分类（不新增第二份判定，也不新增写路径）
                  └─ DataSyncSection：source 端口径提示（不读设备同步状态之外的新事实）
```

- 后端判定只有 `useDataSyncRuntimeModes` 一个 owner；domain 只做纯映射；UI 只渲染。
- 弹窗的「哪些分类可同步」由传给 `useDataSyncDialog` 的分类适配器列表表达：被屏蔽的分类根本不进入
  加载与推送状态机，因此不存在「UI 禁用但状态机仍能推送」的第二条写路径。
- 换代规则沿用弹窗既有 generation 语义：`targetServices` 或 `online` 变化时重新解析 target 端；
  迟到的解析结果按发起时的 services 身份丢弃。设备离线时 target 端不解析（等价于未知 → 不禁用），
  重新上线后重新解析。
- 不用超时兜底：解析失败即回落 legacy，不等待、不重试轮询。

## 验收场景

1. **DS-CODEX-01** 本机与设备都跑 Codex：打开弹窗 → 顶部出现目标端说明；子智能体 / MCP / 技能 /
   命令 / 钩子在导航与概览上带「Codex 不同步」标记，勾选框禁用，点进去显示原因与「设置 → Codex」指引；
   「推送全部」只可能覆盖插件分类的 marketplace 行。
2. **DS-CODEX-02** 插件分类在 targetCodex 下：列表只有 marketplace 行，没有 inline 行，分类页显示
   「marketplace 会生效、inline 不同步」的说明；推送 marketplace 行仍按既有流程成功/失败。
3. **DS-CODEX-03** 只有本机跑 Codex（设备是 legacy 运行时）：不禁用任何分类，只显示本机口径提示；
   推送照常执行并落到设备的 Codez 存储。
4. **DS-CODEX-04** 两端都是 legacy：没有新增文案与标记，行为与 3.17.1 上游一致。
5. **DS-CODEX-05** `agentRuntimeMode` 缺失或 `systemService.info()` 失败：按 legacy 处理，不禁用、不标记，
   只记一条 warn 日志（`packages/ui/src/logger.ts`）。
6. **DS-CODEX-06** 从旧入口（技能 / MCP / 插件设置页、连接向导、侧栏项目菜单）带 `initialCategory`
   打开被屏蔽的分类：弹窗停在该分类并显示解释，不回退到概览、不静默改选项。
7. **DS-CODEX-07** 设备离线 → 上线：target 端判定重新解析，标记随之出现/消失，不残留上一台连接的结果。

### 自动化覆盖与缺口

- 已覆盖：`packages/ui/test/dataSyncCodexAvailability.test.ts`（登记在
  `scripts/fork-regression-test-files.json`）验证分类判定、未知按 legacy、只有本机是 Codex 时不禁用、
  可同步分类列表、inline 插件在 target 为 Codex 时不列出也不扫描、两端各自读自己的 Host 事实、
  离线不探测设备、attachment 换代重新解析，以及双语文案齐全且解释里带原因与去处。
- 缺口：DS-CODEX-01/02/06/07 的端到端验证需要桌面 E2E（`packages/desktop/test/e2e/conversation-session/`
  下的 DSYNC 系列）。现有 DSYNC 用例都断言「推送到远端 `~/.codez` 生效」，只在 **target 为 legacy
  运行时**时成立；若远端也部署 Codex 运行时（`scripts/codex-runtime-remote-package.mjs` 的
  `CODEZ_DESKTOP_RUNTIME=codex`），这些用例会命中本轮的屏蔽逻辑而失败，需要显式 pin legacy 远端或改写预期。
  E2E 目录不在本次改动范围内，留给 E2E owner 处理。

## Out of Scope

- Codex 原生配置的跨设备同步适配器（`config.toml`、`$CODEX_HOME/agents`、`hooks.json`、技能启用态）。
- 服务侧改动：分类服务仍按 Codez 自有存储实现；`resolveUserHomeDir()` 忽略
  `CODEZ_DATA_BASE_DIR` / `CODEZ_HOME`（Codex 远端包把 Codez 数据根设成 `~/.codez-codex`，见
  `scripts/codex-runtime-remote-package.mjs:130-137`）属于服务侧问题，另行处理。
- 模型提供商面板的 Codex 口径（只读，且由 Main 的 Provisioning lane 驱动）。
- 是否在 Codex 后端下整体隐藏「数据同步」分区：本轮保留入口并解释，是否收敛为单一提示由产品再裁决。
