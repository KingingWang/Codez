# 上游 main 集成合同（3.17.1）

## Feature Summary

| 项 | 约束 |
| --- | --- |
| 目的 | 将 Codez 定制提交迁移到 ZCode 上游 main，保留已有产品行为 |
| 上游 | `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`，3.17.1 |
| 原项目 | `3eafe4fe962b5824ecf2e69392f69900ba19d51d` |
| 原基准 | `3c5b2276` → `c0695b7f`（原重命名提交） |
| 新基准 | `56457972`，纯产品品牌及路径转换 |
| 本地备份 | `backup/pre-rebase-20261031-3eafe4fe` |
| 改动层 | presentation / validation / persistence / recovery 的兼容迁移，不新增产品语义 |
| 模式 | impact-only；既有 spec 和回归证据继续定义产品行为 |
| 范围外 | 新执行后端、第二个运行时、用户数据修复、原生 Codex HOME 修改 |

## UI Surface Matrix

| 场景 | 入口 / 共享实现 | 草稿 / 权威 owner | 提交与落点 | 模式与隔离 |
| --- | --- | --- | --- | --- |
| 对话、Queue、Guide、停止与继续 | V4 pane/composer、Codex bridge | Renderer 草稿；Codex thread/CommandInbox | 既有 V4 命令 → stdio → 原生 app-server | desktop-continuous 与 web-remote-replayable 分离 |
| Codex 设置、模型与 Provider Key | settings/codex、useCodexSettings | 表单草稿；目标 Host / 原生配置 | 既有 workspace 配置端口 | 写目标不含 Agent 代际；真实 workspace 切换失效 |
| 项目历史、标题与归档管理 | project-sidebar、task-index、rollout 同步 | CLI 会话事实；Host 组织态 | sessionsIndex/reconcile、幂等 deleteSession、项目事务 | Host + canonical workspace identity；cwd 用物理目录匹配 |
| 手机、扩展与 Android 远控 | 既有 relay transport 和 shared-host attachment | 原 Host / transport owner | E2EE + Gzip → 既有 RPC / replay | 不新增 Agent、Host、accepted queue 或业务 relay 状态 |
| Source Server 更新与 Usage Stats | 连接管理、设置与用量面板 | 所属服务器 Host | GitHub Release 固定索引 / 原服务 | remoteSessionId、identity 和所属服务器贯穿 |
| Automations | 既有表单与调度器 | 表单草稿；Host dispatch owner | 保存的目录/模型 → 所属窗口 attachment | 稀疏默认值、幂等关联、失败释放与有界恢复 |
| Computer Use | 自研 codez-cua、原生 MCP 桥接 | Local Host 授权与既有 broker | 平台端口、按字节解帧 | 上游仍是 fail-closed stub，不替换真实实现 |

## Shared And Divergent Behavior

| 关注点 | 共享部分 | 必须保留的差异 |
| --- | --- | --- |
| UI / 候选 | 已有共享组件、模型候选、项目目录投影 | 对话配置、Automation record 和 Subagent 配置的提交 owner 不合并 |
| 默认与校验 | 当前公共协议、严格 schema 与平台注入 | yolo 必须 approvalPolicy=never；远端身份不能仅凭 cwd |
| 提交 | 原 CommandInbox、owner/lease 与幂等 ID | 冷历史分页只读恢复不能重试 resume / 写命令 |
| 持久化与恢复 | 既有索引和可重建投影 | rollout 缓存仅写 Codez 数据根，不持久化 synced，不写原生 Codex HOME |

## Feature Relationships

