# Dynamic workflow availability

Host 是工作流能力的唯一裁决者，现有 `dynamicWorkflowAvailabilityStore` 是 renderer 快照的唯一缓存，Root loader 是 app 会话的取数入口。Automation、run 面板和设置只读同一投影，不根据自身 workspace ServiceProvider 另起读取。

```text
Root loader → 当前 Host capability → 既有 availability store → 各 UI 消费方
设置 owner → Root 串行「通知 Host → 重读」───────────────┘
```

首次用户选择只建立基线；后续选择按现有 Promise 链串行同步再重读，Host 同步失败仍重读。Host / service 换代沿用 store generation，迟到结果不能覆盖新目标；失败按 disabled 投影，同一 service 的 single-flight 与换实例重试不变。Codex 关闭 legacy 工作流入口并使旧请求失效。

本模块只登记 `useDynamicWorkflowAvailability.ts` 精确入口，不新增 store、广播、缓存、定时器或服务写入路径。桌面 continuous 与手机 replayable 继续使用所属 Host 的既有连接语义，不把工作流快照当作新的服务端事实。
