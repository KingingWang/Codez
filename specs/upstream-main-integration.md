# 上游 main 集成合同（3.18.2）

## Feature Summary

| 项       | 约束                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| 目的     | 将 Codez 定制提交迁移到 ZCode 上游 main，保留已有产品行为                     |
| 上游     | `fec975905a2abd4c07e35c40d51fa097a2258ec9`，3.18.2                            |
| 原项目   | `38ef71e1cde75ba1ed8d56c8adeaa0400867e776`                                    |
| 原基准   | `b95ebaffe` → `a35460ec6cef530293206a8a95668d92606de15d`（原重命名提交）      |
| 新基准   | `27e6bf6207a9edaf05a4f4e0881bab9ec33afb3c`，纯产品品牌及路径转换              |
| 本地备份 | `backup/pre-rebase-3.18.0-local`                                              |
| 改动层   | presentation / validation / persistence / recovery 的兼容迁移，不新增产品语义 |
| 模式     | impact-only；既有 spec 和回归证据继续定义产品行为                             |
| 范围外   | 新执行后端、第二个运行时、用户数据修复、原生 Codex HOME 修改                  |

## UI Surface Matrix

| 场景                             | 入口 / 共享实现                                | 草稿 / 权威 owner                        | 提交与落点                                                     | 模式与隔离                                              |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| 对话、Queue、Guide、停止与继续   | V4 pane/composer、Codex bridge                 | Renderer 草稿；Codex thread/CommandInbox | 既有 V4 命令 → stdio → 原生 app-server                         | desktop-continuous 与 web-remote-replayable 分离        |
| Codex 设置、模型与 Provider Key  | settings/codex、useCodexSettings               | 表单草稿；目标 Host / 原生配置           | 既有 workspace 配置端口                                        | 写目标不含 Agent 代际；真实 workspace 切换失效          |
| 项目历史、标题与归档管理         | project-sidebar、task-index、rollout 同步      | CLI 会话事实；Host 组织态                | sessionsIndex/reconcile、幂等 deleteSession、项目事务          | Host + canonical workspace identity；cwd 用物理目录匹配 |
| 手机、扩展与 Android 远控        | 既有 relay transport 和 shared-host attachment | 原 Host / transport owner                | 原 X25519 + XChaCha20-Poly1305 E2EE + Gzip → 既有 RPC / replay | 不新增 Agent、Host、accepted queue 或业务 relay 状态    |
| Source Server 更新与 Usage Stats | 连接管理、设置与用量面板                       | 所属服务器 Host                          | GitHub Release 固定索引 / 原服务                               | remoteSessionId、identity 和所属服务器贯穿              |
| Automations                      | 既有表单与调度器                               | 表单草稿；Host dispatch owner            | 保存的目录/模型 → 所属窗口 attachment                          | 稀疏默认值、幂等关联、失败释放与有界恢复                |
| Computer Use                     | 自研 codez-cua、原生 MCP 桥接                  | Local Host 授权与既有 broker             | 平台端口、按字节解帧                                           | 上游仍是 fail-closed stub，不替换真实实现               |

## Shared And Divergent Behavior

| 关注点       | 共享部分                               | 必须保留的差异                                                      |
| ------------ | -------------------------------------- | ------------------------------------------------------------------- |
| UI / 候选    | 已有共享组件、模型候选、项目目录投影   | 对话配置、Automation record 和 Subagent 配置的提交 owner 不合并     |
| 默认与校验   | 当前公共协议、严格 schema 与平台注入   | yolo 必须 approvalPolicy=never；远端身份不能仅凭 cwd                |
| 提交         | 原 CommandInbox、owner/lease 与幂等 ID | 冷历史分页只读恢复不能重试 resume / 写命令                          |
| 持久化与恢复 | 既有索引和可重建投影                   | rollout 缓存仅写 Codez 数据根，不持久化 synced，不写原生 Codex HOME |

## Feature Relationships

| Rank           | 关系                                               | 证据 / 检查                                                  |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| must-inspect   | 上游同步 → 新 rename → 各定制提交                  | 逐提交迁移；记录冲突文件与处理理由                           |
| must-inspect   | Codex thread owner → bridge 投影 → V4 / task-index | bridge 原生测试、定制回归、既有协议 spec                     |
| must-inspect   | 初次发现 / 创建 → Host 原子归属 → 首次 subscribe   | 项目目录、task-index、session creation 三方保持原合同        |
| must-inspect   | renderer attachment 首帧 → pairedWaiters → join    | connectionReadiness / initialPairingDeadline，不提前 join    |
| conditional    | 上游 CUA 是否开源 → 实现选择                       | README、placeholder 标记与 broker unavailable 实证：保留自研 |
| invariant-only | 品牌转换 → 外部线协议 / 官方插件                   | 例外原样；lockfile 和 upstream-snapshot 不作为冲突兜底数据   |
| evidence-only  | 上游测试退役 → 定制验证入口                        | 区分工程、fork regression、CLI/CUA、bridge Node 测试与 E2E   |

## State Owners And Commit Sinks