| Rank | 关系 | 证据 / 检查 |
| --- | --- | --- |
| must-inspect | 上游同步 → 新 rename → 各定制提交 | 逐提交迁移；记录冲突文件与处理理由 |
| must-inspect | Codex thread owner → bridge 投影 → V4 / task-index | bridge 原生测试、定制回归、既有协议 spec |
| must-inspect | 初次发现 / 创建 → Host 原子归属 → 首次 subscribe | 项目目录、task-index、session creation 三方保持原合同 |
| must-inspect | renderer attachment 首帧 → pairedWaiters → join | connectionReadiness / initialPairingDeadline，不提前 join |
| conditional | 上游 CUA 是否开源 → 实现选择 | README、placeholder 标记与 broker unavailable 实证：保留自研 |
| invariant-only | 品牌转换 → 外部线协议 / 官方插件 | 例外原样；lockfile 和 upstream-snapshot 不作为冲突兜底数据 |
| evidence-only | 上游测试退役 → 定制验证入口 | 区分工程、fork regression、CLI/CUA、bridge Node 测试与 E2E |

## State Owners And Commit Sinks

| 状态 | 唯一 owner | 迁移不允许改变 |
| --- | --- | --- |
| 会话、轮次、已接受队列 | 原生 Codex / CLI CommandInbox | 不在 Renderer、Main、relay 增加副本 |
| 项目、roots、归档、置顶、未读 | 所属 Host app 库 | 现有事务、CAS、迁移 checksum 与首次归属 |
| 活动时间 | ThreadStateStore 单调时钟 | 仅接受活动 / 定时历史推进；rollout 取真实记录而非 mtime |
| 冷恢复 | 现有 load single-flight 与 native history | metadata-only resume；有界只读分页；保留在飞轮次 |
| Provider 写事务 | workspace 写目标与既有 mutation guard | deferredRuntimeRestarts 累计，errorTarget 保留错误 |
| 网络连接与更新 | 既有窗口连接 Registry / Source Manager | attachment、lease、换代与下载终态校验 |

既有事件顺序保持：

```text
desktop continuous ──────────┐
                             ├─ trusted attachment → owner/lease → CommandInbox → native thread
mobile replayable / E2EE ────┘                                      │
                                     UI projection ← snapshot / ordered events

Codex 事实 → taskIndexSyncer → Host CLI 镜像
Host 组织命令 → 原事务 / CAS → 同一 app 索引 → 侧栏投影
```

## Must-Preserve Invariants

- `RowBudgetExceededError` 仅 conversation-projection 非 fatal，按 state 版本粘住故障，不截断；
  空 turns 使用 lastTurn，reload 清 apiRetry；非 full 轮次先 hydrate；冷恢复保留在飞轮次。
- CUA / browser broker 帧按字节累计，完整帧才 UTF-8 解码，32 MiB fail-closed。
- 保留 thread-activity、thread-index、native-thread-title、native-stderr-summary、runtime-notices。
- `isInjectedCodexContextTitle` 同时覆盖 AGENTS.md 片段与 environment_context，五个既有消费点共用。
- 缓存 scope/version/corruption fail-open；synced 现场重算；保留已有 delta、扇出、分页与查询优化。
- 完整保留 Codex 原生设置、调用轨迹、工具卡/图片/Plan/MCP approval、auto-approval review、
  instant_interrupt=false、Gemini wire API、Provider Key 轮换与并发读取合并。
- 保留物理 cwd 历史发现、首次归属预留、同 roots 恢复项目、全局 rollout 补种和 ensureHost 屏障。
- 保留 X25519/AES-GCM、Gzip、扩展及 Android 资产、OAuth/QR query/hash、
  attachment 首帧 readiness、跨 workspace 加密 transport 复用和 replayable reasoning 抑制。
- 保留 GitHub Release 分发、内嵌 runtime、Source Server 必需升级与重试、SSH auto、
  Automation 隔离、任务悬浮卡/时间戳/错误详情、Worktree 和全部定制 CI 抗抖动守卫。

## 品牌转换

转换 `ZCode/zcode/ZCODE` 与路径为 `Codez/codez/CODEZ`，但原样保留：

`cdn-zcode.z.ai`、`zcode.z.ai`、`/api/v1/zcode-plan`、`zcode-plugins-official`、
`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID`、`.zcode-runtime`、`zcode_type`、混合大小写 `Zcode*`，
以及 bridge / `specs/codex-zcode-plugin-compatibility.md` 的官方插件 `ZCode*` / `ZCODE_PLUGIN_ROOT`。

