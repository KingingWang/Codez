# Codex Host 模型选择与 Bot/Automation 解析

Status: 实现于 2026-09-24。修复 codex 桌面 runtime 下 Bot（飞书/Telegram/微信）
首发与跟进消息报「Bot 无法从目标 Host 解析 Submission 模型」，以及 Automation
派发报「Automation 无法从目标 Host 解析首选模型」。

## 问题与根因

桌面 codex runtime（`usesDefaultCodexDesktopBridge`）由 Codex 持有账号、配置与
模型目录（`config/read` + `model/list`）；legacy Provider Registry（Z.ai GLM 内建）
在 codex 模式下不启动、无可选模型。UI Composer 已改走 `CodexModelCatalog`，但
Bot/Automation 仍从 Host 的 `IModelSelectionService`（legacy Registry 视图）解析
Submission 模型，得到空 `preferredSelection`，首发即抛错。

## 所有权与边界

```text
Bot 消息 / Automation 派发 / UI 订阅
        → Host IModelSelectionService（唯一解析入口）
        → codex 模式：Codex 原生目录（config/read + model/list，按 workspace 解析）
        → legacy 模式：Provider Registry（既有行为不变）
```

- 新增 `packages/services/src/model-provider/codexModelSelectionService.ts`：
  codex 模式唯一模型选择视图的所有者。只读 Codex 事实，不缓存配置写入口。
- `packages/services/src/node.ts` 在 codex bridge 模式下把注册进 DI 与 Bot 依赖的
  `IModelSelectionService` 换成本服务；legacy 模式仍用 `providerRuntime.modelSelection`。
- Codex 模型的执行事实源不变：bridge 以 `providerId/modelId/reasoningLevel` 直传
  `turn/start`。本服务产出的 View 只用于选择/展示/校验，`providers[].config` 中的
  能力占位字段没有执行消费者；唯一真实数据是 `reasoningLevel.values`（来自
  `supportedReasoningEfforts`）。

## 合同

- `ModelSelectionViewInput` 增加可选 `workspace { workspacePath, workspaceIdentity? }`。
  Codex 视图按 workspace 解析（config/read 需要 cwd）；legacy 实现忽略该字段。
  无 workspace 的读取返回空视图（与 codex 模式 legacy 空 Registry 行为一致）。
- `preferredSelection`：显式 `model`+`model_reasoning_effort` 配置的优先；其次
  目录 `isDefault` 模型 + 默认档位；显式配置但不在目录中的模型保留为
  `configuredSelection`（不伪造目录能力）。
- `effectiveSelection`（传入 `selection` 时）：providerId 必须等于当前 codex
  provider；`configuredSelection` 模型按配置事实直传（能力不可校验）；目录模型
  缺档位时补 `defaultReasoningEffort`；档位不受支持时返回
  `reasoning-level-not-supported`。
- `revision` 按 workspace 单调递增，仅当目录指纹变化时推进；`onDidChange` 在读取
  到变化时通知。无轮询。
- `ModelSelectionView` 增加可选 `workspace { workspacePath, workspaceIdentity? }`：
  Codex 视图/变更事件必须携带来源 workspace 身份；legacy Registry 视图是 Host
  全局的，不携带。身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`。
  消费者必须在比较 revision 或采用视图之前调用
  `isModelSelectionViewForWorkspace(view, workspaceKey)` 过滤：跨 workspace
  事件直接忽略；无 workspace 上下文（Host 全局）的消费者不接受携带 workspace 的
  事件；无 workspace 的事件（legacy）总是接受。
- 目录读取按 workspace 做在途合并（single-flight）：并发刷新共享同一 RPC，
  完成后一次性写缓存，乱序完成不会让旧配置覆盖新配置再推进 revision。

## 失败语义

- Codex RPC 失败：`getView` 抛错；Bot 捕获后按既有「无法解析」路径回复，
  不落错误状态。
- 原生 RPC 字段省略语义：`includeLayers: false` 时 `config/read` 省略整个
  `layers` 字段（而非返回 null），`model/list` 在无下一页时可能省略
  `nextCursor`。共享 schema 对这些字段一律 `nullable().optional()`，
  不能因字段省略拒绝整个配置/模型目录（2026-09-24 Windows 实测回归：
  严格 schema 拒绝响应导致 Bot 无法解析 Submission 模型）。
- 目录为空且无配置事实：空视图（providers=[]），preferredSelection 缺省；
  Bot 首发返回既有错误文案，与 legacy 空 Registry 一致。
- Bot 远端 workspace：经 `BotRemoteWorkspaceService` 代理到远端 Host 的同一服务；
  远端 Host 的 codex runtime 以自己的 workspace 解析，身份以
  `workspaceIdentity` 贯穿。

## 迁移边界

- legacy runtime 与 standalone server 完全不经过本服务，行为不变。
- UI desktop composer 已走 `CodexModelCatalog`，不受影响；移动 Web composer 在
  传入 workspace 后由同一 View 提供候选（此前为空视图，无法提交）。
- 定时任务/手动 Automation 派发经 `resolveAutomationSubmissionModelSelection`
  传入 workspace 解析，行为与 Bot 对齐。
