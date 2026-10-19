# Impact Brief: Codex 项目目录视图与原生多目录

## Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 新建单目录项目能发现全部同目录 Codex 历史；多目录项目只显示明确归属且 native 可用全部 roots |
| Capability | `capability.codex-project-session-visibility` |
| Change layer | option-source、commit-effect、persistence、recovery |
| Operating mode | planning |
| Primary seeds | `useCodexProjectDiscovery`、`selectProjectRows`、`admitTaskIdentity`、`createNativeSession`、`attachThreadForLoad` |
| Out of scope | 迁移 SQL、CLI `resume` 筛选、远端多目录、Group 成员、项目 native registry 镜像 |

## UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Default/inherit source | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 查看/新建本地项目 | 侧栏项目树 | Host `readTree` / `view.ts` | sidebar 项目展开偏好 | 项目 roots + Host task rows | 同 Host、单 root 的 cwd 视图；多 root 归属 | project save → native scoped discovery；新建会话 Host 校验后 native start | Host 项目/组织态、Codex 会话事实 | Desktop 和手机同 Host，远端仍显式归属 | 不改历史 `project_id`/cwd/正文 |
| 从目录视图打开任务 | 项目任务行 | 既有任务导航 / V4 subscribe | renderer 当前 tab/pane | taskId 的 Host 归属、当前 roots | identity/lease 与缺项目拒绝 | subscribe / explicit resume | Host SQLite roots → Codex 运行实例 | desktop continuous / mobile replayable | 不根据当前视图缩减外部 native roots |
| 查看归档 / 置顶 / 最近 | archive 筛选、全局分区 | `archive-view.ts`、`view.ts` | 本地筛选 | 同一项目树任务行 | 非删除、归档/置顶状态 | 无 | 同一 Host task 行 | 本地目录投影仅影响选定项目筛选 | 全局只计一次，时间不变 |
| 会话 `#` 提及 / Group | composer 候选、按组视图 | `sessionsMentionProvider`、`useTaskGroups` | renderer 查询/组偏好 | 明确 `project_id` / Group 成员 | 当前 Host 可读 | 无 | Host 组织态 | 所有客户端 | 不因目录视图自动改组或自动复制候选 |

## Shared And Divergent Behavior

项目树、归档、置顶、最近共用 Host 已提交任务行；只有本地单 root 的项目展示和其归档筛选按 cwd 派生视图。多 root、远端、Group 与 `#` 组织分组仍用显式项目身份；同一行可以在两个本地项目下可见，但全局分区不复制行。UI 不负责 Codex roots 校验或首次归属写入。

## Feature Relationships

| Rank | From | Semantic edge | To | Condition | Evidence |
| --- | --- | --- | --- | --- | --- |
| must-inspect | Codex 目录视图 | renders-in | sidebar 项目行 | 本地单 root | `packages/ui/src/project-sidebar/view.ts` |
| must-inspect | Codex 创建来源 | seeds-initial-assignment-through | task-index syncer | 仅 Host 行首次插入 | `packages/services/src/task-facts/index.ts`、`project-storage/legacy-tasks.ts` |
| must-inspect | 项目根目录 | resolves-for-cold-resume | bridge | 明确归属且 runtime 未加载 | `packages/services/src/node.ts`、`packages/codex-bridge/src/thread-load.ts` |
| invariant-only | 目录视图 | must-not-change | remote identity、Group、CLI 历史 | 始终 | 虚拟项目与 adapter spec |

## State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| --- | --- | --- | --- | --- | --- |
| 会话事实、cwd、原生 roots | bridge 投影 | Codex | `thread/start` / `thread/resume` | Codex rollout | native 集成测试 |
| 项目 roots、会话组织归属 | sidebar 投影 | 当前 Host 项目仓库 | `saveProject` / 首次 `admitTaskIdentity` / `moveTask` | `tasks-index.sqlite` | project-storage 合同测试 |
| 单 root 显示成员 | `selectProjectRows` | Host task 行和项目 roots 派生 | 无 | 不落盘 | sidebar 合同测试 |
| 扫描失效 | discovery hook | Host 现有 index subscriber | `session/list` | 无第二份列表缓存 | discovery hook 单测 |

## Must-Preserve Invariants

不从 cwd 写回 `project_id`；已判定 NULL 不重归位；单 root 可见不代表执行权限；热实例不刷新 roots，冷实例按明确归属恢复；外部 native 线程省略 roots 参数；Host identity 隔离不按远端路径合并；全局按 taskId 去重。验证点：单元、原生隔离集成与 pending GUI 场景 VP-CODEX-01..05。

## Codegraph Evidence And Graph Drift

本环境未注册 codegraph 查询工具，使用上述精确文件和 `rg` 直接调用方扫描，限制在 sidebar → Host 项目/任务 → bridge 两层；测试只能作证据，不推断新产品边界。已把确认的 capability、入口、归属和隔离边写回 `.agents/skills/feature-boundary-planner/references/codez-feature-graph.yaml`。新增种子文件与边端点已验证；图中另有 4 条无关的既存悬空边，未借本次变更修正。未确认的新调用方：无；物理路径别名下旧 Host 行与新项目根目录不同写法的归并仍需专项验收，不能以 native 列表的 realpath 测试代替 Host 行验证。

## Planning Handoff

既有用户裁决固定：单目录 A 是所有 `cwd=A` 的视图；多目录 A+B 只收本项目会话。产品规则见 `specs/codex-desktop-adapter.md` 和虚拟项目 spec；accepted 场景、剪枝与证据层见 case catalog VP-CODEX-01..05；覆盖矩阵保持 planned，GUI/manual-review 与真实手机未转正。
