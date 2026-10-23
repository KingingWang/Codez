# codex-runtime-notices

Codex 原生 warning 与 auth recovery 的纯 UI 投影，供 ConversationComposer 消费。

不变量：

- 唯一事实源是 V4 snapshot 的 `runtimeNotices`；桌面 continuous 与手机 replayable 不分别订阅原生事件。
- 组件不持有运行时状态，不发 RPC，不把通知写成持久对话历史或终端错误。
- 按 snapshot 顺序和通知 `id` 渲染；空数组不产出占位 UI。
- auth recovery 的 started/completed 只改变对应通知的展示，不推断 turn、连接或鉴权的整体状态。
