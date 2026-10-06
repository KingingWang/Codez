# Git 清理闭环：删除工作树与删除分支（阶段二第二批）

> 父方案：[git-worktree-projects.md](git-worktree-projects.md)。本批落地其中 R12–R14
> 的 v1 范围，新增分支删除能力，并收敛工作区相关入口的信息架构（修订 R2 部分措辞）。

## 修订记录

- **v1.1（安全审查闭环）**：针对只读审查发现的 7 个方案缺口修订——
  ① ignored 敏感配置纳入影响预览与指纹（原只覆盖 untracked）；
  ② 指纹升级为内容级摘要并定义扫描预算与降级（原只含路径与增删行数）；
  ③ 分支删除改为 `update-ref` expected-OID 原子比较删除，工作树删除明确并发
  保证边界（原承诺"杜绝 TOCTOU"过强）；
  ④ 新增执行窗口保护（W8）：确认后复检 + 删除期间拦截激活与任务 admission；
  ⑤ detached HEAD 且提交不可达的工作树独立风险确认，不归入 ready-clean；
  ⑥ 补齐操作记录幂等契约：preview 携带 operationId、remove 显式丢弃意图、
  结果未知态与重试分流、错误载荷携带最新预览；
  ⑦ W5 修正为先释放运行时后删除的完整关闭编排（原误写为仅 closeTab）；
  ⑧ 修订父方案 R13：删除权依据台账实时事实，来源标记降级为提示用途，解决
  政策冲突；验收编号接续父方案从 22 起。

## 背景

当前 GUI 只能创建和打开工作树，不能删除；分支列表只能切换和创建，不能删除。用户
做完并行任务后必须回到终端清理，切换器与分支列表会持续堆积废弃条目。创建门槛为
零、清理门槛是"会用 git CLI"，入口只进不出会稀释导航本身的价值。

本批回答的产品问题：

> 任务做完后，我能在做完这件事的同一个界面里，看清会失去什么，然后把工作区和
> 不用的分支删掉。

## 范围与非目标

**范围内**：删除工作树（含脏树）、删除本地分支、工作区/分支入口的信息架构收敛。

**非目标（v1 不做）**：

- UI 解锁 locked 工作树（只展示原因，解锁仍在终端）。
- `git worktree prune` 的任何包装（仓库级操作，不伪装成单行删除，R14）。
- "停止任务并删除"组合按钮（运行中只阻塞 + 引导）。
- 删除后会话历史的"恢复工作位置"引导（记为已知差距，沿用既有打开失败文案）。
- 远端跟踪分支删除、分支重命名。
- 跨窗口运行检测：目标工作区在另一个窗口打开并有运行任务时，本窗口无法感知，
  依赖脏文件清单与影响预览兜底提示。

## 信息架构（修订父方案 R2）

- **IA1 分支菜单 = 纯分支操作**：切换分支、新建并检出分支（当前目录，不变）、
  删除分支（本批新增）、新建独立工作区…（保留）。创建入口保留在分支菜单是因为
  工作区切换器按 R2 在登记树 ≥2 时才出现——第一棵树创建前切换器不存在，分支
  菜单是"从零到一"的常驻发现位。
- **IA2 工作区切换器 = 工作区生命周期面板**：点行主体打开/切换（不变）、行尾
  删除图标（新增）、底部"新建独立工作区…"（新增，与分支菜单入口指向同一对话框，
  复用同一创建控制器与 disabledReason）、不可达重试（不变）。
- **IA3 撤掉分支菜单里的「打开已有工作区…」**（`GitWorktreeMenuActions` 中的
  下拉整体移除），打开已有工作区收敛到切换器。新建任务箭头菜单的三件套
  （当前工作区/新的独立工作区/已有工作区…）保持不变（R1 纪律）。
- **IA4 行尾删除图标规则**：主目录行不显示；其余行常显（不依赖 hover，移动端
  可用）；点击 `stopPropagation`，不触发行主体的打开逻辑；当前工作区/locked 等
  门控不在入口做分支，统一在确认弹层内解释——入口零状态，判定逻辑只有弹层一处。

