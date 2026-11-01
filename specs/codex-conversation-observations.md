# Codex 实时对话事实与本地首输出诊断

Status: implemented（2026-11-02）。仅改 Codez；对照相邻 Codex 仓库的打包固定
`codex-20261020-001405` ref，只读参考，不修改 Codex 源码。

## 产品边界

- Bridge 从真实实时通知产生六类 `v4/telemetry/event`：
  `turn.started`、`stream.chunk`、`tool.lifecycle`、`permission.lifecycle`、
  `usage.delta`、`turn.terminal`。复用现有严格 schema、Host fan-out 和遥测开关，
  不新增上传开关、历史扫描或补报历史。
- 不产生没有原生来源的模型请求/重试 attempt、完整 compaction、workflow、
  subagent 生命周期。原生子线程仍只读，不按时间邻近猜测父输入或 background。
- `sourceCommandId` 只来自实际 `turn/start` 的响应关联或实时 userMessage 的
  `clientId`（对应提交的 `clientUserMessageId`）。通知早于响应时只暂存有界、
  无正文的事实，绑定真实 turnId 后再发送。Queue/Guide 不抢占原轮输入归属。
- turnTokenUsage 仍由 ThreadStateStore 维护；观察器只保存已报告水位。只有
  原生累计值和所需六个 token 字段完整时才差分发送；重复通知不重复计数，
  缺字段或累计倒退不填零，不声明能定位每个模型请求。
- 工具 duration 优先原生 durationMs，否则只在真实 startedAtMs/completedAtMs
  均可用且非负时相减；不使用接收时刻冒充工具执行时间。允许缺 started 或
  缺 completed，不伪造终态。事实不携带正文、工具参数、原始路径或错误原文。
- 原生协议可能抑制部分工具起止通知，因此不把观察到的工具集合大小冒充整轮
  `toolCallCount`（包括零值）。stale/rejected 的输入记 excluded，而不是执行失败。
- 合法乱序通知必须先发 `turn.started` 再发该轮其他事实；观察回调异常独立隔离，
  不占用 admission、ledger 或 native-event 的失败出口。

## 小范围本地计时（用户裁决）

本轮不实现端到端 TTFT。现有 publisher 使用 snapshot/recovery，Renderer
TTFT observer 明确排除快照；不为埋点重写投递协议，也不将旁路通知当首输出。

- 指标名为 `bridge_native_first_output_ms`：从 CommandRouter 收到有效发送
  信封（进入串行 admission 前）到 bridge 收到该轮原生首个非空可展示文本、
  思考或完整工具调用。记录原生通知到达时刻，不把 eventTail 排队误算为生成时间。
- 只为携带现有 `ttft` 上下文的桌面本地空闲新轮和 createSession.firstInput
  建样本。保留 observationId/commandId/真实 threadId/turnId 和进程 instanceId。
  Queue、Guide、打断重发、retry、恢复与无法唯一归因的输入明确 excluded。
- 使用 bridge 的同一单调 epoch 时钟；不是 Codex 内部精确 TTFT，不细分模型
  服务、网络或请求重试耗时。空 reasoning/text start、心跳和状态不算首输出。
- 首输出只收口一次；后续失败不反转成功。首输出前失败/中断保留已等待时间；
  五分钟缺终态标 unclosed，不伪造 timeout/failed。
- 经现有严格 stderr 诊断白名单进入 Host 本地 info 日志，不进入 conversation
  snapshot、composer 或云端。诊断 IO/通知失败不能影响 admission/输出。

## 所有权、顺序与容量

```text
CommandRouter receipt → 原 ledger admission → 原 native turn/start
        └── observation context                 └── 响应真实 turnId
native notification receipt → 原 eventTail → ThreadStateStore（事实权威）
        └── 到达时刻                └── observer（派生事实、报告水位）
observer → bounded fact queue → 既有 Host telemetry fan-out
         └── allowlisted diagnostic → Host 本地日志
```

观察器是命令关联与诊断生命周期的唯一 owner；不持有 accepted queue、会话正文
或第二份历史。进程 eventSeq 单调增长（每个 session 的子序列同样单调），eventId
包含进程 instanceId，重启后不复用旧身份。最多 128 个输入/轮次、每轮最多 128
条待归因事实、通知出口最多 512 条；输入、未归因轮次及终态记录五分钟回收，
已绑定的活动轮保留到终态（仍受 128 轮上限约束）。容量丢弃聚合诊断，不回压业务。
工具/流式去重键同样有界，超限不继续声明精确计数。只有实际实时 turn/started
才能启动事实生命周期，冷读取和 hydration 不制造生命周期。

## 验收

Bridge 所属原生测试覆盖六类 schema、通知早于 ACK、真实 turn 关联、Queue/Guide
不改前轮归因、空开始不计时、重复/乱序、秒/毫秒、工具缺时间戳、稀疏/重复/倒退
用量、多会话/重启隔离、history 不生成事实、容量/过期与出口失败不影响业务。
服务侧沿用既有诊断 parser 回归。小范围计时不要求 Renderer snapshot 收口；
真实 Electron/原生运行验证与单包假端口测试分别记录，不互相替代。

2026-11-02 验证：bridge 观察器回归 16/16、命令维护屏障回归 3/3；
真实原生 smoke 校验六类允许的事实出口、本地首输出诊断以及重启后 eventId 不重复。
该诊断不是线上性能基准，也不代表已完成真实 Electron/手机端到端 TTFT 验收。
