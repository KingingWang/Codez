# Issue 23：远端需更新时的恢复入口

## Feature Summary

| Field            | Value                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 修复已绑定 Source 冷启动/恢复进入 `needs-upgrade` 后没有主动提示、项目入口只能跳设置的问题                                                     |
| Capability       | Source Server 兼容门与受保护更新                                                                                                               |
| Change layer     | `presentation`、`validation`、`commit-effect`、`recovery`                                                                                      |
| Operating mode   | `planning`                                                                                                                                     |
| Primary seeds    | `SourceServerConnectionManager`、`createSourceServerUpdateNotificationController`、`RemoteIdentityHoverCard`、`requestRemoteProjectConnection` |
| Out of scope     | 不改变静默更新授权、running-task guard、同版本 archive 漂移的 required 定级、手机远控                                                          |

## UI Surface Matrix

| User scenario          | UI entry                       | Shared implementation                                   | Display/draft owner | Default/inherit source          | Validation/gating                                                      | Commit action                                               | Authority/persistence              | Mode boundary                | Must remain isolated from       |
| ---------------------- | ------------------------------ | ------------------------------------------------------- | ------------------- | ------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- | ---------------------------- | ------------------------------- |
| 冷启动已绑定设备需更新 | Host 启动重连 + 全局更新 Toast | `reconnectOnStartup`、`sourceServerUpdateNotifications` | Host / Toast        | Host 管理快照与 release SHA     | 已绑定 ID、`upgradeTarget:server` 先自动 `force:false`；guard 后弹提示 | 自动 `updateServer(force:false)`；guard 后 Toast 确认       | Host Manager；同版本漂移仅会话去重 | Desktop                      | 未绑定 Profile、可选更新、手机  |
| 从离线项目处理更新     | 项目行点击与悬停详情           | `requestRemoteProjectConnection`、远程连接向导          | 项目 Host 投影      | Host 连接状态与 `upgradeTarget` | 仅 Desktop、`needs-upgrade`、`upgradeTarget:server`、保留的项目根目录  | 原项目显式重连意图 → 向导接管 → `updateSource(force:false)` | Host Manager；向导仅持有本次意图   | Desktop；菜单/Web 无管理动作 | 更换后的目标、其他项目和 Source |
| 管理设备               | 设置 › 远程设备                | `runSourceServerUpdate`                                 | 管理快照            | Host 状态/目录                  | 设备卡当前状态                                                         | `updateSource(force:false)`；guard 后确认                   | Host Manager                       | Desktop                      | 项目与 Task 正文                |
| 用户主动连接           | 连接向导                       | `resumeRequiredServerUpdate`                            | 向导当前目标/意图   | Host 最新快照                   | `expectedTarget` 与本次失败目标一致                                    | `updateSource(force:false)`；guard 后确认并继续连接         | Host Manager                       | Desktop                      | 后台重连的静默授权              |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces             | Deliberately different             | Why it matters for this change             |
| -------------------- | ---------------------------------- | ---------------------------------- | ------------------------------------------ |
| UI/component         | 各入口使用同一 Host 升级状态       | Toast、项目详情、设备卡展示不同    | 不增加第二份升级事实                       |
| Option source        | `upgradeTarget` 来自 Host          | 桌面端过旧只导向桌面更新           | 项目入口不能误执行远端更新                 |
| Default/inheritance  | 已绑定 `sourceServerId` 是设备身份 | 未绑定 Profile 交由向导            | Host 快照必须保留绑定 ID，Toast 才有去重键 |
| Validation           | 更新先受 `force:false` guard       | 后台只提示；显式连接由向导自动编排 | 不静默中断远端 Task                        |
| Commit effect        | 最终都由 `updateSource` 提交       | 项目入口先交给原项目连接意图       | 更新后继续原项目，而非仅打开设置           |
| Persistence/recovery | Host Manager 为连接状态权威        | UI Toast 偏好仅用于去重            | 去重不能成为项目操作的门禁                 |

## Feature Relationships