| 状态                          | 唯一 owner                                | 迁移不允许改变                                          |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| 会话、轮次、已接受队列        | 原生 Codex / CLI CommandInbox             | 不在 Renderer、Main、relay 增加副本                     |
| 项目、roots、归档、置顶、未读 | 所属 Host app 库                          | 现有事务、CAS、迁移 checksum 与首次归属                 |
| 活动时间                      | ThreadStateStore 单调时钟                 | 仅接受活动 / 定时历史推进；rollout 取真实记录而非 mtime |
| 冷恢复                        | 现有 load single-flight 与 native history | metadata-only resume；有界只读分页；保留在飞轮次        |
| Provider 写事务               | workspace 写目标与既有 mutation guard     | deferredRuntimeRestarts 累计，errorTarget 保留错误      |
| 网络连接与更新                | 既有窗口连接 Registry / Source Manager    | attachment、lease、换代与下载终态校验                   |

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
- 保留源码实际已有的 X25519/XChaCha20-Poly1305、Gzip、扩展及 Android 资产、OAuth/QR query/hash、
  attachment 首帧 readiness、跨 workspace 加密 transport 复用和 replayable reasoning 抑制。
- 保留 GitHub Release 分发、内嵌 runtime、Source Server 必需升级与重试、SSH auto、
  Automation 隔离、任务悬浮卡/时间戳/错误详情、Worktree 和全部定制 CI 抗抖动守卫。

提示词的 AES-GCM 描述与原 HEAD 的真实 E2EE 实现不符。本轮以功能及客户端兼容为准，
保留原 cipher、nonce、key derivation 与 `#e2ee=v1&k=...` 线协议，不静默替换算法。

## 品牌转换

转换 `ZCode/zcode/ZCODE` 与路径为 `Codez/codez/CODEZ`，但原样保留：

`cdn-zcode.z.ai`、`zcode.z.ai`、`/api/v1/zcode-plan`、`zcode-plugins-official`、
`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID`、`.zcode-runtime`、`zcode_type`、混合大小写 `Zcode*`，
以及 bridge / `specs/codex-zcode-plugin-compatibility.md` 的官方插件 `ZCode*` / `ZCODE_PLUGIN_ROOT`。
域名例外同时涵盖正则和 JSON 转义形式 `zcode\.z\.ai` / `zcode\\.z\\.ai`，
避免品牌转换后失去官方 endpoint 的匹配能力。

新 rename 的 `pnpm-lock.yaml` 与 `scripts/architecture/upstream-snapshot.json`
必须逐字节等于上游相同转换结果，不重生成 snapshot，不覆盖上游新模块。

## Codegraph Evidence

| Seed                                          | 方法                                                            | 边界结论                               |
| --------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| BridgeRuntime / ThreadStateStore              | 固定原 HEAD 的源码与原生测试、architecture:context codex-bridge | stdio 边界；Codex 权威不变             |
| ProjectRepository / task-index / sidebar      | 固定原 HEAD、功能图一跳、architecture:context project-storage   | Host 组织态 / CLI 事实不合并           |
| Remote transport / attachment / Source update | 固定 refs 的 Git diff 和目标合同                                | 保留两种 delivery 及窗口连接 owner     |
| 上游构建 / 测试入口                           | 最新 package.json / Git tree                                    | 采用新工程链路，明确补充 fork 定制验证 |

本次环境未提供 codegraph explore/callers/impact 接口；Git 精确差异、公共合同与测试作为证据，
不把静态可达性宣称为产品依赖。功能图扫描深度为一跳，代码依赖按具体冲突补查。

## Graph Drift Candidates / Graph Delta

没有新增产品语义；不重写功能图。上游测试证据退役及新模块属于工程迁移，
既有定制回归引用按最终实际入口维护。

## 定制文件的模块准入

上游快照保持纯转换，不能把本地新增文件伪装成 upstream admission。以下既有定制文件
以精确 roots 登记，保留当前文件路径和真实调用端口；不移动运行时 owner 或新增写入路径。
先补合同与示例，再登记依赖方向，模块元数据不创造第二份产品状态。

| 文件                                                                  | 模块 / 层                                | 保持的 owner                             |
| --------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| workspaceRemovalSafety、workspaceRuntimeRelease、pluginCreatorPrefill | conversation-workspace-target / app      | 既有窗口 tab、Host service 和草稿 owner  |
| pluginIconSource                                                      | workspace-plugin-preview / ui            | 既有 plugin catalog；仅可信图标展示      |
| conversationShareConnectionScope                                      | conversation-share-attachment / adapters | 既有 attachment / share service          |
| pluginStoreOrdering                                                   | plugin-store-ordering / domain           | 纯排序，不写插件安装态                   |
| useDynamicWorkflowAvailability                                        | dynamic-workflow-availability / app      | 既有 capability query；hook 仅展示派生值 |
| desktopUpdateMenu                                                     | desktop-update-presentation / domain     | updater 权威不变；纯菜单投影             |
| featureSuggestedPrompts、officeSuggestedPrompts                       | draft-suggested-prompts / domain         | 既有草稿和业务配置；纯建议内容           |

剩余准入复用已有真实端口，不接管整个 UI、Host、Main 或 Service 目录。四件套仅包含
`module.ts`、`contract.ts`、`contract.example.ts`、`CONTRACT.md`，不新增 App 单测。
兼容入口保持现有路径；公开类型优先复用共享端口，不复制业务状态。

