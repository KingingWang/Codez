# 同版本构建方向与多 Desktop 共存 Impact Brief

## Feature Summary

| Field            | Value                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 修复版本号不变、每次 commit 重新出包时，旧 Desktop 自动覆盖新远端并踢掉其他客户端                                                                                   |
| Capability       | Source Server 构建身份、兼容判定与受保护更新                                                                                                                        |
| Change layer     | validation、commit-effect、persistence、recovery                                                                                                                    |
| Operating mode   | planning                                                                                                                                                            |
| Primary seeds    | `SourceServerConnectionManager`、`resolveSourceServerReleaseAsset`、`probeSourceServer`、`runLocalArchiveUpdateCommand`、`collectSourceServerRemoteReleaseArchives` |
| Out of scope     | 不放宽 `minCompatibleVersion`；不改变 RPC 合同、running-task guard、Desktop continuous 或 Mobile replayable                                                         |

## UI Surface Matrix

| User scenario                    | UI entry                   | Shared implementation         | Display/draft owner | Validation/gating                            | Commit action              | Authority/persistence            | Mode boundary                   | Must remain isolated from      |
| -------------------------------- | -------------------------- | ----------------------------- | ------------------- | -------------------------------------------- | -------------------------- | -------------------------------- | ------------------------------- | ------------------------------ |
| 新 commit Desktop 连接旧构建远端 | 连接向导、启动重连、设备卡 | Host Manager + `updateSource` | Host 快照           | 同版本且本地 commit 较新；先 `force:false`   | 受保护更新并重新握手       | 远端 CLI、`current.json`         | Desktop；手机仅复用 attachment  | 运行中任务不得被静默中断       |
| 旧 commit Desktop 连接新构建远端 | 原项目连接、启动重连       | Host Manager + 既有握手       | Host 快照           | 同版本且本地 commit 较旧；RPC 合同仍须通过   | 直接复用，不调用更新       | 远端 daemon 保持原 release       | Desktop/Mobile 各自现有交付语义 | 不重启远端、不踢掉其他 Desktop |
| 构建方向未知                     | 同上                       | Host Manager                  | Host 快照           | 同版本 SHA 不同但无法定序                    | 仅投影可选更新，不自动更新 | 原 release 不变                  | 同上                            | 不把未知方向当成升级授权       |
| 显式切回同版本旧构建             | 更新命令及管理入口         | 远端 Server CLI               | CLI 操作结果        | target commit 较旧时必须 `--allow-downgrade` | 原子切换并写降级标记       | `current.json`、`downgrade.json` | 与传输方式无关                  | 不用 probe 的旧结果预判方向    |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces                                            | Deliberately different                           | Why it matters for this change     |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------- |
| UI/component         | 所有入口只消费 Host 快照                                          | 旧构建复用后是在线可选更新，新构建才进入必选更新 | 避免 UI 自己比较 SHA 或时间        |
| Option source        | descriptor、archive manifest、`current.json` 使用同一 commit 身份 | 开发态仍以本地 worktree 内容为权威               | CI 不同 job 的打包时钟不能决定新旧 |
| Validation           | 版本兼容与 RPC 握手保持原门禁                                     | 同版本构建方向只决定更新策略                     | 协议不兼容仍阻断连接               |
| Commit effect        | 更新统一经过 `updateSource/updateServer` 和 CLI                   | 旧构建、未知方向不提交更新                       | 防止后连者无条件覆盖               |
| Persistence/recovery | release 原子切换与 attachment 换代不变                            | 复用路径没有 release 换代                        | 不重放任务输入、不改变重连语义     |

## Feature Relationships