| Rank           | From         | Semantic edge             | To                                 | Condition          | Why inspect it                       | Evidence                                                                   |
| -------------- | ------------ | ------------------------- | ---------------------------------- | ------------------ | ------------------------------------ | -------------------------------------------------------------------------- |
| must-inspect   | Manager 状态 | projects-to               | 更新 Toast、设备卡、项目 Host 投影 | 已绑定 Source      | 缺 `sourceServerId` 会吞掉 Toast     | `sourceServerConnectionManager.ts`、`sourceServerUpdateNotifications.ts`   |
| must-inspect   | 项目详情     | commits-through           | 原项目重连/向导                    | Desktop 待远端升级 | 保留本次目录、target 与 guard        | `ProjectSidebarNode.tsx`、`requestRemoteProjectConnection.ts`              |
| should-inspect | 向导         | commits-to                | `updateSource`                     | 显式用户意图       | 使用现有 `expectedTarget` 和恢复时序 | `remote-connection-flow/index.ts`                                          |
| invariant-only | Source 管理  | must-remain-isolated-from | 手机 replayable/远端 Task owner    | 全部               | 不新建 Host 或 Agent                 | R3 Source Server 架构 §6.3                                                 |
| evidence-only  | 测试         | covered-by                | 状态与入口                         | SSH 代表路径       | Host、UI、E2E 分层取证               | `sourceServerConnectionManager.test.ts`、`remoteIdentityHoverCard.test.ts` |

## State Owners And Commit Sinks

| State/fact                  | Draft/display owner  | Authoritative owner        | Commit command/service                       | Persistence/cache                  | Evidence                           |
| --------------------------- | -------------------- | -------------------------- | -------------------------------------------- | ---------------------------------- | ---------------------------------- |
| 兼容判定、绑定 ID、更新进度 | UI 只读投影          | window-scoped Host Manager | `SourceServerManagementService.updateSource` | 目录保存 Profile；运行状态不持久化 | `sourceServerConnectionManager.ts` |
| 原项目连接意图              | 向导本次 entry epoch | Root 远程连接 controller   | `reconnect-workspace`                        | 原项目/目录身份保持                | `useRemoteWorkspaceHistory.ts`     |
| Toast 去重                  | Renderer             | Renderer UI 偏好           | 无业务提交                                   | 版本化本地偏好                     | `sourceServerUpdatePreferences.ts` |

## Must-Preserve Invariants

| Invariant                                 | Surfaces/modes         | Proof needed                   | Evidence                                    |
| ----------------------------------------- | ---------------------- | ------------------------------ | ------------------------------------------- |
| 后台不静默更新，`force:true` 只由用户确认 | 冷启动、断线、项目入口 | Host 更新次数与参数            | R3 §6.3、`sourceServerUpdateAction.test.ts` |
| `upgradeTarget:controller` 不执行远端更新 | Toast、项目详情        | 入口回归                       | `remoteIdentityHoverCard.test.ts`           |
| 新目标不能借旧项目升级                    | 向导、Host             | `expectedTarget` 与 epoch 回归 | `remoteConnectionFlowRecovery.test.ts`      |
| 手机只复用现有 attachment                 | mobile replayable      | 不新增管理调用                 | R3 §6.3                                     |

## Codegraph Evidence

当前环境未提供 codegraph 查询入口；以代码符号索引、直接调用位置和目标测试作有界替代，不把静态可达当成产品依赖。

| Seed                             | Query                     | Direct callers / key path                   | Depth | Interpretation                      |
| -------------------------------- | ------------------------- | ------------------------------------------- | ----- | ----------------------------------- |
| `SourceServerConnectionManager`  | symbol + exact references | Host `index.ts`、管理服务                   | 2     | Host 发布兼容状态                   |
| `RemoteIdentityHoverCard`        | exact references          | `ProjectNodeContent`、`ProjectComposerMenu` | 2     | 项目侧栏可操作；Composer 菜单仍只读 |
| `requestRemoteProjectConnection` | exact references          | `useRemoteWorkspaceHistory`、向导           | 2     | 已有显式升级和原项目恢复路径        |

## Graph Drift Candidates

