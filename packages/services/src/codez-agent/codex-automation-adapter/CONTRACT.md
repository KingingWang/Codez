# Codex Automation adapter

原 Host AutomationRepo/dispatch owner 拥有调度及关联记录；native thread/CommandInbox
拥有输入接纳与轮次事实。本模块只登记已有 payload、终态解析和 SQLite 关联 adapter。

```text
Host dispatch(runId) → 原关联 prepare → CommandInbox / native turn
          ↑                              │
          └──── 同一 commandId 的事实对账 ┘
```

- workspace key 继续使用 identity-or-path；runId/commandId 保持原幂等约束。
- 模型默认值保持稀疏；payload 不加入 legacy execution context。
- 接纳不等于完成；正常、失败和停止按 native phase 区分，未确认事实保留 unknown。
- SQLite 关联复用 AutomationRepo 的原实例和事务，不创建第二个 scheduler、queue 或持库 owner。
- pre-send 失败、完整 dispatch guard 释放、窗口 attachment 路由及有界崩溃恢复仍由原调用方承担。
- desktop/mobile 共用原 Host 关联 owner，不让 Main、relay 或 Renderer 保存业务关联副本。
