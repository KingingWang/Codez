# Issue AI 自动分诊限流

## 规则与所有者

- `.github/workflows/issue-ai.yml` 的 `auto-triage` job 是限流的唯一所有者。
- 自动分诊使用滚动 24 小时窗口，最多允许 30 次；不是按自然日午夜重置。
- 统计本仓库 `issue-ai.yml` 中由 `issues` 事件触发的历史运行，查询条件为 `created >= 当前时间减 24 小时`。
- 当前运行按 `context.runId` 排除，历史次数少于 30 才允许继续；第 30 次允许，第 31 次拦截。
- 历史运行不按成功、失败或跳过状态过滤，保持原有按触发次数限流的口径。
- `issue_comment` 和 `pull_request_review_comment` 触发的手动调用不纳入统计，也不受该限流影响。
- 保留仓库级 `issue-ai-auto` 串行执行，不增加第二套计数、存储或重置任务。

```text
Issue opened → auto-triage 串行 admission → 查询过去 24 小时的 issues 运行
                                            ↓ 排除当前 runId
                                      历史次数 < 30？
                                      ├─ 是 → 调用 AI 初筛
                                      └─ 否 → 跳过 AI 初筛
```

## 验收

- 查询使用 `>=` 时间筛选、`event: issues` 和分页，不能只匹配某一个时间戳。
- 历史 29 次时允许当前第 30 次，历史 30 次时拦截当前第 31 次。
- 查询结果是否包含当前运行都不改变判定。
- 日志明确显示滚动 24 小时历史次数及上限 30。
- 回归命令：`node --test scripts/test/issue-ai-workflow.test.mjs`。
