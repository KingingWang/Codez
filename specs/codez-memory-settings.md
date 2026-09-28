# 记忆设置（Memory Settings）配置化与即时生效

## 背景

设置页「记忆」目前只有一个总开关（`sharedSettings.memoryEnabled`），且只在会话
materialization 时经 `session/requestRuntimePreferences` 读取：修改开关对已经运行的
会话不生效，用户感知为「要重启 server / 下次打开 APP 才生效」。CLI 配置文件
（`~/.codez/cli/config.json`）另有 `features.memory` 与 `memory.use`，同样只在 agent
进程启动时读取。

上游 Codex 的 `[memories]` 配置提供了参照：`use_memories`（注入记忆）、
`generate_memories`（生成记忆）、`extract_model` / `consolidation_model`
（记忆流水线单独模型）。ZCode 的记忆流水线是「工作区记忆文件 + 每轮成功 turn 后
自动提取」，与 Codex 的 rollout 整合流水线不同，因此只映射语义对应的开关：
使用（use）、生成（extraction）、提取模型（extraction model）。

## 产品规则

设置 > 记忆 提供以下配置，全部即时生效（不用重启 server，不用重开 APP）：

1. **工作区记忆**（现有总开关 `memoryEnabled`）：关闭时该设备上所有会话不加载、
   不生成记忆。
2. **在对话中使用记忆**（`memoryUseEnabled`，默认开）：关闭后系统提示不再注入
   记忆索引与记忆区段；自动提取也随之停止（与 CLI `memory.use` 语义一致，
   `resolveEnabledProjectMemoryRoot` 把 use=false 视为整体停用）。
3. **自动提取记忆**（`memoryExtractionEnabled`，默认开）：关闭后成功 turn 结束不再
   调度后台提取。
4. **记忆提取模型**（`memoryExtractionModel`，默认「跟随会话模型」）：显式设置后，
   记忆提取改用该模型；模型不可用时回退会话模型并记录 warn。

## 状态所有者与写入路径

- App 设置（`ISettingService` / `sharedSettings`）是这四个字段的唯一事实源；
  UI 只经 `useSettings().update` 写入。
- CLI 配置文件（`features.memory`、`memory.use`、`memory.extractionEnabled`、
  `memory.extractionModel`）仍是纯 CLI 用户的配置面；桌面 Host 下发的偏好以
  「AND」语义叠加：任一侧关闭即关闭，Host 未显式设置的提取模型回落 CLI 本地值。
- agent 进程内每个 session record 保存 **CLI 本地解析值快照**
  （`record.localMemoryConfig`，创建时、Host override 应用前读取
  `app.runtime.config.memory`），Host 偏好变更时按
  `effective = host && local`（布尔）/ `host ?? local`（模型）重新计算并应用。
- 避免回环：热更新只改写 runtime config 与 context 快照，不写回 App 设置，
  不触发 broadcast 二次同步。

## 接口

### App 设置 schema（packages/shared/validationAppSettings.ts）

```ts
memoryEnabled: boolean (现有, 默认 false)
memoryUseEnabled: boolean (默认 true)
memoryExtractionEnabled: boolean (默认 true)
memoryExtractionModel: ModelSelection | null | undefined (缺省 = 跟随会话模型)
```

### 协议（packages/shared/codez-protocol）

- `session/requestRuntimePreferences` 结果增加可选字段
  `memoryUseEnabled` / `memoryExtractionEnabled` / `memoryExtractionModel`；
  旧 Host 缺字段时按「不覆盖 CLI 本地配置」处理（undefined）。
- 新增 `workspace/updateMemoryPreferences`（Host → agent push）：
  params `{ workspace, preferences: { memoryEnabled, useEnabled, extractionEnabled, extractionModel? } }`，
  result `{ workspace, updatedSessionCount }`。
  新 Host 调用旧 CLI 时按 method-not-found 降级忽略（与
  `workspace/updateModelIoPreferences` 同一兼容模式）。

### 服务层