| Rank           | From                    | Semantic edge             | To                                   | Condition          | Why inspect it                     | Evidence                              |
| -------------- | ----------------------- | ------------------------- | ------------------------------------ | ------------------ | ---------------------------------- | ------------------------------------- |
| must-inspect   | staging                 | persists-to               | descriptor + archive `manifest.json` | 每次出包           | 两端必须读取同一 commit 身份       | `stageRemoteAssetsCli.ts`、`stage.ts` |
| must-inspect   | probe                   | reads                     | `current.json` build identity        | 已安装远端         | Host 需要比较方向                  | `sourceServerProbe.ts`                |
| must-inspect   | Host drift decision     | commits-through           | `updateServer`                       | 仅本地较新或开发态 | 保留唯一更新编排与 guard           | `sourceServerConnectionManager.ts`    |
| must-inspect   | CLI update lock         | validates-with            | 真实 current/target build            | 同版本 SHA 不同    | 防止过期 probe 授权降级            | `updateCommand.ts`                    |
| should-inspect | Desktop cache           | persists-to               | version + commit 目录                | 同版本多次出包     | 防止离线读取上一 commit descriptor | `sourceServerReleaseResolver.ts`      |
| invariant-only | RPC handshake           | must-remain-isolated-from | build timestamp                      | 全部               | 构建方向不是协议兼容证据           | R3 §6.2、§8                           |
| invariant-only | Desktop/Mobile delivery | must-remain-isolated-from | release direction                    | 全部               | 不改变 continuous/replayable 恢复  | R3 §7                                 |

## State Owners And Commit Sinks

| State/fact              | Draft/display owner | Authoritative owner              | Commit command/service     | Persistence/cache            | Evidence            |
| ----------------------- | ------------------- | -------------------------------- | -------------------------- | ---------------------------- | ------------------- |
| commit SHA/timestamp    | 无                  | 本次 Git commit，经 staging 固化 | `stage:remote-assets`      | descriptor、archive manifest | 工程回归            |
| 已安装构建身份          | 无                  | 远端 CLI                         | `update --from-archive`    | `current.json`               | CLI/probe 回归      |
| 连接与可选/必选更新状态 | Renderer 只读       | window Host Manager              | `connect` / `updateServer` | 不持久化运行态               | 既有 fork Host 回归 |
| 是否允许降级            | 无自动授权          | 远端 CLI 持锁裁决                | `--allow-downgrade`        | `downgrade.json`             | CLI 工程回归        |

## Must-Preserve Invariants

| Invariant                    | Surfaces/modes     | Proof needed                    | Evidence     |
| ---------------------------- | ------------------ | ------------------------------- | ------------ |
| 同 SHA 不更新                | 全部               | probe 后直接 daemon/握手        | Host 回归    |
| 仅本地较新的生产构建自动升级 | 手动连接、启动重连 | `force:false` 与 guard 不变     | Host 回归    |
| 本地较旧或方向未知不自动覆盖 | 全部               | 无 install 调用、原 daemon 复用 | Host 回归    |
| 开发态 SHA 不同仍必须刷新    | 未打包 SSH         | 保持 `needs-upgrade`            | Host 回归    |
| 同版本旧构建切换需显式确认   | Server CLI         | 未授权失败且删除 pending        | CLI 工程回归 |

## Codegraph Evidence

当前环境未提供 codegraph 查询入口；以现有语义图 seeds、直接调用位置和精确测试作有界替代，深度为 2。

| Seed                              | Query               | Direct callers / key path             | Depth | Interpretation                                |
| --------------------------------- | ------------------- | ------------------------------------- | ----- | --------------------------------------------- |
| `SourceServerConnectionManager`   | symbol + references | Host、ManagementService、启动重连     | 2     | 唯一连接/更新状态 owner                       |
| `resolveSourceServerReleaseAsset` | callers             | Manager probe/update release resolver | 2     | descriptor 到 `ServerReleaseAsset` 的唯一边界 |
| `runLocalArchiveUpdateCommand`    | callers             | Server CLI update command             | 1     | 真实 current 的最终降级裁决                   |

## Graph Drift Candidates