## 删除工作树（W 系列）

- **W1 两段式执行**：只读预检（preview）→ 用户确认 → 执行（remove）。预检快照
  生成内容级 `statusFingerprint`（见 W9），执行请求携带该指纹，服务端执行前
  重新计算并比对，不匹配则拒绝并以错误载荷返回最新预览，UI 刷新弹层要求重新
  确认。该机制把"确认时看到的"与"删除时实际的"之间的窗口收敛到执行前最后一次
  复检；残余窗口的保证边界见「并发保证边界」一节，不承诺绝对原子。
- **W2 确认弹层状态机**（`RemoveWorktreeDialog`）：

  | 状态             | 触发                                       | 可确认     | 说明与动作                                     |
  | ---------------- | ------------------------------------------ | ---------- | ---------------------------------------------- |
  | preview-pending  | 打开弹层，预检中                           | 否         | 骨架/加载态                                    |
  | ready-clean      | 无改动、无敏感配置、非 detached 风险       | 是         | 直接确认                                       |
  | ready-dirty      | 有未提交/未跟踪/敏感配置文件               | 勾选后     | 勾选"我已知晓 N 项改动将被丢弃"                |
  | confirm-detached | detached HEAD 且 head 不被任何 ref 包含    | 独立勾选后 | 勾选"放弃该 HEAD 提交的引用"（与脏勾选独立）   |
  | blocked-current  | 目标是当前激活工作区（含其树下子目录 tab） | 否         | 引导先切换到同项目其他工作区                   |
  | blocked-running  | 目标已打开且有运行中任务                   | 否         | 说明 + "跳转到该工作区"停止任务                |
  | blocked-locked   | 台账 isLocked                              | 否         | 显示锁定原因，引导终端解锁                     |
  | unreachable      | 台账 isPrunable 或预检目录不可读           | 否         | 重试；提示检查挂载/连接，不推荐清理            |
  | risk-unknown     | 预检失败、扫描超限或文件读取失败           | 否         | 重试；风险未知不等于没有风险                   |
  | status-changed   | 执行时指纹不匹配                           | 重新确认   | 弹层用错误载荷中的最新预览刷新                 |
  | result-unknown   | 执行响应丢失（断连/超时），结果未知        | —          | 按原 operationId 查询/重试（W7）               |
  | removing / error | 执行中 / 明确失败                          | —          | 失败保留条目；重试 = 重新预检 + 新 operationId |

  `ready-clean` 的充要条件：`totalChangeCount = 0` 且 `attentionTotalCount = 0`
  且非 detached 风险且 `scanComplete = true`。敏感配置存在即进入 ready-dirty。

- **W3 影响清单**：未提交改动与未跟踪文件合并列出（展示封顶 100 条，超出显示
  `totalChangeCount` 总数）。**敏感本地配置文件（`.env`、凭据类）单独成区并
  高亮"需要关注"——来源同时覆盖未跟踪与被 gitignore 忽略的文件**（ignored
  文件不进 `git status` 常规输出，但 `worktree remove` 同样物理删除，必须经
  `git status --ignored` / 等价扫描纳入）。该清单独立于 changes 的展示上限
  （`attentionPaths` + `attentionTotalCount`）。保留说明固定展示："分支
  {branch} 保留，会话历史保留"——与"关闭工作区"的确认文案明确分开（R12）。
- **W4 脏树可删**：脏不是门槛，是确认信息。勾选知悉后执行
  `git worktree remove --force`；干净树执行不带 `--force` 的
  `git worktree remove`，保留 git 原生 dirty 检查作为额外防线；该检查与目录删除
  不是文件系统事务，ignored 文件的新写入也不会触发 dirty 拒绝，不称为原子等效。