- `CodezAgentAppRuntimePreferences` 增加可选 memory 字段；
  `codezAgentService.syncAppRuntimePreferences` 把 memory 偏好随既有
  interaction-preferences 同步队列一起推送（每 workspace 串行、快照去重）。
- `resolveSessionRuntimePreferences`（node.ts）返回完整 memory 偏好。

### CLI runtime

- `MemoryRuntimeConfig` 增加 `extractionModel?: ModelSelection`；
  提取时优先用其解析模型，失败回退 turn 模型并 warn。
- 新增 `runtime.applyMemoryRuntimeConfig(patch)`：合并 `config.memory`，
  重新解析 `memoryRoot` / `memoryIndexContent`，无活动 turn 时重建 context prefix；
  活动 turn 中只改 config，下一 turn 的 schedule/context 读取自然生效。

## 事件顺序（即时生效）

```text
UI Switch/Select
  → settingService.update (持久化, 唯一事实源)
  → refresh 本地设置快照
  → codezAgentService.syncAppRuntimePreferences (含 memory 偏好)
      → 每个活动 workspace client 串行发送 workspace/updateMemoryPreferences
          → CLI: 更新 appRuntimePreferences.memory
          → CLI: 对每个 session record 计算 effective 并 applyMemoryRuntimeConfig
  → broadcastService.send (其他窗口同步设置快照)
```

幂等与乱序：同一 workspace 的推送复用既有 `interactionPreferenceSyncByWorkspaceKey`
串行队列（最新快照覆盖语义）；stale 结果不存在的判定沿用队列尾部快照，
无独立过期规则。远程 workspace 链路经 `botRemoteWorkspaceBridge` 同一入口转发，
`sessionRuntimePreferencesAuthority: "external"` 的远端 Host 由其自行同步。

## 失败语义

- 推送失败（agent 未运行 / 旧 CLI）：method-not-found 静默降级；其他错误上抛，
  UI toast 报错，设置已持久化不受影响（下次会话 materialization 仍会拉取）。
- 提取模型解析失败：回退会话模型 + warn 日志（`project_memory_extract`），
  不阻断 turn。
- 热更新期间 session 正在 turn 中：只更新 config；context 重建推迟到 turn 结束，
  与 `updateConfig` 的 language/outputStyle 语义一致。

## 验收场景

1. 设置 > 记忆 打开总开关后，**已打开的会话**下一轮对话即注入记忆索引；
   关闭后立即不再注入、不再提取（日志 `memoryRoot` 缺席可证）。
2. 关闭「自动提取记忆」后，成功 turn 结束无 `project_memory_extract` 后台任务。
3. 设置提取模型后，提取请求的 model 为所选模型（model-io 日志可证）；
   切回「跟随会话模型」后恢复。
4. 重启 APP 后四项配置保持。
5. 旧 CLI（无该方法）+ 新桌面：设置修改不报错、不阻塞。
6. 纯 CLI（config.json 写 `memory.use=false`）：桌面开关开也不注入记忆
   （AND 语义）。


## Codex 适配器路径（桌面默认运行时）

上文描述的是 legacy codez-cli 运行时（`CODEZ_DESKTOP_RUNTIME=legacy`）的实现。
桌面默认走 Codex 适配器（codex-bridge → 原生 codex app-server），该运行时的
记忆配置事实源是 **原生 `config.toml`**（`[features] memories` 与 `[memories]` 表），
不是 App 设置。用户心智模型即「配置文件里面有记忆的配置」，因此本路径不做
Host 侧第二存储，GUI 直接读写原生配置。

### 产品规则

设置 > 记忆 在桌面直接呈现原生 Codex 记忆面板（`CodexMemoryPanel`，承载于
`CodexSettingsSection`，与 models/skills/agents/mcp/plugins 同一模式），
`memory` 从 `isCodexUnsupportedSection` 移除并加入 `isCodexSettingsSection`。

可配置项（键名 = 原生 config.toml 键路径）：