| Candidate                      | Live-code evidence                | Missing/stale graph relation     | Proposed follow-up                        |
| ------------------------------ | --------------------------------- | -------------------------------- | ----------------------------------------- |
| 同版本构建方向未进入兼容能力图 | 现有图只登记环境兼容和更新 action | 缺构建身份持久化与方向判定 seeds | 本轮补充到既有 capability，不新建平行能力 |

## Graph Delta

| Status    | Node/edge                                                                    | Semantic reason      | Evidence          | Action       |
| --------- | ---------------------------------------------------------------------------- | -------------------- | ----------------- | ------------ |
| confirmed | `capability.remote-environment-compatibility` 增加 build identity docs/seeds | 用户已确认方向化设计 | 本轮对话、R3 spec | 更新既有节点 |

## Unresolved Questions

| Question | Candidate answers                                      | Scope difference | Owner  |
| -------- | ------------------------------------------------------ | ---------------- | ------ |
| none     | 用户已选择「新构建自动升级、旧构建复用、显式降级保护」 | 无               | 已完成 |

## Planning Handoff

| Item             | Destination                                              | Status     |
| ---------------- | -------------------------------------------------------- | ---------- |
| Spec update      | R3 §5.3、§6.3、§7.1                                      | complete   |
| Case catalog     | RDUX-16、SSH-GUIDE-VERSION                               | complete   |
| Coverage matrix  | 对应远程版本行                                           | complete   |
| Decision backlog | 无                                                       | complete   |
| E2E handoff      | 复用既有 pending version-policy；本轮不新增正式 E2E 准入 | not-needed |

## Boundary Decisions

| Boundary       | Decision                                         | Includes                | Excludes / prunes                   | Source                    |
| -------------- | ------------------------------------------------ | ----------------------- | ----------------------------------- | ------------------------- |
| 构建顺序       | Git commit timestamp；同 commit 不借字典序猜新旧 | 全 SHA、秒级 timestamp  | 不用本机打包时间                    | 用户确认 + CI 多 job 事实 |
| 生产同版本漂移 | 新构建必选更新；旧构建复用；未知方向可选更新     | SSH/WSL/Docker 生产连接 | 不把 SHA 不同直接等同于 server 过旧 | 用户确认                  |
| 开发同版本漂移 | 保持 content-addressed 必选刷新                  | 未打包 SSH              | 不扩散到生产/WSL/Docker             | 既有 R3 合同              |
| 协议兼容       | 仍由 compatibility manifest 和 RPC 握手决定      | 旧构建复用也必须通过    | timestamp 不充当兼容证明            | R3 §6                     |

## Accepted Cases

| Case ID          | Setup                                            | Action                           | Assertions                             | Evidence layers | E2E status                              |
| ---------------- | ------------------------------------------------ | -------------------------------- | -------------------------------------- | --------------- | --------------------------------------- |
| RDUX-16-BUILD-01 | 同版本，本地 commit 较新、SHA 不同               | 手动连接或启动重连               | 走既有 `force:false` 更新；guard 不变  | Host + CLI      | 复用 pending version-policy             |
| RDUX-16-BUILD-02 | 同版本，本地 commit 较旧、远端已较新             | 手动连接或启动重连               | 不安装、不重启；握手成功；在线可选更新 | Host + protocol | 复用 pending version-policy，未新增实跑 |
| RDUX-16-BUILD-03 | 同版本，build identity 缺失或同时间戳不同 commit | 连接                             | 不自动安装；原 release 保持            | Host + files    | 回归测试                                |
| RDUX-16-BUILD-04 | 同版本，CLI target commit 较旧                   | 不带/带 `--allow-downgrade` 更新 | 前者拒绝并清理 pending；后者才允许切换 | CLI + files     | 工程回归                                |

剪枝：不枚举 transport × 手机 × 全版本矩阵。方向判断位于 transport 之上的 Host 和 CLI；手机不发起管理更新。未执行真实双 Desktop GUI 时不得宣称该层已覆盖。