- **W5 成功后处置（先释放，后删除）**：确认点击后、发起 remove RPC **之前**，
  若目标在本窗口已打开（非激活），先完整走侧栏关闭入口的同一关闭编排——
  删除链路使用可等待、失败抛出的 `releaseWorkspaceRuntimeBeforeRemoval`，
  **先解析全部 tab 的服务并等待全部 runtime 释放成功，再 `closeTab` 和失效任务缓存**；
  侧栏仅移除入口的 fire-and-forget helper 保持不变。服务缺失或任一释放失败时
  保留全部 tab，不发 remove RPC；重试仍需重新释放，不能因为 tab 已关闭而跳过。
  禁止仅调 `tabStore.closeTab`（它不释放运行时/连接）。匹配范围：同一来源
  作用域内 `workspacePath` 等于 targetPath 或位于其下的所有 tab（树根与子目录
  都算）。释放先行也是 Windows 兼容要求：运行时/进程持有目录句柄时 remove 会
  失败。关闭编排失败则中止删除并进入 error 态。删除不附带删分支、删会话记录。
- **W6 服务端复检（安全核心）**：`removeWorktree` 执行前必须自己重列台账，确认
  目标路径属于该仓库、不是主目录、未被 lock；再重算内容级指纹比对。**删除权
  依据 git 台账实时事实；UI 传入的路径、文案、勾选都不是授权依据**。来源标记
  在 v1 不读取：全部工作树统一执行最保守的完整确认流程（即父方案"标记缺失按
  用户创建处理"的最谨慎档）；未来批次可用标记对 Codez 创建树简化文案，但不得
  降低任何安全检查（与父方案 R13 修订后措辞一致）。
- **W7 幂等与结果未知**：`operationId` 从 preview 起贯穿（preview 请求即携带），
  操作记录写入 `<gitCommonDir>/codez/worktree-operations/<operationId>.json`
  （复用创建链路目录与恢复语义）。规则：
  - 同一 operationId + 不同请求指纹（targetPath/expectedFingerprint/意图标志
    任一不同）→ 拒绝 `operation-conflict`；
  - 明确失败（error 态）后的重试 = 重新预检 + **新 operationId**；
  - 结果未知（result-unknown 态）后的查询/重试 = **原 operationId**：服务端先查
    操作记录与台账——目标已不在台账 → 幂等返回成功；仍在且指纹匹配 → 继续执行；
    指纹不匹配 → status-changed 并携带最新预览。
- **W8 执行窗口保护（UI 层所有者）**：运行态只存在于 UI，服务端无法感知，因此
  当前/运行中门控由 `WorkspaceShellLayout` 的 `useWorktreeRemoval` 负责：
  - **确认后复检**：点击确认、发起 remove RPC 之前，重新判定目标（含树下子目录
    tab）是否已被激活、是否有运行中任务；任一成立 → 转入对应 blocked 态，不发起
    RPC。删除成功后再检查视为失效设计。
  - **删除期间拦截**：执行期间把 targetPath（宿主端规范值）注册进 shell 级
    "删除中"集合；打开编排（`useWorktreeOpenActions` / root actions）与新任务
    发送入口查询该集合，命中则拒绝激活/admission 并提示"该工作区正在删除"；
    异步打开不仅在入口检查：平台打开请求返回后、实际激活/建 tab/启动草稿之前
    必须再次检查，防止删除开始前发出的打开请求在删除期间迟到提交。
    执行结束（成功/失败/弹层关闭）出清。集合是窗口内 UI 状态，不持久化。
- **W9 内容级指纹**：`statusFingerprint` = 对以下内容的稳定哈希——head commit、
  每个相关文件（已跟踪改动 + 未跟踪 + 敏感配置文件）的
  `(path, section, kind, size, sha256(文件字节))`。规则：
  - 二进制文件直接按字节哈希，不做文本特判；
  - 任何文件读取失败 → 该文件以 `unreadable` 标记参与哈希，且预览
    `scanComplete = false`（弹层进入 risk-unknown，不可确认）；
  - 扫描预算（默认 ≤5000 文件、≤256MB 总量）超出 → `scanComplete = false`；
  - 展示上限 100 条只影响渲染，安全扫描与指纹计算不受其截断。

