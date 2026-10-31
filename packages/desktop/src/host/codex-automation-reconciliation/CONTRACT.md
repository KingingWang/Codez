# Desktop Codex automation reconciliation

原 scheduler 持有运行定义和 dispatch 守卫，correlation repository 持有
`workspaceKey + runId` 的原生关联；本模块只按已记录 command ID 读取原生历史。
不创建线程、不 send、不重发、不保存第二份 admission 或终态。

capability 缺失/降级先拒绝。找到目标 run 终态后停止旧页读取；运行中或无关终态不授权
短路。目录、identity、remoteSessionId 贯穿；分页不推进、暂时读取失败和线程已删除保持
各自结果分类。原 repository 决定是否推进 ledger，terminal 不因重放/迟到/删除被重写。

Desktop continuous 和 mobile replayable 只是既有事实的交付路径，不拥有 Automation
结算。既有行为与验收见 `specs/codex-desktop-automations.md`。
