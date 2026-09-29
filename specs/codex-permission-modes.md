# Codex permission modes

## Outcome

Codex 会话的 composer 权限档位与 Codex 原生权限预设一一对应；每一档的标签、小字说明与实际下发到原生的参数一致。用户选择的档位是 UI 草稿事实，原生线程是生效权限的唯一所有者，bridge 投影负责把两者对齐；任何档位都不允许"标签显示 A、线程实际是 B"的静默错位。

## 档位定义（Codex 会话专属）

Plan 保持独立勾选维度（`planEnabled` → `collaborationMode`），与权限档位正交，可组合。

| 档位 id | 标签 | 下发到原生（turn/start / thread/settings/update） |
| --- | --- | --- |
| `build` | 请求批准 / Ask for approval | `approvalPolicy:"on-request"` + `approvalsReviewer:"user"` + `sandboxPolicy: workspaceWrite` |
| `edit` | 帮我审批 / Approve for me | `approvalPolicy:"on-request"` + `approvalsReviewer:"auto_review"` + `sandboxPolicy: workspaceWrite` |
| `yolo` | 完全访问 / Full access | `approvalPolicy:"never"` + `approvalsReviewer:"user"` + `sandboxPolicy: dangerFullAccess` |
| `custom` | 自定义 / Custom | 不下发权限覆盖，跟随 config.toml；仅当线程当前处于放宽态（`dangerFullAccess` 沙箱或 `auto_review` 审批人）时，显式恢复 config.toml 生效值 |

非 Codex 的 Codez Agent 运行时保留旧四档（build/edit/plan/yolo）语义，不受本 spec 影响；`custom` 只属于 Codex 链路。

## 状态所有权与事件顺序

- 生效权限的唯一所有者是原生线程；bridge `ThreadStateStore` 持有投影缓存，并额外记住"用户最近一次显式选择的档位"（bridge 进程内存，不落盘、不跨进程）。
- 投影输入必须完整：`thread/start` / `thread/resume` / `thread/fork` 响应在顶层携带 `approvalPolicy` / `approvalsReviewer` / `sandbox`（`Thread` 结构体本身不含权限字段），水合装饰必须合并 `approvalsReviewer`（丢失会把 edit 线程误投影为 custom，切 custom 时漏发恢复覆盖）；`thread/settings/updated` 事件同步更新 `approvalsReviewer`（外部 CLI/另一窗口的变更不能被投影吞掉）。
- 投影规则（snapshot `config.mode` 与 queue 守卫共用同一推导）：
  1. 本进程记住的显式档位优先；
  2. 否则按线程生效值推导：`dangerFullAccess → yolo`；`approvalsReviewer=auto_review → edit`；其余 → `custom`（无显式选择即跟随原生，与旧 build "保留原生权限"行为等价）。
- 档位切换只编辑草稿，随下一次 startNow 提交经 `turn/start` 生效；busy/queue 场景维持既有守卫（per-input 设置变更拒绝 + UI toast）。
- `custom → 放宽态恢复`：bridge 读取 `config/read` 的 `sandbox_mode` / `approval_policy` / `approvals_reviewer` 显式下发；读取失败或值为 granular 等不可映射形态时，回退 `workspaceWrite + on-request + user` 基线。恢复动作必须复位 `approvalsReviewer`，不允许只改沙箱留下 AI 代批。

## 能力探测与降级

- bridge `runtime/capabilities` 新增 `autoReviewApprovals`：探测原生 `guardian_approval` feature（`experimentalFeature/list`）与 `configRequirements/read` 的 `requirements.allowedApprovalsReviewers`（wire 为 camelCase；来源配置项即 `allowed_approvals_reviewers`，旧别名 `guardian_subagent` 与 `auto_review` 等价对待）；两者均允许才 `supported`，否则 `unsupported`。探测结果（含失败）按 bridge 进程缓存，进程重启后重新探测；UI 侧在 runtime 重启 / transport 替换后重新 hello，刷新期间按不可用处理（fail-closed）。
- 能力非 `supported` 时，composer 隐藏 `edit` 档；已持久化的 `edit` 草稿在 Codex scope 归一化为 `custom`。
- 旧 peer 缺省该能力字段时按 `unsupported` 解析（协议字段为 optional，UI 投影缺省即隐藏）。

## 默认值与迁移边界

- Codex 会话新任务草稿默认档为 `custom`（不静默覆盖用户 config.toml）。
- 存量持久化草稿：`yolo` 保留（语义不变）；升级前写入的 `build`（草稿缺少 `permissionModeGen:2` 代际标记）在展示与提交层归一为 `custom`——旧 build 语义（保留原生权限）与新 custom 等价，直接下发 build 会被 bridge 当成显式迁移而静默改写线程权限；新版本下用户显式选择的 `build` 写入代际标记，原样保留。`edit` 在能力可用时自然获得 Approve for me 语义，不可用时按上节归一化。
- `custom` 只属于 Codex 链路：残留草稿落到非 Codex 链路时 UI 展示/提交归一为 `build`，Codez Agent CLI admission（`resolveSubmittedExecutionState` / `switchCollaborationMode`）对 `custom` 显式拒绝（failed ACK），不允许静默降档。
- `submissionModeSchema` 增加 `custom`；`codezSessionModeSchema` 增加 `custom`（additive，旧运行时不产生该值，`normalizeAvailableCodezMode` 对未知值仍回退 build）。
- bridge 不再拒绝 `edit`；`turnMode` 的 `edit → unsupported` 与 `createNativeSession` 的 edit 拒绝同步移除。

## 失败语义

- `edit` 下发后原生拒绝（组织策略运行时收紧）：命令失败原样上浮为 composer 错误，不重试、不静默降档。
- 能力探测失败：按 `unsupported` fail-closed（隐藏），不猜测可用。
- `custom` 恢复时 `config/read` 失败：使用回退基线并在 bridge 日志记录 warn，不阻断提交。

## UI 约束

- Codex 会话档位菜单顺序对齐原生：请求批准 → 帮我审批 → 完全访问 → 自定义；Plan 勾选框保持在菜单顶部独立区域。
- 完全访问首次选择需确认弹窗（一次性，持久化确认状态），沿用现有 warning 配色。
- 档位标签与说明使用 per-runtime i18n 键（`mode.codex.*`），不复用 glm/codez 文案。