| 模块                                    | 层       | 保持的职责与 owner                                        |
| --------------------------------------- | -------- | --------------------------------------------------------- |
| desktop-codex-automation-reconciliation | adapters | 原 Host dispatch 的只读原生关联对账                       |
| desktop-model-selection-attachment      | adapters | 原 Host 模型服务的可信 attachment 作用域                  |
| desktop-native-browser-control-host     | adapters | Main 下发能力的 Host 投影和请求转发                       |
| desktop-native-browser-control-main     | adapters | Main 唯一窗口 token、授权和 Browser dispatch              |
| desktop-product-runtime                 | adapters | 既有构建 flavor、数据根与固定发行索引                     |
| desktop-renderer-recovery               | adapters | 原窗口的有界原地恢复，不替换 attachment                   |
| cua-native-producer                     | adapters | 原 producer 的 native single-flight、snapshot、输入与销毁 |
| cua-helper-runtime                      | adapters | 原 Helper factory 的认证、就绪、socket 和 shutdown        |
| cua-pip                                 | adapters | 原 coordinator/presenter，保持 writer epoch               |
| cua-runtime-qa                          | adapters | 现有显式 CUA smoke，不成为产品服务                        |
| cli-memory-preferences                  | adapters | 原 Host 偏好与 CLI fallback 合成                          |
| codex-native-session-adapter            | adapters | 原 stdio 命令、诊断和可重建事件投影                       |
| codex-automation-adapter                | adapters | 原 dispatch/association owner，不增加 accepted queue      |
| codex-native-control-adapter            | adapters | 原 grant publisher、relay 和 managed skill                |
| codex-file-rewind                       | adapters | 原文件校验、ledger 与补偿顺序                             |
| git-worktree-lifecycle                  | adapters | 原 Git operation/锁/preview digest 与安全删除             |
| codex-model-selection                   | app      | 原 workspace catalog 与 single-flight owner               |
| codex-provider-key                      | adapters | 原 source/native 写目标，保留轮换重启守卫                 |
| codex-usage-observation                 | app      | 原所属 Host 的观察缓存，不合并 Coding Plan                |

CUA 顶层 JS 是直接产品源码。为使真实依赖、环和行数进入检查，增加 package legacy 扫描根，
再由精确 managed roots 接管；不能利用精确文件根未枚举的缺口假通过。Helper 与 producer
按无状态解析、native 观察、应用解析职责拆分，原 factory 保留全部 mutable state；
原 exports、14 个 wire method、验证/授权顺序、late-result 防护和打包入口不变。
新增嵌套 JS 必须通过现有运行时闭包打包回归。

Host→Main 浏览器 broker 与 bridge 统一完整帧字节解码，保留请求 1 MiB、响应 32 MiB 上限，
不重发 native mutation；细则及可重复 socket 场景见 native Browser/CUA spec。

## 测试与发布

采用本轮用户明确要求的定向 App Vitest 作为 fork 定制回归例外：
只保留定制提交涉及的回归，不批量恢复上游退役 App UT、不把业务测试加入工程白名单。
上游 `engineering`、affected、worktree / schema / architecture / retired evidence 门禁继续保留。
Node/tsx 测试独立执行，不能以 Vitest 未选中冒充通过。

### CI 定向验证合同

`scripts/fork-regression-test-files.json` 是既有定制回归的唯一准入和框架分类来源。
发布工作流保留原有测试意图及回放过程中新增的定向项，只调整执行入口，不新增 App
单测、不恢复无关退役测试、不修改工程名单、依赖或 lockfile。

| 验证类别                                     | 执行入口                                                          | 必须拒绝的情况                                         |
| -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| 已登记 App Vitest                            | `pnpm test:fork <精确文件...>`                                    | 空参数、目录/glob、未登记或尚未回放文件、Node/工程误送 |
| 已登记 Node/tsx                              | 按所属包分别执行 `tsx --test <精确文件...>`，UI 保留其包 tsconfig | 跨包混跑、框架误送、用默认发现代替精确选择             |
| 既有工程 Vitest                              | `pnpm test:engineering <精确工程文件...>`                         | App 回归进入 engineering 名单                          |
| Bridge、CLI/CUA、原生 smoke 与打包 Node 测试 | 原有包入口或明确的 `node --test` / smoke 命令                     | 默认 Vitest 空选中或绕过原生验证                       |

执行顺序保持：先恢复全部定制提交，再核对工作流最终文件清单与根准入名单，
然后进行定向验证和原有构建/发布。每个命令传递真实退出码；无测试选中、文件缺失或
选择器失败不能记为通过，也不能通过默认全量发现扩大验证范围。

`codex-desktop` 保留 Linux 一次性 service/desktop/server/UI 回归、六个桌面 OS/arch
构建目标、四个远端目标及所有原生 smoke；`mobile-remote-pages` 保留加密、Gzip、
pairing、路由、OAuth、恢复等最终回放后的定向文件及扩展构建/Pages 发布流程。

按顺序执行 pnpm install、typecheck、bridge test、test:codex、CLI build 与冲突相关定向验证，
最后 `CODEZ_PRE_PUSH_BASE=27e6bf6207a9edaf05a4f4e0881bab9ec33afb3c pnpm verify:pre-push`。
报告真实失败及允许的环境限制。
远端原 main 先备份至 `backup/pre-rebase-3.18.0`，发布使用原远端 SHA 的显式 force-with-lease。
测试完成后、最终 pre-push 与提交前再次 fetch `origin/main`；若相对备份点有新增定制提交，
先核查并回放这些增量，不能把旧 fork 基准重新 rebase 进已迁移的新历史。
push 成功后仅跟踪最终发布 SHA 的构建，使用 `clock.sleep` 每十分钟查询一次；
失败时读取真实失败日志、按本合同修复验证后再推送，不将 rerun/旧 SHA 成功当作最终成功。

### 3.17.2 迁移验收