## 删除分支（B 系列）

- **B1 入口**：分支列表行尾删除图标（与 IA4 同规则）。当前分支行不显示；其余
  行常显。
- **B2 占用拦截**：分支被任一工作树检出时，弹层显示阻塞态"正被 {path} 检出"
  并提供"跳转到该工作区"（占用信息复用分支列表既有 `worktreePath` 契约）。
- **B3 合并保护**：默认安全删除（合并检查通过才执行）；预览显示合并状态与最新
  提交信息；未合并时明确提示"包含未合并提交"，勾选知悉后才以强制模式执行。远端
  跟踪分支不受影响，弹层写明"仅删除本地分支"。
- **B4 服务端原子删除**：执行顺序——重查占用（for-each-ref `worktreepath`）→
  重查合并状态（force=false 时 `merge-base --is-ancestor`，不通过按
  branch-not-merged 拒绝）→ **`git update-ref -d refs/heads/<name> <expectedOID>`
  原子比较删除**（tip 已移动则 git 拒绝，映射 branch-moved 并携带最新预览）→
  best-effort 清理 `branch.<name>.*` 配置（失败不阻断，结果中标注）。不使用
  `git branch -d|-D` 作为执行命令：它不接受 expected OID，复检与删除之间存在
  已被实证的竞态。占用检查与 update-ref 之间的残余窗口见「并发保证边界」。
  删除分支不连带任何工作树/会话操作（R12 三动作分离）。

## 协议契约（`packages/shared/src/git.ts` 新增，契约级草案）

```ts
export type GitWorktreeRemoveIssueCode =
  | "not-found"
  | "is-main"
  | "locked"
  | "unreachable"
  | "status-changed"
  | "operation-conflict"
  | "scan-incomplete"
  | "discard-changes-required"
  | "discard-detached-head-required"
  | "unknown";

export interface GitWorktreeRemovePreviewRequest {
  /** 任一已连接工作区路径，决定执行 Host（与创建链路同一约定）。 */
  workspacePath: string;
  targetPath: string;
  /** 从 preview 起贯穿整个操作（W7）。 */
  operationId: string;
}

export interface GitWorktreeRemovalPreview {
  targetPath: string;
  branchName: string | null;
  isDetached: boolean;
  headCommitHash: string | null;
  /** head 是否被任一 ref 包含；detached 且 false 时进入 confirm-detached。 */
  headReachableFromRef: boolean | null;
  isMain: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isReachable: boolean;
  /** 未提交 + 未跟踪，展示用，服务端封顶 100 条。 */
  changes: GitFileChange[];
  totalChangeCount: number;
  /** 敏感本地配置文件：未跟踪 + 被 gitignore 忽略（W3），独立清单。 */
  attentionPaths: string[];
  attentionTotalCount: number;
  /** 扫描预算超出或文件读取失败时为 false → risk-unknown，不可确认。 */
  scanComplete: boolean;
  /** 内容级摘要（W9）；UI 不透明传递。 */
  statusFingerprint: string;
}

export interface GitWorktreeRemoveRequest {
  workspacePath: string;
  targetPath: string;
  operationId: string;
  expectedFingerprint: string;
  /** 用户勾选后的显式丢弃意图；树脏/含敏感配置且为 false 时服务端拒绝。 */
  allowDiscardChanges: boolean;
  /** detached 风险确认后的显式意图；confirm-detached 场景为 false 时拒绝。 */
  allowDiscardDetachedHead: boolean;
}

export interface GitWorktreeRemoveResult {
  removed: true;
}

/** status-changed / branch-moved 时携带最新预览，UI 直接刷新弹层。 */
export interface GitWorktreeRemoveIssue {
  code: GitWorktreeRemoveIssueCode;
  message: string;
  latestPreview?: GitWorktreeRemovalPreview;
}

export type GitBranchDeleteIssueCode =
  | "branch-is-current"
  | "branch-checked-out"
  | "branch-not-merged"
  | "branch-moved"
  | "branch-not-found"
  | "invalid-branch-name"
  | "unknown";

export interface GitBranchDeletePreviewRequest {
  workspacePath: string;
  branchName: string;
}

export interface GitBranchDeletePreview {
  branchName: string;
  isCurrent: boolean;
  /** 被检出的工作树路径；空闲为 null。 */
  checkedOutPath: string | null;
  /** null = 合并状态未知，UI 按未合并保守呈现。 */
  isMerged: boolean | null;
  commitHash: string | null;
  commitSubject: string | null;
  upstreamName: string | null;
}

export interface GitDeleteBranchRequest {
  workspacePath: string;
  branchName: string;
  force: boolean;
  /** 原子比较删除的旧值（B4）；分支 tip 不匹配则 branch-moved。 */
  expectedCommitHash: string | null;
}

export interface GitBranchDeleteIssue {
  code: GitBranchDeleteIssueCode;
  message: string;
  latestPreview?: GitBranchDeletePreview;
}

export interface GitBranchDeleteResult {
  deleted: true;
  configCleanupSucceeded: boolean;
}
```