新 rename 的 `pnpm-lock.yaml` 与 `scripts/architecture/upstream-snapshot.json`
必须逐字节等于上游相同转换结果，不重生成 snapshot，不覆盖上游新模块。

## Codegraph Evidence

| Seed | 方法 | 边界结论 |
| --- | --- | --- |
| BridgeRuntime / ThreadStateStore | 固定原 HEAD 的源码与原生测试、architecture:context codex-bridge | stdio 边界；Codex 权威不变 |
| ProjectRepository / task-index / sidebar | 固定原 HEAD、功能图一跳、architecture:context project-storage | Host 组织态 / CLI 事实不合并 |
| Remote transport / attachment / Source update | 固定 refs 的 Git diff 和目标合同 | 保留两种 delivery 及窗口连接 owner |
| 上游构建 / 测试入口 | 最新 package.json / Git tree | 采用新工程链路，明确补充 fork 定制验证 |

本次环境未提供 codegraph explore/callers/impact 接口；Git 精确差异、公共合同与测试作为证据，
不把静态可达性宣称为产品依赖。功能图扫描深度为一跳，代码依赖按具体冲突补查。

## Graph Drift Candidates / Graph Delta

没有新增产品语义；不重写功能图。上游测试证据退役及新模块属于工程迁移，
既有定制回归引用按最终实际入口维护。

## 定制文件的模块准入

上游快照保持纯转换，不能把本地新增文件伪装成 upstream admission。以下既有定制文件
以精确 roots 登记，保留当前文件路径和真实调用端口；不移动运行时 owner 或新增写入路径。
先补合同与示例，再登记依赖方向，模块元数据不创造第二份产品状态。

| 文件 | 模块 / 层 | 保持的 owner |
| --- | --- | --- |
| workspaceRemovalSafety、workspaceRuntimeRelease、pluginCreatorPrefill | conversation-workspace-target / app | 既有窗口 tab、Host service 和草稿 owner |
| pluginIconSource | workspace-plugin-preview / ui | 既有 plugin catalog；仅可信图标展示 |
| conversationShareConnectionScope | conversation-share-attachment / adapters | 既有 attachment / share service |
| pluginStoreOrdering | plugin-store-ordering / domain | 纯排序，不写插件安装态 |
| useDynamicWorkflowAvailability | dynamic-workflow-availability / app | 既有 capability query；hook 仅展示派生值 |
| desktopUpdateMenu | desktop-update-presentation / domain | updater 权威不变；纯菜单投影 |
| featureSuggestedPrompts、officeSuggestedPrompts | draft-suggested-prompts / domain | 既有草稿和业务配置；纯建议内容 |

## 测试与发布

采用本轮用户明确要求的定向 App Vitest 作为 fork 定制回归例外：
只保留定制提交涉及的回归，不批量恢复上游退役 App UT、不把业务测试加入工程白名单。
上游 `engineering`、affected、worktree / schema / architecture / retired evidence 门禁继续保留。
Node/tsx 测试独立执行，不能以 Vitest 未选中冒充通过。

按顺序执行 pnpm install、typecheck、bridge test、test:codex、CLI build 与冲突相关定向验证，
最后 `CODEZ_PRE_PUSH_BASE=56457972 pnpm verify:pre-push`。报告真实失败及允许的环境限制。
远端原 main 先备份至 `backup/pre-rebase-3.17.1`，发布使用原远端 SHA 的显式 force-with-lease。

## Unresolved Questions

| 项 | 处理边界 |
| --- | --- |
| 最终 lockfile 与定制依赖 | 新 rename 必须纯转换；最终依赖一致性也必须验证。若定制 importer 无法保持纯转换，必须明确报告并取得裁决，不交付 manifest / frozen lock 不一致 |
| 上游 API 变化 | 按具体冲突审查；改变原定制产品语义时需用户确认 |
| 运行时 / 平台验证 | 未实际运行的 GUI、手机或其他 OS 验收不能宣称通过 |