原工作树干净，原 rename 之后是 144 个线性定制提交，无 merge。逐提交回放，不以覆盖整个
文件或整棵旧 tree 的方式丢弃上游变化。分页合同已在 `specs/codex-desktop-adapter.md`，
原 HEAD 没有未提交的 `specs/codex-cold-history-paging.md`。

本轮不新增产品语义，优先适配上游新的 draft prewarm / restart、MCP 控制面、
本地 HTML 预览、文件打开应用及依赖清理接口，保持既有 owner、lease 和 admission 顺序。
README 更新段同时保留 3.17.2 上游条目与 Codez Computer Use / Codex bridge 条目。
发行测试中真正的 app 版本断言改为 3.17.2，relay wire 继续为 `zcode_type`。

新增上游源文件由本轮纯转换 snapshot 准入；定制文件仍由已有精确模块 roots 管理，
不向 snapshot 写入定制事实。使用新 rename 作为大范围 diff 的复核基准。

上游 fork 预留方法与既有物理目录逻辑合并后，`project-repository.ts` 达到 843 行，
超过现有 800 行工程限制。将 `readProjects`、`requireProject`、`tableExists`、`readTask`
等只读记录 helper 移入同模块 adapters 内部 `project-records.ts`；SQL、数据映射、
调用方 Host 过滤与事务边界保持不变，不新增缓存、写入 owner、跨模块公开入口或 App 单测。
回归依据为既有项目仓库、原生归属、远端单 root 和 migration-order 定制回归，
再执行类型、Lint 与收窄架构门禁。

上游 3.17.2 的「远端 NULL 归属是未完成交接」包含两部分：一次性迁移
`0010_remote_task_ownership` 与 `admitTaskIdentity` 在后续事实摄入时的宽 WHERE 重算。
本轮保留前者，收窄后者为 fork 的「首次发现判定一次」（`host_id IS NULL`），已决定行只补
当前 owner 的 `physical_root_path`。依据是本 fork 让远端外部 Codex 历史的 NULL 成为合法
只读状态（任务区可见、可打开、按物理 cwd 匹配），若摄入时重算，用户新建同目录项目会静默
吞并这些历史任务，违反 session-management 不变量 I17 与保留回归
`codexGlobalRolloutSyncer.test.ts`「先有 rollout 后建软链接项目」；上游晚到父证据仍由
`reserveCreatedTask({parentTaskId})` 的 ACK 前交接补齐，`repairRemoteTaskOwnership`
只在迁移中运行。该取舍属于上游语义变化影响 fork 产品行为，已在最终报告中列为需确认项。

同时把 fork 保留的旧库夹具 `project-storage/test-fixture.ts` 的 tasks 表补上
`forked_from_task_id`：真实基线 `session/tasksDatabase/schema-v1.ts` 自开源首版就有该列，
上游 0010 迁移读取它，夹具缺列会让迁移在测试里报 no such column。

上游 3.17.2 还在 CLI 冷恢复物化路径新增了创建期 `runtimeConfig.memory.enabled=false` 注入。
Codez 不采用该第二条写入路径：Host 记忆偏好继续只由 `materializeSessionRecord` 创建后的
`applyHostMemoryPreferencesToRecord` 应用（`specs/codez-memory-settings.md`），因为它同时承担
热更新与「CLI config.json 显式禁用不被 Host 开启值反向覆盖」的 `host && local` 规则；创建期注入
会把 Host 值混进本地快照，使该规则失效。上游 `v4-cold-resume` 的对应用例改为断言冷恢复物化后
runtime 上实际生效的 `memory.enabled === false`，覆盖意图（Host 关闭时冷恢复不得启用记忆、
且只物化一次）不变，仅观察点从创建参数换成生效配置。

fork 保留的项目迁移回归按上游账本对齐：`schema_migration` 与 `result.applied` 断言补上
`0010_remote_task_ownership`，不修改任何已发布迁移的 SQL 或 checksum。

发布前分别报告：冲突提交/文件/处理依据、回放计数、核心回归清单、真实验证退出码、
安装导致的最终依赖锁变化，以及未实际完成的 GUI / 手机 / 其他 OS 验收。
若上游 CUA 仍有 placeholder / unavailable，则保留自研实现；若已完整开源且切换会改变
授权或 Codex MCP 语义，先列出兼容性差异并取得用户确认。

重命名基准中的 lockfile 必须是逐字节纯转换。原最终 lock 含 Codex bridge importer、
E2EE 与 UI 回归依赖，不能把后续 install 同步的定制依赖变化称为纯转换；若本轮要求
最终 lock 也完全等于上游转换，且上游仍缺这些 importer / 依赖，发布前必须确认该约束，
不得删除依赖、伪造 frozen-install 通过或安装后恢复旧锁掩盖差异。

### 3.18.2 迁移验收

原工作树干净，原 rename 之后是 182 个线性定制提交，无 merge；原 HEAD 没有未提交的
`specs/codex-cold-history-paging.md`（分页合同仍在 `specs/codex-desktop-adapter.md`）。

品牌转换本轮改为可重放脚本：先对 v3.18.0 基线重算，得到与原重命名提交完全相同的 tree
（`dcbeef44797fa9ad4d95d005a203744e711baddd`），再据此在上游最新 sync 上生成新基准。
`pnpm-lock.yaml` 与 `scripts/architecture/upstream-snapshot.json` 因此天然是纯转换结果，
不重生成 snapshot，不写入定制事实。例外集按源码实测收敛为 `zcode.z.ai`
（含 `zcode\.z\.ai` / `zcode\\.z\\.ai` 转义形）、`/api/v1/zcode-plan`、
`zcode-plugins-official`、`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID`、`.zcode-runtime`、
`zcode_type` 与混合大小写 `Zcode*`；`zcode-plan`、`zcode-runtime-*` 等非例外形态照常转换，
上游文件内的 `ZCODE_PLUGIN_ROOT` 同样转换，codex-bridge 与
`specs/codex-zcode-plugin-compatibility.md` 的例外只作用于 fork 自有文件。
三组替换全部等长，因此 `config/provider/regression/fixtures/marker.pdf` 的 stored deflate 块
必须在替换后重算 Adler-32，否则严格 PDF 读取器会拒绝该 fixture。

