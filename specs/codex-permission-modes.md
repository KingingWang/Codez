# Codex permission modes

## Outcome

Codex 会话的 composer 权限档位与 Codex 原生权限预设一一对应；每一档的标签、小字说明与实际下发到原生的参数一致。用户选择的档位是 UI 草稿事实，原生线程是生效权限的唯一所有者，bridge 投影负责把两者对齐；任何档位都不允许"标签显示 A、线程实际是 B"的静默错位。

## 档位定义（Codex 会话专属）

Plan 保持独立勾选维度（`planEnabled` → `collaborationMode`），与权限档位正交，可组合。

| 档位 id  | 标签                        | 下发到原生（turn/start / thread/settings/update）                                                                                                                  |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build`  | 请求批准 / Ask for approval | `approvalPolicy:"on-request"` + `approvalsReviewer:"user"` + `sandboxPolicy: workspaceWrite`                                                                       |
| `edit`   | 帮我审批 / Approve for me   | `approvalPolicy:"on-request"` + `approvalsReviewer:"auto_review"` + `sandboxPolicy: workspaceWrite`                                                                |
| `yolo`   | 完全访问 / Full access      | `approvalPolicy:"never"` + `approvalsReviewer:"user"` + `sandboxPolicy: dangerFullAccess`                                                                          |
| `custom` | 自定义 / Custom             | 不下发权限覆盖，跟随 config.toml；仅当线程当前处于放宽态（`dangerFullAccess` 沙箱、`approvalPolicy=never` 或 `auto_review` 审批人）时，显式恢复 config.toml 生效值 |

非 Codex 的 Codez Agent 运行时保留旧四档（build/edit/plan/yolo）语义，不受本 spec 影响；`custom` 只属于 Codex 链路。

## 状态所有权与事件顺序

- 生效权限的唯一所有者是原生线程；bridge `ThreadStateStore` 持有投影缓存，并额外记住"用户最近一次显式选择的档位"（bridge 进程内存，不落盘、不跨进程）。
- 投影输入必须完整：`thread/start` / `thread/resume` / `thread/fork` 响应在顶层携带 `approvalPolicy` / `approvalsReviewer` / `sandbox`（`Thread` 结构体本身不含权限字段），水合装饰必须合并 `approvalsReviewer`（丢失会把 edit 线程误投影为 custom，切 custom 时漏发恢复覆盖）；`thread/settings/updated` 事件同步更新 `approvalsReviewer`（外部 CLI/另一窗口的变更不能被投影吞掉）。
- 投影规则（snapshot `config.mode` 与 queue 守卫共用同一推导）：
  1. 本进程记住的显式档位优先；
  2. 否则按线程生效值推导：仅当 `sandboxPolicy.type === "dangerFullAccess" && approvalPolicy === "never" && approvalsReviewer !== "auto_review"` 时推导为 `yolo`（若 `config.toml` 只配了 `danger-full-access` 而 `approvalPolicy` 仍为 `on-request` 等非 `never` 值，不属于完整 `yolo`，不得误投影为 `yolo`，否则既让 UI 标签与实际弹窗行为错位，又会导致用户显式选 `yolo` 时被 `mode !== projectThreadMode(thread)` 判定为无迁移而漏发 `approvalPolicy:"never"`）；`approvalsReviewer=auto_review → edit`；其余 → `custom`（无显式选择即跟随原生，与旧 build "保留原生权限"行为等价）。
- queue/steer 守卫的档位维度按"是否携带覆盖意图"判定：`custom` 不请求权限覆盖（queue/steer 从不应用设置），与 `custom` 及推导出的放宽档（`yolo`/`edit`）投影兼容——bridge 重启后 remembered 档丢失会把"跟随 config.toml"的持久化草稿误判为覆盖意图，导致 busy 引导/排队被永久拒绝。`build` 投影只来自本进程记住的显式收紧，`custom` 草稿与之是真实分歧，仍拒绝。UI 的 `codexSubmissionMatchesThread` 与 bridge 的 `assertUnchangedInputSettings` 必须保持同一条规则。
- 档位切换只编辑草稿，随下一次 startNow 提交经 `turn/start` 生效；busy/queue 场景维持既有守卫（per-input 设置变更拒绝 + UI toast）。
- `custom → 放宽态恢复`：bridge 读取 `config/read` 的 `sandbox_mode` / `approval_policy` / `approvals_reviewer` 显式下发；读取失败或值为 granular 等不可映射形态时，回退 `workspaceWrite + on-request + user` 基线。恢复动作必须复位 `approvalsReviewer`，不允许只改沙箱留下 AI 代批。

## 能力探测与降级

- bridge `runtime/capabilities` 新增 `autoReviewApprovals`：探测原生 `guardian_approval` feature（`experimentalFeature/list`）与 `configRequirements/read` 的 `requirements.allowedApprovalsReviewers`（wire 为 camelCase；来源配置项即 `allowed_approvals_reviewers`，旧别名 `guardian_subagent` 与 `auto_review` 等价对待）；两者均允许才 `supported`，否则 `unsupported`。探测结果（含失败）按 bridge 进程缓存，进程重启后重新探测；UI 侧在 runtime 重启 / transport 替换后重新 hello，刷新期间按不可用处理（fail-closed）。
- 桌面端与手机扫码远控（`web-remote-replayable`）连接 Codex Host 时均读取同一份 `hello.capabilities`：对端确认为 Codex bridge（`useCodexNativeHost`）后，composer 开启 Codex 四档权限菜单（含 `custom`），并复用同一 `autoReviewApprovals` 门控与忙碌期队列/引导配置守卫。
- 能力非 `supported` 时，composer 隐藏 `edit` 档；已持久化的 `edit` 草稿在 Codex scope 归一化为 `custom`。
- 旧 peer 缺省该能力字段时按 `unsupported` 解析（协议字段为 optional，UI 投影缺省即隐藏）。

## 默认值与迁移边界

- Codex 会话新任务草稿默认档为 `custom`（不静默覆盖用户 config.toml）。
- 手机扫码远控在 Codex Host 下没有桌面本地 `codexCatalog`，模型与档位候选经 `IModelSelectionService`（`createCodexModelSelectionService`）读取；其权限档初始化、存量 `build` 代际归一、`edit` 能力门控与提交冻结同样走 Codex 规则（新任务默认 `custom`，已有会话保留 `sessionConfig.mode` / `planEnabled` 并从 `sessionConfig` 补齐 `modelSelection`）。
- 同一会话跨端配置同步（方案一）：对于已绑定的 Codex 会话（`sessionId !== null`），当另一端（桌面端或手机端）提交消息或更新线程配置使权威 `snapshot.config`（`mode`、`planEnabled`、`provider`、`model`、`thought`）相对于当前端上次观测到的有效线程配置发生变化时，当前端同步将该变化合并进本地会话草稿（保留未发送文本与本地编辑内容），避免桌面端与手机端交替发消息时配置脱节或因设置不一致触发 busy queue/guide 拒绝；若 `snapshot.config` 未发生变化，用户在本端未发送的菜单选择不会被重复快照覆盖。
- 存量持久化草稿：`yolo` 保留（语义不变）；升级前写入的 `build`（草稿缺少 `permissionModeGen:2` 代际标记）在展示与提交层归一为 `custom`——旧 build 语义（保留原生权限）与新 custom 等价，直接下发 build 会被 bridge 当成显式迁移而静默改写线程权限；新版本下用户显式选择的 `build` 写入代际标记，原样保留。`edit` 在能力可用时自然获得 Approve for me 语义，不可用时按上节归一化。
- `custom` 只属于 Codex 链路：残留草稿落到非 Codex 链路时 UI 展示/提交归一为 `build`，Codez Agent CLI admission（`resolveSubmittedExecutionState` / `switchCollaborationMode`）对 `custom` 显式拒绝（failed ACK），不允许静默降档。
- `submissionModeSchema` 增加 `custom`；`codezSessionModeSchema` 增加 `custom`（additive，旧运行时不产生该值，`normalizeAvailableCodezMode` 对未知值仍回退 build）。
- bridge 不再拒绝 `edit`；`turnMode` 的 `edit → unsupported` 与 `createNativeSession` 的 edit 拒绝同步移除。

## 失败语义

- `edit` 下发后原生拒绝（组织策略运行时收紧）：命令失败原样上浮为 composer 错误，不重试、不静默降档。
- 能力探测失败：按 `unsupported` fail-closed（隐藏），不猜测可用。
- `custom` 恢复时 `config/read` 失败：使用回退基线并在 bridge 日志记录 warn，不阻断提交。

## 自动审批过程与结论投影（Approve for me）

- **状态所有权**：原生 Codex `item/autoApprovalReview/started`、`item/autoApprovalReview/completed` 与 `autoApprovalReview/strictReviewRequired` 通知由 bridge `ThreadStateStore` 按 `(turnId, reviewId)` 增量维护在 `ThreadProjectionState.autoApprovalReviews` 中；不进入人工 `InteractionBroker` / `pendingInteractions`，不触发人工 `PermissionDialog` 或侧边栏待确认红点。
- **事件顺序与收敛**：
  1. `item/autoApprovalReview/started` 建立或更新 `inProgress` 状态（携带 `targetItemId`、`action`、`review`）；若同 turn 收到 `autoApprovalReview/strictReviewRequired`，为当前 `inProgress` 的自动审批标记 `strictReviewRequired: true`。
  2. `item/autoApprovalReview/completed` 将对应 `reviewId` 收敛为终态（`approved` / `denied` / `timedOut` / `aborted`），保留 `riskLevel`、`userAuthorization`、`rationale` 与起止时间戳；迟到的 `started` 不覆盖已终态条目。
  3. 当 `turn/completed`（状态为 `interrupted` 或 `failed`）到达时，该 turn 内仍处于 `inProgress` 的自动审批条目自动收敛为 `aborted`。
- **行级挂载与时间线兜底**：
  - 若审查携带 `targetItemId`、同 turn 内存在匹配 `item.id` 的工具行且 `action.type !== "writeStdin"`，优先投影到该 `ToolCallRow.autoApprovalReview`（保留 `approved` 痕迹及 `denied`/`timedOut`/`aborted` 的风险等级与 `rationale`；当工具因自动审批被拒或超时失败且无更具体错误消息时，同步补齐 `row.error.message`）。
  - 若审查无 `targetItemId`（如 `networkAccess`）、属于子级 `writeStdin` 审查、或目标 item 尚未出现在 `turn.items`，在对应 turn 内投影独立的 `timelineMarker`（`codexEvent/autoApprovalReview`）；一旦后续同 turn 目标工具行出现，自动收拢到该工具行，避免重复展示。
- **跨端一致性**：`desktop-continuous` 与 `web-remote-replayable` 共用同一份 `ConversationSnapshot` 行投影与 wire 保留策略，确保桌面实时流、手机扫码远控与 resync 恢复观察到一致的自动审批状态。

## UI 约束

- Codex 会话档位菜单顺序对齐原生：请求批准 → 帮我审批 → 完全访问 → 自定义；Plan 勾选框保持在菜单顶部独立区域。
- 完全访问首次选择需确认弹窗（一次性，持久化确认状态），沿用现有 warning 配色。
- 档位标签与说明使用 per-runtime i18n 键（`mode.codex.*`），不复用 glm/codez 文案。
