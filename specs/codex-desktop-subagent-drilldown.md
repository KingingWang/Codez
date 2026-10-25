# Codex desktop subagent drill-down

## Outcome

Codex flavor 的子代理与原生 flavor 同形可下钻：父会话时间线里的 `spawn_agent`
卡片可点击，在右侧只读面板打开子代理自己的会话；状态面板显示运行中子代理并同样
可点；「已结束」目录通过 `session/subagents` 回看。子线程的事实源始终是 Codex
（独立 threadId + 独立 rollout），bridge 只翻译，不新建持久化、不复制历史。

原生参照：`packages/ui/src/v4/ConversationAgentToolCallRow.tsx`（卡片入口）、
`packages/ui/src/app-shell/SubagentSessionSidePane.tsx`（只读子会话）、
`packages/ui/src/v4/SubagentDrilldown.tsx`（行内迷你时间线，两种 flavor 均无挂载点，
本 spec 不接）。

## 事实源与标识

| 事实               | 来源                                                                                                                        | 用途                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `childSessionId`   | `subAgentActivity.agentThreadId`；无 activity 时取 `collabAgentToolCall(tool=spawnAgent).receiverThreadIds`（仅当长度为 1） | subagent 行、`snapshot.subagents`、side pane 订阅                                                                                                        |
| `parentToolCallId` | spawn 那个 collab item 的 `id`                                                                                              | UI 同 turn 配对                                                                                                                                          |
| 生命周期           | `subAgentActivity.kind` + 各 collab item 的 `agentsStates[childId].status`                                                  | 行/目录 status                                                                                                                                           |
| 名称与类型         | 父侧只有 `agentPath` 与 spawn `prompt`；真实 `agentNickname`/`agentRole` 只在子线程 `thread/read` 上有                      | `subagentType` 用 `subagent` fallback，标题优先 nickname                                                                                                 |
| 时间               | 行：只有 turn 级 `startedAt`/`completedAt`，item 无逐项时间戳。目录：`thread/list` 的 `createdAt`/`updatedAt`               | 行 `startedAt` = 锚定 turn 的 `startedAt`（同 turn 内的近似下界），行不设 `endedAt`；目录 `startedAt`/`endedAt` = 子线程 `createdAt`/`updatedAt`，不伪造 |

## 投影表

| 输出                                                                        | 规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagent` row                                                              | 每个 childThreadId 一行，锚定 spawn item 所在 turn 与位置；`entityId` = `codex:subagent:<childThreadId>`；`summaryText` = spawn prompt 首个非空行（≤200 字符）?? `agentPath` ?? `""`；不设 `backgrounded`/`workId`（Codex 无对应事实）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 行 status 优先级                                                            | ① `subAgentActivity`：`completed`→success、`interrupted`→cancelled；② 否则 `agentsStates[childId].status`：`completed`→success、`errored`→failed、`interrupted`/`shutdown`→cancelled、`pendingInit`/`running`→running、`notFound`→无信息不覆盖；③ 都没有→running                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 只有 activity 没有 spawn item 的历史                                        | 仍产出行，锚定首个 activity item，不带 `parentToolCallId`，走 UI 既有「同 turn 唯一剩余一对」legacy 配对                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `snapshot.subagents`                                                        | `childSessionIds` 去重；`running` 只含 status=running（收敛规则见下）；`endedTotal = max(0, childSessionIds.length - running.length)`；`revision`：空=0、非空≥1，仅在派生语义变化时 +1（renderer 用作 refresh key 与 child tab 同步 CAS）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| running 收敛（终态到达前不能把子代理从 running 拿掉，结束后也不能一直留着） | 父线程事实是主依据；但 v1 只在 `wait`/`send_input` 碰巧观测到终态时才写 `agentsStates`（实测多数 child 永远没有父侧终态），v2 只在 `Completed` 时写 `subAgentActivity`。因此 bridge 额外维护「子线程活性观测」：① 已加载子线程的原生 `status`；② 所有线程的 `turn/started`→active、`turn/completed`→非 active、`thread/status/changed` 按类型映射（子线程创建时原生会为已初始化连接自动挂 listener，事件无需打开子面板即可到达）；③ 一次性 `thread/list { parentThreadId, sourceKinds: subAgent* }` 种子：`active`→运行中，`idle` 且没有任何 turn →还在排队不判死，`idle` 且有 turn 且无 inProgress→已结束，`systemError`/`notLoaded`→已结束。命中「非 active」即不计入 running。子线程生命周期事件同时 touch 父会话触发重投影，不等下一次父事件 |
| `session/subagents`                                                         | `thread/list { parentThreadId, cwd, sourceKinds: subAgent*, modelProviders: [], archived: false }`；原生 status `active`→running，其余→ended；ended status 用父线程事实推导，不可判定用 `lost`；bridge 侧按 offset 分页并返回不透明 cursor，`ended.total` 为精确已结束数                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session/subagents` 缓存与退避                                              | 父线程已加载的子代理事实与 `session/subagents` 分类结果按 `(parentSessionId, epoch, revision)` 及子线程活性版本做有界缓存（分页切片直接复用已排序列表）；`listChildThreads` 与种子调度对同一 `parentThreadId` 进行 in-flight 合并，并在原生 `thread/list` 失败时实施有界退避冷却，防止失败风暴                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 分隔线 marker                                                               | `subAgentActivity` 的 `codexEvent` marker 保留不变（additive）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 只读边界

- 子线程判定：`thread/read` 返回的 `parentThreadId` 非空。bridge 内部标记
  `readOnly: "subagent-child"`。