本轮上游在验证期间又发布 v3.18.2，基准随之从 v3.18.1 前移到 v3.18.2：先在 v3.18.1
新基准上完成 182 个定制提交回放与 4 处冲突解决，再把已解决的历史整体 `rebase --onto`
到 v3.18.2 新基准。最终新基准相对原 rename 恰好是上游 v3.18.0→v3.18.2 的累积差异
（v3.18.1：111 文件 / 3906 插入 / 528 删除；v3.18.2：46 文件 / 1971 插入 / 171 删除），
版本事实随上游变为 3.18.2；`pnpm install` 后 lockfile 无变化。

v3.18.1 回放阶段：182 个定制提交逐条回放，4 处冲突：

| 提交        | 冲突文件                                 | 处理                                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2fddb58bd` | `.gitignore`                             | 并列保留上游新增的 CR-01 `packages/desktop/build/generated/` 与 fork 的本地产物忽略块；`.zcode-runtime/` 沿用 fork 形态                                                                                                                                                  |
| `da02d6a`   | `architecture-policy.yaml`               | 同一插入点做 union：上游 `cli-memory-diagnostics` 模块与 fork 5 个 helper 模块并存；YAML 解析、模块总数与两侧模块 id 存在性复核                                                                                                                                          |
| `6d8def3`   | `packages/web/.../remote-task-open.mjs`  | 以 fork E2EE 版本为基，补入上游新增的 `getSessionLifecycle` handler 与任务首页返回箭头／导航历史断言，`results` 保留 `taskHomeArrow`；上游新增行逐行校验全部命中                                                                                                         |
| `38ef71e1c` | `scripts/build-windows-runtime-host.mjs` | 保留 fork 的 CMake 生成器探测循环，把上游第二个目标 `codez-installer-process-helper` 并入同一次 configure 后的构建、PE 校验、拷贝与 `build.json` 的 `installerProcessHelper`；产物路径改用生成器感知的 `resolveBuiltRuntimeHostBinary`，不沿用上游写死的 `Release/` 目录 |

回放后按「上游新增行与 fork 新增行都必须存在」逐文件机械校验 32 个交互文件，
除上表刻意合并的 13 行外全部命中；`pnpm typecheck` 通过。

v3.18.2 前移阶段：把已解决历史整体重放到新基准，只新增 1 处冲突
（v3.18.1 的 4 处冲突点上游未再改动，既有解决结果直接干净应用）：

| 提交        | 冲突文件                                          | 处理                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2fddb58bd` | `packages/desktop/src/main/desktopHostProcess.ts` | `@codez/shared` import 列表做 union：上游为「切换数据存储路径后凭据密钥共享」新增的 `CREDENTIAL_KEY_SHARE_UNAVAILABLE_ERROR_CODE` 与 fork 的 `type DesktopCodexMcpServer` 并存；上游新增的 `CredentialKeyShareRequest` 分支整体保留 |

v3.18.2 阶段同样按「上游新增行与 fork 新增行都必须存在」校验 15 个交互文件，0 缺失行。

上游 v3.18.1 删除 `packages/ui/src/side-pane-full-view/enterRequest.ts`，全仓无引用。
上游 afterPack 新增 `writeInstallerProcessHelperDefine(context, actualWindowsTarget?.arch ?? …)`，
而 `actualWindowsTarget` 属于 fork 已移除的闭源 Computer Use Helper producer 链路，
自动合并会留下悬空引用并在 win32 打包抛 ReferenceError；改用 fork 既有的 `actualCuaTarget.arch`
（同一套 `ELECTRON_BUILDER_ARCH` 归一化，configured target 与实际 context 不一致时同样抛错），
不为此重新导入 `windows-cua-helper-assets.mjs`。

发行版本断言按上轮范围同步到 3.18.2：`scripts/test-codex-distribution-release.mjs`、
`scripts/test-codex-distribution-remote-index.mjs`、`packages/server/test/remoteAssetCdn.test.ts`。
`project-storage` 迁移账本里的 `appVersion`、文档里的历史发布验收编号与上游
memory-diagnostics 夹具版本是既成事实，不改；relay wire 断言继续为 `zcode_type`。
README 更新段同时保留上游 3.18.2 / 3.18.1 条目与 Codez Computer Use / Codex bridge 条目。

### 4.0.0 迁移验收

原工作树干净；原 main（`793daafc0`）在 rename `27e6bf620` 之后是 195 个线性定制提交。
rebase 前 HEAD 已备份到本地分支 `backup/pre-rebase-4.0.0-local`，推送前再备份为
`origin/backup/pre-rebase-4.0.0`。上游 v4.0.0 sync 为 `a4b444514`（tag v4.0.0），
相对 v3.18.2 基线累积 2209 文件 / 149753 插入 / 24801 删除，是 fork 以来最大的一次上游跳跃。