- `IGitService` 新增：`previewWorktreeRemoval` / `removeWorktree` /
  `previewBranchDeletion` / `deleteBranch`。
- 旧远端返回 -32601 时按 unsupported 处理：入口隐藏或禁用并附说明（R15），
  不从错误串推断能力。

## 并发保证边界（明示，不过度承诺）

| 操作           | 保护机制                                                         | 残余窗口                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 干净工作树删除 | 不带 `--force`：保留 git 原生 dirty 检查作为额外防线             | Git 检查后仍可能有外部写入；ignored 配置的新写入不触发 dirty 拒绝。不承诺文件系统原子删除                                                                   |
| 脏工作树删除   | 执行前内容级指纹复检，窗口压缩到 RPC 内毫秒级                    | `--force` 无 git 级兜底；复检后、删除瞬间的外部新写入会一并丢失。属勾选确认的明示语义                                                                       |
| 分支删除       | `update-ref -d <ref> <expectedOID>` 原子比较删除，tip 推进被拦截 | 占用/合并检查与 update-ref 之间：他处恰好在此窗口 checkout 该分支时 update-ref 不感知占用。概率极低，属用户并行操作的明示冲突；窗口内 tip 推进仍被 CAS 拦截 |
| 运行态/激活    | W8：确认后 UI 复检 + 删除中集合拦截 admission/激活               | 跨窗口运行与激活无法感知（非目标），依赖影响预览兜底                                                                                                        |

## 状态所有者与事件顺序

```text
切换器行尾删除图标（主目录除外）
  → WorkspaceShellLayout / useWorktreeRemoval（弹层与流程唯一所有者；
    切换器组件保持只读展示）
  → previewWorktreeRemoval（含 operationId）：gitService（项目 anchor 已连接 Host）
       ├─ 服务端：重列台账 + targetPath status/ignored 扫描 + 内容指纹
       │   （不挂载目标运行时）
       └─ UI 并行本地事实：是否当前/已打开/运行中（tabStore + 会话运行投影，
          含树下子目录 tab）
  → 确认弹层（W2 状态机 + fingerprint 快照）
  → 用户确认 → W8 复检当前/运行中 → 注册"删除中"集合
  → 目标已打开？→ 完整关闭编排（release + closeTab + 缓存失效，W5）
  → removeWorktree（服务端 W6 复检台账 + 指纹）
  → git worktree remove [--force]
  → 成功：worktreeDiscovery.refresh() + 出清"删除中"集合
  → status-changed：用错误载荷最新预览刷新弹层
  → result-unknown：原 operationId 查询/重试（W7）

分支行尾删除图标（当前分支除外）
  → 同一 shell 持有的 useBranchDeletion
  → previewBranchDeletion → 确认弹层（占用/未合并两态）
  → deleteBranch（B4：占用/合并重查 → update-ref CAS → 配置清理）
  → 刷新分支列表
```

