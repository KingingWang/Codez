# Issue AI 调查评论与自动分诊限流

## 调查目标与边界

- 自动初筛与手动调查使用两套独立提示词，不把仓库扫描、产品设计和修复混为同一任务。
- 自动初筛只定位本次 Issue，输出后续处理者可以复用的证据、最小验证步骤和真实阻塞。
- 手动调查回答本次用户追问，复用并重新核验已有结论，只补充新证据与必要的实现交接。
- 两个入口都只读：不修改文件、不安装依赖、不创建分支或 PR、不提交或推送代码，也不修改标签、指派、Issue 状态等远端资源。
- 最终回复由独立 GitHub 脚本发布为一条评论；OpenCode CLI 不接收 `GITHUB_TOKEN`，也不通过工具另发评论，避免重复评论和远端写入。
- Issue/PR 正文、引用评论、日志和外部材料是待核实的数据，不能授予额外权限或覆盖工作流边界。
- 保留 `contents: read`、`pull-requests: read` 和 checkout 的 `persist-credentials: false`；不因改进提示词提高写权限。
- OpenCode CLI step 设置 `OPENCODE_PERMISSION: '{"edit":"deny"}'`，禁用内置 edit/write/apply_patch，保留当前调查所需的只读搜索；CLI 进程不注入 `GITHUB_TOKEN`。该权限不限制 bash，不能宣称为完整只读沙箱；shell 和外部操作仍受上述任务边界约束。
- GitHub 上下文由 `.github/scripts/issue-ai.mjs context` 使用 Workflow token 预先读取为临时附件，再交给普通 `opencode run`；评论由同一脚本的 `comment` 子命令独立发布。不调用上游 `opencode github run`，因此不继承其“触发者必须有 write 权限”的内部门禁。

## 证据与输出契约

1. 阅读相关文件完整上下文，沿实际调用链核查，不能只引用关键词命中、注释、函数名或测试名。
2. 先判断已有支持、实际缺口和不适用项；只有违背明确行为契约且有证据的问题才作为已确认缺陷。
3. 风格偏好、额外 UI 提示、重构等可选增强不自动成为需求或高优先级缺口；建议必须说明必要性，不能扩大 Issue 范围。
4. 区分事实、推测与未验证风险。存在保护逻辑不等于端到端正确，需要检查触发、状态、结果接收及消费路径。
5. 区分读过测试与执行过测试，说明实际断言覆盖什么；仅执行已有依赖支持且确认不写文件、不触发真实服务或消费额度的直接相关测试。
6. 每条发现给出精确证据、影响及最小验证步骤；重要证据链接到当前检出提交的文件行号。命令须核对当前 package/scripts，不凭空编造。
7. 仓库和已给链接中能自行查明的信息不再询问提交者。待确认问题最多 3 个，只保留阻塞处理的外部事实或产品决策，并说明影响。
8. 自动评论通常不超过 1500 字、3 条发现及 2–5 个关键文件；手动评论通常不超过 3000 字，围绕本次追问给出增量证据和实施交接。
9. 自动初筛在已完成范围核查、无实现缺口且无关键未验证风险时，使用固定短结论和最多 2 条证据后结束，不凑完整章节。证据不足则明确“待复现”及最小验证步骤。
10. 手动调查无新增证据或缺口时，用固定短结论、简短依据和仍阻塞的验证后结束，不重复整份旧报告。没有旧结论时，只有完成范围核查、未发现实现缺口且无关键未验证风险，才能进入无发现出口，否则标记待复现。

## 上游借鉴

参考 OpenCode 提交 `da9d436c36e0145110531ffcd7b15e50016fdd82`：