品牌转换沿用可重放脚本：先对 v3.18.2 基线重算，得到与原重命名提交完全相同的 tree
（`ff0b24f9a230244df64b89641e94c65b02d71c97`），再在 `a4b444514` 上生成新基准
`25163202468e14702636ce1f512a97d4a94b5d0b`（tree `f0d670ca8bff8643cb155880a38c200002d92157`）。
verify-pure 复核 19355 文件 / 8191 blob 逐字节校验 / 0 错误；`pnpm-lock.yaml` 与
`scripts/architecture/upstream-snapshot.json` 均为纯转换结果。例外集与上一轮一致
（`cdn-zcode.z.ai`、`zcode.z.ai`、`/api/v1/zcode-plan`、`zcode-plugins-official`、
`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID`、`.zcode-runtime`、relay 线级 `zcode_type`、
混合大小写 `Zcode*`；`packages/codex-bridge/**` 与 specs/codex-zcode-plugin-compatibility.md
的 `ZCode*` / `ZCODE_PLUGIN_ROOT` 例外只作用于 fork 自有文件）。等长替换后
`config/provider/regression/fixtures/marker.pdf` 的 Adler-32 由脚本重算。

195 个定制提交全部回放（计数与原 main 一致），另加本轮适配提交。大合并提交
`ff2e1e305` → `3384ca86c` 共 42 个冲突文件，处理分组如下：

| 分组         | 冲突文件                                                                          | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CUA          | `packages/zcode-cua` vs `packages/codez-cua`                                      | 上游 v4.0.0 的 zcode-cua 0.6.6 仍是 fail-closed 占位包（package.json 自述 placeholder），按合同保留自研 codez-cua 0.1.0；上游占位 availability.test.ts 删除                                                                                                                                                                                                                                                                                                     |
| 插件市场     | marketplace 标识                                                                  | fork 打包标识 `codez-plugins-official` 保留；上游 CDN 例外 `zcode-plugins-official` 原样保留                                                                                                                                                                                                                                                                                                                                                                    |
| 打包         | electron-builder、afterPack                                                       | 上游 preinstalled-entry-shim 块保留，叠加 fork `isCodexBuild` codex/glm 三元；上游 extraResources cua-helper 块弃用（fork 经 afterPack `finalizePackagedWindowsCuaHelper` 打包，两条路径均在合并后 afterPack 内核实）                                                                                                                                                                                                                                           |
| Desktop main | node.ts、desktopCommandHandlers、main/index.ts、web/main.tsx                      | node.ts 取上游 `getCredentialsFilePath`（合并后 `resolveCredentialFilePath` 不存在）+ fork providerRuntimeApiKeyCredentialKey / nativeBrowserCua / desktopCodexMcpServers / desktopBrowserMcpStateSource / createDesktopBrowserRelay / preinstalledToolsBinDir + 合并 env 块；desktopCommandHandlers 双函数并存（上游 crash-recovery + fork resolveDesktopCodexBridgePath）；web/main.tsx 以 fork imports 为准（resolveWebRemoteControlWebSocketCtor 仍被使用） |
| 协议         | updateConfig、types.ts                                                            | updateConfig 不再含 `language`（上游移除且无调用方）；types.ts language 字段与 replyLanguage 经 union 保留；fork memory 方法保留                                                                                                                                                                                                                                                                                                                                |
| 任务索引     | codezTaskIndexSyncer、product-projection                                          | 上游活动基线（hasActivityBaseline/reportActiveSessions）+ fork seedDiscoveredTaskRows 播种；product-projection union（completedActivityCount + compactSettledRowPayloads）                                                                                                                                                                                                                                                                                      |
| Git UI       | GitBranchSwitcher                                                                 | 上游 controller 模式为骨架，移植 fork worktree 能力（worktreeMenu hook、useEffect 刷新、GitBranchListItem onDeleteBranch、GitWorktreeMenuActions）                                                                                                                                                                                                                                                                                                              |
| Composer     | slashCommandPanelSections、newTaskDraft、useDraftConfigControl                    | fork icons+BUILTIN_SLASH_MESSAGE_IDS 叠加上游 isAppSlashCommandSuggestion 兜底；fork options.codex/defaultMode/permissionModeGen 并入上游 {draft, recentModelSelection} 返回；fork codexUsesCatalog 三元重构为 if/else-if/else 并保留上游 recentModelSelection 迁移                                                                                                                                                                                             |
| E2E/SEA      | e2e subagent、build-sea.test.mjs                                                  | 取上游重构版（fork 差异仅品牌改名；doc-plugin visual-judge 已被上游移除）；fork marketplace 断言改由 sea-official-plugin-assets.mjs 强制                                                                                                                                                                                                                                                                                                                        |
| v4 会话 UI   | SessionPane、ConversationComposer、ConversationStatusPanel、ConversationTurnGroup | 四个深耦合文件整体取 fork 版：上游重写 ConversationStatusPanel（1202+/1822-，移除 GitStatusSection/gitAuxiliaryGenerationSupported），与 fork SessionPane 传参不兼容；fork 版自洽                                                                                                                                                                                                                                                                               |

后续冲突提交（旧 hash → 新 hash）：