- 弹层与流程状态归 `WorkspaceShellLayout` 持有的 hook，与创建闭环同一模式；
  UI context 按 `workspaceIdentity?.trim() || workspacePath` 校验消费者身份。
- 全程遵守 R5：预检只读 git CLI，不注册工作区、不挂载运行时、不新建连接。

## 安全不变量

1. 主目录永不可删（UI 无入口 + 服务端 is-main 拒绝）。
2. 删除授权只来自服务端复检结果（台账事实 + 内容指纹 + 显式意图标志）；UI
   传入路径、文案、勾选本身都不是授权依据。
3. locked → 只展示原因，不做 double-force；不可达 → 只重试，不推荐清理。
4. 有运行中任务 → 阻塞；确认后复检 + 删除期间拦截激活/admission（W8）；
   跨窗口运行无法感知时在弹层注明检测边界。
5. 内容指纹/expected OID 变化 → 拒绝并返回最新预览要求重新确认，不静默执行。
6. 三个动作分离：删除工作树不删分支与历史；删除分支不动工作树与历史；关闭
   工作区语义不服务于物理删除（R12）。
7. 脏树/敏感配置删除必须经勾选确认（`allowDiscardChanges`）；detached 不可达
   HEAD 必须经独立勾选（`allowDiscardDetachedHead`）；确认页文案含"永久删除
   该目录"。
8. 展示截断永不截断安全检查：100 条只影响渲染，扫描预算外或读取失败一律
   risk-unknown。
9. 关闭编排必须是完整路径（release + closeTab + 缓存失效），禁止绕过运行时
   释放直接 closeTab。

## 平台能力矩阵（R15 更新）

| 能力                 | 桌面本地 | 桌面远程已接入     | Web 服务端 | Web 远控      |
| -------------------- | -------- | ------------------ | ---------- | ------------- |
| 查看/切换/创建工作区 | ✓        | ✓                  | ✓          | ✓             |
| 删除工作区           | ✓        | ✓（经该连接 Host） | ✓          | 跟随已接连接  |
| 删除分支             | ✓        | ✓                  | ✓          | 跟随已接连接  |
| 旧远端（-32601）     | —        | 入口禁用+说明      | —          | 入口禁用+说明 |

## 验收场景

22. 干净工作树删除：切换器行尾删除 → 确认页无影响清单 → 确认后目录移除、台账
    刷新、条目消失；分支与历史保留。
23. 脏工作树删除：确认页列出全部未提交/未跟踪文件与敏感配置区；未勾选不可确认；
    勾选后删除成功，`allowDiscardChanges=true`。
24. 仅含 ignored `.env` 的工作树：status 干净但确认页列出敏感配置区并进入
    ready-dirty，未勾选不可确认；指纹覆盖该文件内容。
25. 删除激活工作区（含其树下子目录 tab 为激活的情形）：弹层阻塞态，引导先切换；
    不发生任何 git 写操作。
26. 删除有运行任务的工作区：弹层阻塞态 + 跳转；停止任务后重新预检可删。
27. locked 工作树：弹层显示锁定原因，不可确认；终端解锁后可删。
28. 确认期间目标被外部修改（含等行数内容改写）：内容指纹不匹配，执行拒绝，
    弹层用错误载荷刷新为最新清单要求重新确认。
29. 已打开非激活工作区被删：先完成完整关闭编排（运行时释放、任务缓存失效），
    再执行删除；历史仍可见。释放失败时 tab 保留，连续重试失败仍不发 remove，
    后续释放成功后才关闭 tab 和删除；多 tab 中任一释放失败不得关闭任一 tab。
30. detached HEAD 且提交不被任何 ref 包含：进入 confirm-detached，独立勾选
    "放弃该 HEAD 提交的引用"后才可删除；提交可达的 detached 树无此确认。