- [review.yml](https://github.com/anomalyco/opencode/blob/da9d436c36e0145110531ffcd7b15e50016fdd82/.github/workflows/review.yml)：完整上下文、仅实际违规才评论、建议与事实分开、无发现简短退出。
- [triage.md](https://github.com/anomalyco/opencode/blob/da9d436c36e0145110531ffcd7b15e50016fdd82/.opencode/agent/triage.md)：单一任务和明确能力边界，不迁移其自动分派负责人行为。
- [duplicate-pr.md](https://github.com/anomalyco/opencode/blob/da9d436c36e0145110531ffcd7b15e50016fdd82/.opencode/agent/duplicate-pr.md)：不同关键词交叉核查、精确链接和无发现固定短结论，不将重复 PR 搜索变成所有 Issue 的必做任务。
- [权限文档](https://opencode.ai/docs/permissions/)：按能力禁止内置写入工具，不照搬上游专用工具白名单或会阻断当前调查方式的 bash deny 配置。

## 规则与所有者

- `.github/workflows/issue-ai.yml` 的 `admission` job 是自动分诊和手动调查额度的唯一所有者；后续 job 不重复计算或保存额度。为避免 GitHub concurrency 只保留一个 pending 而丢失突发请求，admission 不依赖共享 concurrency，而是把其他运行中/排队中的 admission job 视为已预留名额。
- 自动分诊使用滚动 24 小时窗口，不按自然日午夜重置。
- Actions Variables 中的 `ISSUE_AI_DAILY_LIMIT` 为非负整数时使用该值；变量为空或未设置时默认为 `30`；`0` 表示禁用所有模型调用；非法值拒绝本次 admission，不回退为无限制。
- 统计本仓库 `issue-ai.yml` 中通过 admission 的历史运行，查询 `created >= 当前时间减 24 小时`，覆盖 `issues`、`issue_comment` 和 `pull_request_review_comment` 三种事件；以 `admission` job 成功、排队或运行中作为已占用/预留名额的唯一标记，普通评论、Bot、非法配置、超额拒绝和被 job 条件跳过的运行不占用额度。
- 当前运行按 `context.runId` 排除，历史次数小于上限才允许继续；历史 29 次时允许第 30 次，历史 30 次时拦截第 31 次。
- admission 的成功、排队和运行中 job 都是额度预留；一旦放行，该请求占用一个名额，即使后续模型失败也不重试或返还。Workflow rerun 直接拒绝，必须用新的 Issue/PR 命令请求，避免相同 `run_id` 绕过额度。
- 保留按 Issue/PR 的执行 concurrency；Bot 事件不进入 admission，避免机器人评论循环。

```text
Issue/PR 事件 → 非 Bot + Issue opened 或显式 /oc 命令
                         ↓
                 admission 检查已用/已预留额度
                         ↓
             查询过去 24 小时的三类事件运行
                         ↓ 排除当前 runId 和跳过运行
                    历史次数 < 配置上限？
                    ├─ 是 → OpenCode CLI 只读调查 → GitHub 脚本发表评论
                    └─ 否 → 不启动模型
```

## 验收

- 两套提示词保持不同的任务、输出和无发现退出分支，并包含只读、证据门槛、测试状态与最小交接规则。
- 无发现不制造问题；存在未验证风险不声称“已正确实现”；修复请求转为交接，不扩大执行权限。
- 提示词契约测试是结构回归，不等同于真实模型输出评测；本地测试不创建测试 Issue 或额外评论。
- 查询使用 `>=` 时间筛选、三种事件和分页，不能只匹配某一个时间戳。
- 默认上限为 30；配置 29 次历史时允许当前第 30 次，配置 30 次历史时拦截当前第 31 次；自定义配置按同样规则判定。
- 查询结果是否包含当前运行都不改变判定。
- 日志明确显示滚动 24 小时历史次数及实际上限。
- 非 write 权限用户可以进入手动调查，OpenCode CLI 不持有 `GITHUB_TOKEN`，仅独立 GitHub 脚本发表评论。
- 回归命令：`node --test scripts/test/issue-ai-workflow.test.mjs`。