| 设置 | 键路径 | 类型 | 原生默认 |
| ---- | ------ | ---- | -------- |
| 记忆总开关 | `features.memories` | bool | false |
| 在对话中使用记忆 | `memories.use_memories` | bool | true |
| 自动生成记忆 | `memories.generate_memories` | bool | true |
| 专用记忆工具 | `memories.dedicated_tools` | bool | false |
| 外部上下文时禁用 | `memories.disable_on_external_context` | bool | false |
| 提取模型 | `memories.extract_model` | string? | 供应商偏好模型 |
| 整合模型 | `memories.consolidation_model` | string? | 供应商偏好模型 |
| 单次启动最大处理会话数 | `memories.max_rollouts_per_startup` | int 1-128 | 2 |
| 会话最大年龄（天） | `memories.max_rollout_age_days` | int 0-90 | 10 |
| 会话最小空闲（小时） | `memories.min_rollout_idle_hours` | int 1-48 | 6 |
| 整合最大原始记忆数 | `memories.max_raw_memories_for_consolidation` | int 1-4096 | 256 |
| 记忆最长未使用（天） | `memories.max_unused_days` | int 0-365 | 30 |
| 启动所需最低额度（%） | `memories.min_rate_limit_remaining_percent` | int 0-100 | 25 |

「默认/未配置」语义：读取时键缺席即显示原生默认值；用户选择「默认」或清空
数值输入时以 `value: null, mergeStrategy: "replace"` 删除该键，恢复原生默认。
`version` 与 `dual_write` 是流水线迁移期内部旋钮，不在 GUI 暴露。

### 状态所有者与写入路径

- 原生 `config.toml` 是唯一事实源；UI 打开面板时经 `config/read`
  （`includeLayers: true`）读取有效值与 user 层 `{filePath, expectedVersion}`。
- 每次修改经 `codexRequest` → bridge → 原生 `config/batchWrite`
  （`{filePath, expectedVersion, edits, reloadUserConfig: true}`）立即落盘；
  `reloadUserConfig` 触发原生 `reload_user_config`，把新用户层配置热刷新进
  该进程所有已加载线程（与原生 TUI 写记忆设置同一机制），无需重启 server
  或 APP。OkOverridden 表示被管控策略覆盖，面板按既有文案提示。
- 其他 workspace 的 agent 进程持有各自 config 缓存：配置项的实际消费点
  （记忆注入、提取流水线）发生在线程创建 / turn 边界 / 下次流水线运行，
  因此其他进程最迟在下一个线程即生效，不需要广播推送。
- Web/移动端的「记忆」分区保持 legacy `MemorySettingsSection` 不变
  （仅桌面走 Codex 原生面板）。

### 事件顺序（即时生效）

```text
UI Switch/Select/NumberInput
  → controller.run
  → codezAgentService.codexRequest (必要时拉起只读 client)
  → bridge codexRequest (scopedNativeRequest 校验 cwd)
  → 原生 config/batchWrite (reloadUserConfig: true)
      → 写入 user config.toml
      → reload_user_config: 每个已加载线程 refresh_runtime_config
  → controller.refresh (config/read 重读有效值)
```

### 失败语义

- bridge/原生 RPC 失败：面板显示错误，不落任何本地状态；用户重试。
- 旧版原生不支持 `reloadUserConfig` 字段时字段被忽略，配置仍落盘，
  最迟下一个新线程生效（可接受降级）。
- 数值越界：UI 本地校验拒绝提交，不发请求。

### 验收场景（Codex 适配器）

1. 桌面设置 > 记忆 不再显示「Codex 适配器尚不支持」，呈现原生记忆面板，
   开关/模型/数值与 `config.toml` 当前内容一致。
2. 打开总开关后 `~/.codex/config.toml` 出现 `[features] memories = true`，
   已打开会话所在进程收到热刷新（无需重启 server/APP）。
3. 设置提取模型为某可用模型后 `memories.extract_model` 落盘；切回「默认」
   后该键从 config.toml 移除。
4. 数值项越界输入被 UI 拒绝；合法值落盘且在范围内。