31. 执行响应丢失：进入 result-unknown；按原 operationId 重试，目标已删则幂等
    返回成功，未删则继续执行；同 ID 不同请求被拒绝。
32. 删除执行期间从打开编排/新任务入口激活目标：被"删除中"集合拦截并提示。
    包含打开先进入、平台 IPC 挂起、删除注册守卫、IPC 迟到返回的顺序：迟到
    continuation 不得激活/建 tab/启动草稿。
33. 空闲已合并分支删除：`update-ref -d` CAS 成功，配置清理执行，分支列表刷新。
34. 未合并分支删除：弹层提示未合并提交，勾选后强制删除成功；未勾选不可确认。
35. 占用分支删除：弹层显示占用路径 + 跳转；不发生 git 写操作。
36. 当前分支：行尾无删除图标。
37. 确认期间分支被外部推进：CAS 拒绝（branch-moved）并返回最新预览；新 tip
    不被删除。
38. IA：分支菜单不再出现「打开已有工作区…」；切换器底部可新建独立工作区，与
    分支菜单入口同一对话框、同一 disabledReason；新建任务箭头菜单三件套不变。
39. 旧远端：删除入口禁用并附"此连接暂不支持该操作"，其余功能不受影响。

## 测试与验证

- services 真实 git 集成测试（沿用 `gitWorktreeCreation.test.ts` 临时仓库模式）：
  preview 各态（含 ignored 配置、detached 可达/不可达、扫描超限）、内容指纹对
  等行数改写的敏感性、指纹不匹配拒绝并携带最新预览、locked/is-main/not-found
  拒绝、脏树 --force 成功、operationId 幂等/冲突/结果未知分流；分支删除
  CAS（含外部推进竞态夹具）、占用、合并检查、配置清理。
- UI：`RemoveWorktreeDialog` / `DeleteBranchDialog` 各状态渲染测试（沿用
  `CreateWorktreeDialog.test.tsx` 模式）；切换器行图标与底部入口渲染测试；
  hook 纯函数测试（沿用 `worktreeCreationModel` 模式），覆盖 W8 复检与"删除中"
  集合拦截。
- desktop E2E：扩展 `gitWorktreeDesktop.e2e.test.mjs`，新增"创建 → 删除"闭环
  与分支删除场景。
- 必跑：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 实施批次

1. 本 spec + shared 契约类型。
2. services：preview/remove（含 ignored 扫描、内容指纹、操作记录幂等）与
   previewBranch/deleteBranch（update-ref CAS）实现 + 集成测试。
3. UI：`useWorktreeRemoval` / `useBranchDeletion` hook（含 W8 复检与删除中集合）、
   两个确认弹层、切换器与分支列表行入口、i18n（zh/en）、渲染测试。
4. IA 收敛：撤分支菜单「打开已有工作区…」、切换器底部新建入口。
5. desktop E2E + 全量验证。

### 批次 1–2 实现契约细化

- shared 类型通过 `git.ts` 的公开导出提供；删除分支返回
  `{ deleted: true, configCleanupSucceeded: boolean }`。
- 业务拒绝使用带 `code` 与 `data` 的 Error；`data` 为上述 Issue（含
  `latestPreview`），复用现有 RPC 错误透传，不修改 RPC codec。
- 安全扫描独立于 Review 面板的状态缓存和过滤：不丢弃空文件、二进制及 symlink；
  staged 内容读取 Git index，unstaged/untracked/ignored 内容读取工作树，
  删除状态使用明确的缺失标记。工作树目录及父路径中的 symlink 不跟随到树外。
  含子模块/嵌套仓库的目标按扫描不完整拒绝，不以 `--force` 绕过其保护。
  通过全量 index 的 `160000` gitlink 与有预算的嵌套 `.git` 探测判断，不依赖
  `.gitmodules` 是否存在；目录探测也受 5000 条目预算约束，超限拒绝。