| 提交                      | 冲突文件                                                           | 处理                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `12262f1bf` → `37589717a` | webAuthService、useRootOAuthEffects、browserOAuthCredentialRepo    | webAuthService 双方法并存（上游 resolveCallbackReturnTo + fork startPollingLogin）；useRootOAuthEffects 取上游 selection-capture + 可选调用 + HEAD always-refresh；browserOAuthCredentialRepo union（appReturnTo+regional+hash 校验）                                   |
| `02a41bf09` → `e01e87f41` | startLogin                                                         | fork popup-polling + e2ee-hash 形态（与原 main 一致）                                                                                                                                                                                                                   |
| `7050c6d41` → `31aa9cd59` | startLogin                                                         | `const pollToken` → `const token` 更名修正 + regionalProvider 收窄                                                                                                                                                                                                      |
| `4f6b9ee2d` → `e8ced0436` | pnpm-lock.yaml、package.json、cli test script、architecture-policy | lockfile 取上游版（最终 pnpm install 归一）；保留 @codez/shared 依赖并去重 @codez/codez-cua；cli test script = HEAD 减 3 个已删除 CUA 测试文件；architecture-policy 保留 HEAD roots（vitest.config.ts、wait-for-mcp-servers、tool-search-hydration 为上游 v4.0.0 新增） |
| `c0cf153f5` → `581f9e84b` | core.ts                                                            | import union，去掉未使用的 join                                                                                                                                                                                                                                         |
| `793daafc0` → `2f4b8b6c7` | locales                                                            | 取上游新 i18n 键（fork 专用键事后补回，见下）                                                                                                                                                                                                                           |
| 文档类                    | docs/specs recurring 冲突                                          | 按 fix-docs-general 策略：保留 fork 累计版（RDUX-13-LOG-01、IPv6 RDUX-13-02、BG26 细节、models/ 子目录测试路径）；换入上游 RDUX-13-04 行；SAC×2 并列；新章节 CSAQ34/MNCP 合并；task-sqlite-index.md 双章节合并                                                          |

typecheck 暴露的合并缝隙及修复（本轮适配提交）：

1. fork v4 UI 依赖的 sibling 模块被上游 v4.0.0 重写/删除（conversationLayout、
   conversationStatusPanelModel、legacyChatViewTypes、ConversationTimeline、test-ids、
   conversationSharePreflightCache）：这些文件 fork 从未定制（与上游 v3.18.2 逐字节一致），
   上游移除的是 v3.18.2 状态面板布局体系。因 fork 四 UI 文件保留，sibling 按 fork 版恢复；
   ConversationTimeline 合并保留上游 v4.0.0 改进（回底按钮样式、onAskInSideChat 可选、导航间距）。
   conversationSharePreflightCache 上游移入 conversation-share-interaction/，SessionPane 改指新路径。
2. 语音输入：上游 v4.0.0 新增 blocked/shortcut API；fork Composer 接 voiceInputBlocked =
   disabled || blockingRequestId !== null，移植上游 ownsComposerKeyboardShortcut 归属判定
   （isKeyboardEventForPane + data-session-pane-root）到 fork SessionPane/Composer。
3. ConversationBackgroundWorkTrigger（上游删除的 composer 后台任务入口）按 fork 版恢复，
   TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER、TID_CHAT_SUMMARY_PANEL 补回 test-ids。
4. locales「取上游」丢失 42 个 zh-CN / 38 个 en-US fork 专用键（chat.statusPanel._、
   chat.summaryPanel._、chat.composer.backgroundWorks.\*）：按旧 main 原值全量补回；
   chat.slash.app.plan.label 重复键去重。
5. CodezProductFlavor 含 "codex"，上游 resolvePreinstalledToolsRelease 只认 production/preview：
   main/host 两处调用点将 codex 映射为 production（codex 安装包复用 production 预装资产）。
6. 上游新增 E2E 门禁 mobile-rpc-frame-gate.ts 按上游 wire 断言 zcode_type；fork 的 RPC 传输
   载荷字段是 codez_type（e83d15f5c 确立的边界：只有 relay 信封保留 zcode_type），门禁适配 fork wire。
7. OAuth：上游 v4.0.0 把 availability 前移到设置读取之前并新增 domain 纠正流程，绕过了
   fork「陈旧 Host 即终止」守卫；在设置解析完成后补回 isCurrent 复查（保留上游纠正流程），
   四个回归夹具补齐 oauthService。
8. 崩溃恢复：合并同时保留了上游 showRendererCrashDialog 接线与 fork rendererCrashRecovery
   接线，同一 render-process-gone 会双重处理；移除上游对话框接线，保留 fork 有界原地 reload
   （codexRendererCrashRecovery 回归守护）。desktopCommandHandlers 的对话框函数与
   restartAppAfterCrash 机制保留（命令处理器仍用）。
9. SEA computer-use 插件条目重复（上游占位 0.6.6 条目 + fork 0.1.0 条目）：移除上游条目与
   sea-cua-runtime-assets.mjs 占位机制，保留 fork 条目；build-sea.test.mjs 补 codez-cua-plugin
   skill-only fixture。
10. 测试对齐上游 v4.0.0 合同（沿用 02a41bf09 先例）：messageTelemetry 新增首响归属字段
    （is*first_message/send_mode/ttft*\*）与 agent_step error_code；WorkspaceHelpMenuButton
    新增 preinstalledTools.title 菜单项；WorkflowRunDirectorySidePane completed 行不再渲染
    状态词；gitCliRepo 安全参数集中到 GitCommandProvider.buildProductGitArgs（fake argv 对齐）；
    codezAgentService 运行时偏好投影新增 agentAlwaysBackgroundEnabled/totalTokensReminderEnabled；
    desktopWindowLifecycle 夹具补必填 currentReplyLanguage（上游 v4.0.0 特性）；
    remoteDeploy 官方插件资产断言随 visual-judge 移除改抽样 LibreOffice 调用脚本；
    test-codex-distribution-runtime 打包夹具 stub @napi-rs/keyring 原生模块与 node:os 新导出。

