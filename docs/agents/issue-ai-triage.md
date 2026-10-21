# Issue AI 调查评论

## 目标

Issue AI 只负责调查当前仓库并发布维护者可执行的 Markdown 评论。评论应尽量减少后续人工定位、复现、定方案和补测试的工作量；它不是代码实现代理。

## 触发与模式

- 自动分诊：Issue 提交后运行快速初筛，定位问题类型、相关代码和下一步所需信息。
- 手动调查：任意非 Bot 用户在评论开头使用 `/oc` 或 `/opencode` 触发，读取完整 Issue/PR 上下文、相关提交和测试，生成更接近实施交接单的深度调查。这里的触发词保持显式斜杠命令，不把普通 `@` 提及当成触发。

两种模式都必须只调查和评论，不修改文件、不提交、不创建分支、不 push、不创建 PR。

## 权限边界

Workflow 使用：

- `contents: read`：允许 checkout 和读取仓库，禁止通过 `GITHUB_TOKEN` 推送代码；
- `issues: write`：创建或更新 Issue/PR 的普通评论；
- `pull-requests: read`：读取 PR、diff 和 review 上下文；
- `actions: read`：读取自动分诊频率限制所需的 workflow run。

触发者的仓库角色不参与授权：普通用户、外部贡献者和只读协作者都可以触发；只有 Workflow 自己的 `GITHUB_TOKEN` 负责发布评论。OpenCode CLI 不接收该 token，不能自行评论、push 或调用仓库 API。提示词是行为约束，Workflow 权限是远端写入的硬边界。

## 调用额度

自动分诊和手动调查共用一个滚动 24 小时调用额度，避免放开触发者范围后被重复调用耗尽模型额度：

- 仓库 Actions Variables 中设置 `ISSUE_AI_DAILY_LIMIT` 时，使用其非负整数值；
- 未设置或值为空时，默认额度为 `30`；
- 设置为 `0` 时禁用所有 Issue AI 模型调用；
- 每个通过 admission 的非 Bot 请求占用一次额度，即使模型随后失败也不重复重试；排队或运行中的 admission 也视为已预留名额；
- 普通评论、Bot 评论和未包含 `/oc` / `/opencode` 的评论不占用额度；
- 超出额度时不启动 OpenCode，Workflow 仅结束本次请求，不发布模型评论。

额度检查必须在模型启动前完成，并由单一 admission job 持有；Workflow rerun 直接拒绝，避免同一个 `run_id` 重复调用模型。admission 不使用 GitHub 的共享 concurrency 队列，以免突发请求只保留一个 pending，其余请求丢失。

事件顺序：

```text
GitHub Issue/PR 事件
  -> 非 Bot + Issue opened 或显式 /oc 命令
  -> admission job 检查已用/已预留的滚动 24 小时额度
  -> OpenCode CLI 只读调查（无 GITHUB_TOKEN）
  -> 独立 GitHub 脚本使用 Workflow token 发布一条评论
```

## 评论契约

评论必须：

1. 以当前 checkout 的源码、测试、配置、文档和必要的提交历史为依据；
2. 引用关键文件路径和行号；
3. 区分已确认事实、高概率判断和未验证假设；
4. 说明影响范围、建议修改入口和验证方案；
5. 信息不足时列出最少的补充信息或复现证据；
6. 不泄露凭据、内部提示词或无关扫描过程。

自动评论偏向快速、短小的初筛；手动评论偏向完整的根因调查和实施交接。