- 加载顺序：`thread/read` → 按原生 `ThreadStatus` 分流 → `thread/turns/list` 免锁读历史。
  - `idle`/`active`/`systemError`（原生已把子线程加载进本进程）：走 `thread/resume`。
    此时 resume 的语义是「回放历史 + 原子订阅」（codex-rs
    `app-server/src/thread_state.rs`），不改写 rollout，用来拿子线程实时
    `item/started`/`item/completed`。
  - `notLoaded`：**跳过 resume**，只用 read envelope + `thread/turns/list` 做只读投影
    （`attached: false`）。原因见「已知边界与降级」的 rollout 改写条目。
  - resume 失败一律降级为 read envelope 只读，不要求 writer-conflict 错误签名。
  - 只读加载一律跳过 queue 读取。
- cwd：子线程放宽，物理路径不同也允许只读投影（child id 只来自父线程 item，不是用户
  输入）；可写线程仍按物理路径严格校验。
- 命令：任何非空 `readOnly` 一律 deny；子代理用 `guard.subagentReadOnly`（与原生
  同 reasonCode），fork 逃生通道保留。availability 用同一 reasonCode 报禁用。
- 不设置 `snapshot.writerConflict`：那条文案语义是「被别的窗口/进程占用」，与子代理
  只读不符。UI 只读由 side pane 的 `readOnly` prop + 命令层 deny 双层保证。
- 子线程不进任务列表：`store.list()` 现有 `sourceKinds: ["cli","vscode","exec",
"appServer"]` 已排除 `subAgent*`；`session/subagents` 是唯一按父查询子线程的入口。

## 已知边界与降级

- **resume 未加载线程会改写子线程 rollout**：实测（codex-cli 0.160.1，真实已结束父子线程）
  `thread/read` 与 `thread/turns/list` 不改盘；对 `notLoaded` 子线程首次 `thread/resume`
  会重写其 rollout 文件，并把 `thread.updatedAt` 顶到当前时间（同一进程内对已加载线程再次
  resume 不改盘）。`updatedAt` 正是 `session/subagents` 的 `endedAt` 来源，因此「打开子会话」
  会把已结束子代理的结束时间刷成打开时刻、并打乱按 `endedAt` 的倒序。规避方式就是上面的
  `notLoaded` 跳过 resume；`recencyAt` 不是结束时间（≈ 创建时间），不能替代。
- ephemeral 子线程无 rollout：`thread/read` 报 not materialized，卡片仍可点，
  side pane 走既有错误态，不造占位内容。
- 冷启（父线程未加载）：子线程通常是 `notLoaded` → 只读历史快照，不订阅；父线程后续
  activity 触发父快照重投影。父线程之后若再驱动该子线程，原生会把它加载进本进程，
  未 attach 的条目在 subscribe/resync 时被 `invalidate` 重载，那时状态已是 `idle`/`active`，
  再走 resume 订阅（自愈路径）。
- 名称与类型：父线程 collab item 经 API 投影后**不含** `receiverAgents`（rollout 里有，
  `thread/turns/list` 剥掉了），所以时间线行的 `subagentType` 只能是 `subagent` fallback、
  标题走 spawn prompt 首个非空行；真实 `agentNickname`/`agentRole` 只有 `thread/list` /
  `thread/read` 的子线程元数据上有，因此只在 `session/subagents` 目录与 side pane tab 出现。
- 子代理严格只读：Codex V2 子线程不接受客户端直接输入，因此不提供发送/停止/重试/编辑。
- 运行中判定：`snapshot.subagents.running` 以父线程事实为准，再按上表「running 收敛」的
  子线程活性观测把已结束的 child 从 running 里去掉（避免中断会话永久滞留「运行中」）。
  活性观测优先取已加载子线程的原生 `status`；未加载时取 bridge 记录的 turn/status 事件或
  一次性 `thread/list` 种子；都没有（无观测）时保持父侧事实不变。已加载缓存状态可能滞后于
  「父线程重新驱动该子代理」的时刻；未 attach 的只读条目在下一次 subscribe/resync 会被
  invalidate 并重判，因此滞后窗口只存在于子面板持续打开且未 resync 期间。子代理被
  `send_input`/`resume` 重新驱动时，子线程 `turn/started` 会把活性观测翻回 active，
  running 随之恢复——与原生「resume 即重新计时」同一语义。
- 分享投影：`subagent` 行按既有规则被公开载荷过滤；存在 running 子代理时按既有规则
  拒绝分享。

## UI 合同

- `SUBAGENT_TOOL_NAMES` 必须包含 codex 的 `spawn_agent`（`COLLAB_TOOL_NAMES.spawnAgent`），
  否则 `pairSubagentRows` 配不上对：卡片没有入口，且 subagent 行会作为独立行重复渲染。
- `send_input`/`resume_agent`/`wait_agent`/`close_agent` 等后续交互工具不进入该集合：
  同一 child 只允许一张可点卡片。

## Acceptance

- bridge 单测：行投影（含并发两个 child 交错 activity 不串号）、只有 activity 的历史、
  `snapshot.subagents` 与 revision 语义、子线程只读加载三条路径（attach 成功 / resume
  被拒降级 / cwd 不同）、`notLoaded` 跳过 resume 与 `idle` 仍订阅、deny guard 的
  reasonCode、`session/subagents` 分页与分类、`session/list` 不含子线程。
- UI 单测：`spawn_agent` 行 + subagent 行恰好产出一个 `agentToolCall` 渲染项且 subagent
  行不重复渲染；有无 `childSessionId` 时 side pane 入口 testid 的出现与缺席。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿。