发行版本断言同步到 4.0.0：`scripts/test-codex-distribution-release.mjs`（13 处）、
`scripts/test-codex-distribution-remote-index.mjs`（19 处 + 1 处转义正则）、
`packages/server/test/remoteAssetCdn.test.ts`（1 处）。project-storage 迁移账本 appVersion、
历史文档验收编号、memory-diagnostics 夹具版本与源码内历史 bugfix 注释不改；
relay wire 断言继续 `zcode_type`。README 更新段同时保留上游 4.0.0 条目与
Codez Computer Use / Codex bridge 条目。lockfile 经 pnpm install 归一（fork importers +
上游 v4.0.0 依赖），`--frozen-lockfile` 复核通过。

验证结果（真实数据）：

| 项                                                                       | 结果                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm install / --frozen-lockfile                                         | 通过（lockfile 收敛 fork importers）                                                                                                                                                                                                                                    |
| pnpm typecheck                                                           | 通过（exit 0）                                                                                                                                                                                                                                                          |
| pnpm lint                                                                | 0 errors / 622 warnings（基线存量；改动区域无新增 hooks 诊断）                                                                                                                                                                                                          |
| codex-bridge test                                                        | 880 tests：875 pass / 0 fail / 5 skip（首轮全量）；event-loop lag 预算测试在高环境负载下偶发超预算（70-83ms > 60ms），单文件运行通过，非代码回归                                                                                                                        |
| test:codex 分发脚本                                                      | 98/98 通过                                                                                                                                                                                                                                                              |
| fork vitest web（13 文件）                                               | 189/189 通过                                                                                                                                                                                                                                                            |
| fork vitest services（40 文件）                                          | 766 pass / 27 fail，失败集合与旧 main 基线完全一致（0 新增）                                                                                                                                                                                                            |
| fork vitest ui（140 文件）                                               | 1800 pass / 446 fail；对照旧 main 基线（同文件集 433 fail）逐项 comm 比对：7 个真实新增失败已修复，其余为基线存量或负载抖动（单独复跑通过）                                                                                                                             |
| fork vitest desktop（29 文件）                                           | 530 pass / 8 fail / 10 skip，失败集合与旧 main 基线完全一致（0 新增）                                                                                                                                                                                                   |
| fork vitest 其余（server/client/provider/rpc/shared/server-cli 30 文件） | 485 pass / 3 fail → remoteDeploy 修复后 2 fail 均为基线存量（serverCore、CAS 表）                                                                                                                                                                                       |
| Node 批次 ui / services / server / shared / desktop                      | 290/291（1 个 .svg 加载器基线红）、219/219、38+1skip、12/12、84/84                                                                                                                                                                                                      |
| codez-cli build + test                                                   | build 通过；553 tests：547 pass / 6 fail（sea-runtime-tools 与旧 main 基线完全一致）                                                                                                                                                                                    |
| verify:pre-push（CODEZ_PRE_PUSH_BASE=25163202468）                       | exit 0：worktree / e2e-remote-targets / lint（0 errors）/ stale-phrases / db-schema / test:architecture（62 pass）/ architecture:check（0 违规）全部通过；engineering-affected 因公共配置变更按合同选中整套件（185 规格）并报告跳过、不阻止推送                         |
| pnpm test:engineering（185 规格全量，串行）                              | 首轮 1164 pass / 1 fail：上游 v4.0.0 新增审计对 3 个 fork pending 会话夹具报 PENDING_FIXTURE_FORMAL_TARGET_MISMATCH（fixture 声明的转正路径还是旧扁平布局，pending 实际在 remote/installation 场景目录）；修正 6 个 JSON 的 spec 字段后全量绿（181 文件 pass / 3 skip） |

基线对照方法：`git worktree add /tmp/codez-old-main-baseline 793daafc0`，逐包重建
node_modules 符号链接（@codez/\* 指回 worktree 源码），用同一 vitest.fork.config.ts /
tsx 入口运行失败文件集，`comm` 比对失败用例集合。旧 main 的 fork 回归套件本身存在
大面积存量红（ui 433 例、services 27 例、desktop 8 例、server 2 例、CLI 6 例、
ui Node 4 例），本轮不扩大也不掩盖：新增失败全部修复，存量红如实报告。

需用户确认的上游语义变化：CUA 绑定观察改为 emit:false 投影（身份收敛代码保留）；
四个 v4 会话 UI 文件以 fork 版覆盖上游重写；updateConfig 移除 language；
上游崩溃对话框让位 fork 有界恢复；SEA computer-use 按 fork 0.1.0 合同去重；
visual-judge 资产随上游移除；preinstalledTools 菜单项与回复语言接线为上游新特性，
codex flavor 映射 production 预装资产。

## Unresolved Questions

| 项                       | 处理边界                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最终 lockfile 与定制依赖 | 按任务第 1 步重命名基准的边界，rename 保持纯转换；最终由 pnpm install 同步真实 importer、依赖和 patch hash，并复核 frozen install。已向用户说明这一解释；snapshot 始终纯转换，不用忽略 manifest 或安装后恢复 lock 掩盖不一致 |
| 上游 API 变化            | 按具体冲突审查；改变原定制产品语义时需用户确认                                                                                                                                                                               |
| 运行时 / 平台验证        | 未实际运行的 GUI、手机或其他 OS 验收不能宣称通过                                                                                                                                                                             |