- 敏感配置匹配 basename：`.env`/`.env.*`、`.npmrc`、`.pypirc`、
  `.netrc`/`_netrc`、`credentials`/`credentials.json`、`secrets.*`，
  以及 `.pem`/`.key`/`.p12`/`.pfx`。只展示路径和计数，不透出文件内容。
- 操作记录显式标记 action=remove，与已有创建记录同目录但不共用操作 ID；
  按 common dir + operationId 做排他预留并验证整个请求。只有匹配的删除记录
  存在时，台账和目录同时消失才可恢复为成功；无记录的 not-found 不能伪装成功。
  原路径若已重新登记为另一棵树，旧操作不得再次删除。
  记录及预览指纹绑定 common-dir 的文件系统身份（路径、device、inode、
  birthtime），同路径换仓或复制元数据不能重放旧记录；HEAD/refs 正常前进不改变
  此身份。
- 分支合并基准与原 `git branch -d` 一致：配置了 upstream 则检查 upstream，
  否则检查发起工作树 HEAD。基准未知时 `isMerged=null`，安全删除拒绝；
  expectedCommitHash 必须是有效的完整 OID，不能以 null 绕过 CAS。

### 批次 3–5 实施记录

- UI：`useWorktreeRemoval`（预检 → 确认/重放统一走 `executeRemoval`：W8 复检 →
  删除中守卫 → W5 关闭编排 → remove；status-changed 用 `latestPreview` 刷新，
  结果未知按原 operationId 重放且同样经过复检与关闭编排，明确失败的重试换新
  operationId 重新预检，关闭弹层后保留会话供恢复）与 `useBranchDeletion`（预检
  → 确认 → CAS 删除，branch-moved 刷新重确认）。
- 关闭编排：先解析各 tab 的 taskService（tab 关闭后 remoteSessionId 不可得），
  先 await 全部 `releaseWorkspacePreparation`，全部成功后再关闭 tab 并失效缓存；
  服务缺失或任一释放失败时保留全部 tab，重试仍会执行释放，任一失败即中止删除，
  物理删除只在释放成功后发生。`worktreeRemovalGuardStore` 按 scope 精确 + 目录
  前缀匹配，发现打开、普通打开与新任务 admission 三处入口均查询守卫；
  普通打开在平台 IPC 返回后、实际提交 UI 激活之前再次查询守卫。
- 入口：`ProjectWorktreeSwitcher` 行尾删除按钮（主目录不渲染）+ 底部
  「新的独立工作区」；`GitBranchListItem` 行尾删除按钮（当前分支不渲染）；
  分支菜单撤掉「打开已有工作区…」。弹层为 `RemoveWorktreeDialog` /
  `DeleteBranchDialog`，i18n zh/en 全量。
- 验证：services 删除集成 36/36，连同创建与发现回归共 50/50；UI 删除、
  创建、打开、弹层渲染、释放编排与守卫回归共 76/76；
  desktop E2E `gitWorktreeDesktop.e2e.test.mjs` 3/3（隔离 QA 实例，覆盖
  创建→删除闭环、脏树勾选、ignored `.env` 关注区、当前/占用阻塞、IA 断言、
  合并与未合并分支删除；新增连续两次释放失败后仍保留 tab/目录、零删除调用，
  第三次释放成功才关闭并删除的实际 hook 回归）。普通打开 admission 回归用
  挂起的 IPC Promise 验证删除窗口晚到时不执行 addTab/startDraft。
  可用 `node packages/desktop/test/gitWorktreeDesktop.qa.mjs` 一键启动独立 HOME、
  Xvfb 和端口的真实 Electron 实例，固定测试语言并自动清理。
  `pnpm typecheck`、`pnpm lint`（0 错误、74 条既有警告）、
  `pnpm architecture:check --changed`（0 违规）通过。

## 已知差距（后续批次）

- 删除后会话历史的"恢复工作位置"引导（父方案 R13 尾段）。
- 成果出口（R11）：完成态的"保留/关闭/清理"知情选择面板。
- 跨窗口运行检测。
- 来源标记读取与差异化提示（v1 全部树统一最保守流程）。