| Candidate          | Live-code evidence                          | Missing/stale graph relation                               | Proposed follow-up                 |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| 项目详情待处理入口 | 修复前 `RemoteIdentityHoverCard` 只跳设置   | `surface.remote-source-task-sidebar` 只声明 Toast 更新动作 | 已增加项目详情的显式连接/更新 edge |
| 全图历史漂移       | 全图校验仍有与本议题无关的悬空边和缺失 seed | 目标新增 seed 均存在                                       | 不在 Issue 23 中修复其他领域的图谱 |

## Graph Delta

| Status    | Node/edge                              | Semantic reason                 | Evidence               | Action               |
| --------- | -------------------------------------- | ------------------------------- | ---------------------- | -------------------- |
| confirmed | 项目详情 → 原项目连接向导 → 受保护更新 | 同一 Host owner、复用原连接意图 | R3 §6.3、项目导航 spec | 已更新 feature graph |

## Unresolved Questions

| Question                                      | Candidate answers                         | Scope difference                                                                                                 | Owner              |
| --------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------ |
| 同版本重新出包是否将 SHA 漂移降为非阻断       | required / available / build identity     | 会改变兼容门与发布身份合同；本次保留已有 required 判定                                                           | 后续产品与发布设计 |
| 同设备同版本新升级事件是否重置持久 Toast 去重 | 同版本漂移会话内去重 + 上线清理（已采纳） | 在 `sourceServerUpdateNotifications` 中对 `currentVersion === availableVersion` 仅会话内去重并在上线时清理持久键 | 已实现             |

## Planning Handoff

| Item             | Destination                      | Status                 |
| ---------------- | -------------------------------- | ---------------------- |
| Spec update      | R3 §6.3、项目导航 spec           | complete               |
| Case catalog     | RDUX-SIDEBAR-PENDING、RDUX-13-04 | complete               |
| Coverage matrix  | 对应 RDUX 行                     | complete               |
| Decision backlog | 同版本 archive 漂移              | 本次不改               |
| E2E handoff      | 已有 pending SSH case            | 更新步骤与断言，不转正 |

## Boundary Decisions

| Boundary | Decision                             | Includes                                  | Excludes / prunes                   | Source                                  |
| -------- | ------------------------------------ | ----------------------------------------- | ----------------------------------- | --------------------------------------- |
| 后台恢复 | 已绑定设备启动重连自动受保护更新一次 | `force:false`；guard 停在待升级并弹 Toast | 不静默 `force:true`、未绑定不自动更 | R3 §6.3                                 |
| 项目入口 | 点击待升级项目行或详情交给原项目向导 | `force:false`、成功继续原目录             | 空操作或只跳设置页                  | R3 §6.3、项目导航                       |
| 版本判定 | 本次保留同版本 SHA 漂移阻断          | 保持当前回归保护                          | 无依据地放行可能缺 API 的旧构建     | `sourceServerConnectionManager.test.ts` |

## Candidate Combinations And Accepted Cases

| Case ID              | Setup                                        | Action                 | Assertions                                                            | Evidence layers | E2E status           |
| -------------------- | -------------------------------------------- | ---------------------- | --------------------------------------------------------------------- | --------------- | -------------------- |
| RDUX-23-01           | 已绑定 SSH、旧版或同版本 SHA 漂移            | 冷启动/后台重连        | `needs-upgrade` 快照保留绑定 ID；Toast 有一次「立即更新」；不自动更新 | Host + UI       | 单测                 |
| RDUX-SIDEBAR-PENDING | 已绑定 SSH 项目，状态 `needs-upgrade/server` | 点项目详情「更新远端」 | 向导执行一次受保护更新，成功后继续原项目                              | UI + Host + SSH | 更新现有 pending E2E |
| RDUX-23-02           | 同上，远端 Task running                      | 项目入口更新           | 首次 `force:false`；仅确认后可 `force:true`                           | UI + Host       | 复用向导回归         |
| RDUX-23-03           | `upgradeTarget:controller` 或无项目根目录    | 点项目详情             | 只导航合适处理入口，不执行远端更新                                    | UI              | 单测                 |

不枚举 SSH/WSL/Docker × 全主题 × 手机：Host 状态字段与向导动作共用合同；真实 SSH 覆盖完整链路，WSL/Docker 与手机的隔离由现有回归验证。
