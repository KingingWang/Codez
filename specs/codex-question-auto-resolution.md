# Codex 普通提问自动继续（issue #34）

## Feature Summary

| Field            | Value                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Developer intent | 修复 [#34](https://github.com/KingingWang/Codez/issues/34)：Codex 普通提问未执行已有五分钟自动继续设置                               |
| Capability       | `AskUserQuestion` / 原生 `item/tool/requestUserInput`                                                                                |
| Change layer     | validation、commit-effect、recovery、presentation                                                                                    |
| Operating mode   | implementation-handoff                                                                                                               |
| Primary seeds    | `InteractionBroker`、`BridgeRuntime`、`enqueueInteractionPreferenceSync`、`resolveDesktopRuntimePreferences`、`V4InteractionDialogs` |
| Out of scope     | 权限、MCP elicitation、`ExitPlanMode`、原生线程存储、任务队列、模型 I/O retention                                                    |

## 产品规则与原生接口

沿用 [普通提问契约](../docs/ask-user-question-auto-resolution.md) 的设置、60 秒静默期、
300 秒绝对 deadline、首次有效操作 snooze 与重新开启不追溯规则。普通原生问题仍投影为
V4 `kind=userInput`、`payload.toolName=AskUserQuestion`，不能改成 schema 不支持的
`kind=askUserQuestion`。计时资格按原生 request method 判断，不扩大到其他 userInput。

- bridge 的 `InteractionBroker` 是原生 pending 请求、计时资格和状态的唯一 owner。
  同一 broker 的注册、答案、暂停、设置和 timer callback 串行处理，先到先得。
- 只有同一 thread 的队首普通提问启动完整窗口；前面的权限、MCP 表单或 snoozed
  问题仍阻塞后项。不同 thread 不共享回答窗口。
- 默认开启；注册时冻结资格。关闭先撤销全部既有问题资格，将 active 状态转为
  `snoozed` 并清 timer，再 ACK。关闭期间注册的问题没有 deadline；重新开启不回填。
- 自动收口只回原生 `{ answers: {} }`，不猜选项、不自动批准、不伪造用户消息。
  正常 UI 提交仍要求逐题有效答案；空答案是 runtime 到期路径，不放宽普通用户回答校验。
  取消仍按原生取消响应收口。
- 原生 reverse-RPC ID 与 turn/thread 身份保持不变；标记 responding 并清 timer 后只写一次。
  原生 question ID 作为数据 key 处理，不能被 JavaScript 原型属性覆盖或误当作答案。
  共享历史详情也只读取 answers 的自有属性；`constructor` / `__proto__` 问题在空
  answers 下仍展示未回答，不能显示继承的函数或对象。
  写回结果未知时不重试；迟到 snooze 幂等 noop，普通重复答案保持 stale 防护。
- 正常答案、原生 `serverRequest/resolved`、turn 完成/中断及 bridge close 都清 timer。
  request 注册与 resolved / turn cleanup 在 stdio 消息到达时进入同一 broker 入口，
  不等待历史分页、目录归属或其他 thread 的投影 I/O。Native transport 在
  `serverRequest/resolved` 到达时已撤销回复权；投影阻塞不能延迟 owner 清理。
  live 历史观察按已有事件链等待 turn 锚点，但不阻塞 broker，不建立第二份 pending。
- `workspace/updateInteractionPreferences` 必须委托实际 broker，返回真实设置和 snoozed 数。
  没有 owner 的独立 control context 不得伪造成功。
- Host 和 renderer adapter 不再把 Codex 自动继续偏好强制归一为 false。
  full model-I/O retention 的既有 unsupported 边界保持。
- 未升级的默认 Codex bridge 若明确返回 `-32601`，Host 只降级这一可选设置能力，
  不让 attachment/Bot 初始化整体失败，不改为 false 或重试写入。旧 peer 不被宣称
  支持自动继续；其他错误和自定义 CLI 仍按原失败语义上报。

[OpenAI App Server 文档](https://developers.openai.com/codex/app-server) 明确允许客户端自动
处理 `item/tool/requestUserInput`，并由 `serverRequest/resolved` 通知收口。具体空答案和
模型续行格式必须由仓库固定的原生 Codex 版本动态验证，不能仅凭最新文档推定兼容。
产品五分钟不是 transport 的 RPC 超时；普通审批仍没有默认 transport deadline。

## State Owners And Commit Sinks

| State/fact                                | Draft/display owner    | Authoritative owner | Commit command/service                                                      | Persistence/cache         | Evidence             |
| ----------------------------------------- | ---------------------- | ------------------- | --------------------------------------------------------------------------- | ------------------------- | -------------------- |
| 开关                                      | Settings 的已保存值    | AppSettings         | 既有设置保存与广播 → Host 串行偏好同步                                      | setting 文件              | 普通提问契约         |
| pending / eligibility / deadline / snooze | V4 snapshot 的只读投影 | `InteractionBroker` | 原生请求、`resolveInteraction`、`snoozeInteractionAutoResolution`、偏好更新 | 当前原生连接 lifetime     | bridge contract      |
| 未提交原生答案                            | `CodexQuestionDialog`  | 当前表单            | 既有 V4 command                                                             | 只驻留组件，secret 不落盘 | Codex settings spec  |
| 结果与历史                                | 共享 Ask renderer      | Codex 原生工具结果  | 原生 reverse-RPC response                                                   | 原生 rollout              | 固定原生版本集成验收 |

固定版本 0.163.0 的公开 `thread/turns/list` / `thread/items/list` 不物化
`request_user_input`；真实进程验收已确认，不能靠假定存在 dynamic tool item 补历史。
历史适配采用以下只读派生，不扩大设置页 `codex/request` 白名单、不调用
`thread/inject_items`，也不修改 Native 源码：

- live 请求与成功写回在 `ThreadStateStore` 的可丢弃投影内，按原生 turnId/itemId
  合成同一工具展示；这只是 adapter 的 item 表示，不是新工具执行或历史写者。
- 冷加载在工作区归属验证后，仅流式读取原生 metadata 指向、且位于 CODEX_HOME
  rollout 目录内的文件；验证 session_meta.id，再根据原生 function_call /
  function_call_output 的显式 turn metadata 配对，保留原有 item 顺序。
- 仅恢复普通 `request_user_input`，不复活 pending 或 deadline；缺少可证明身份的
  旧记录不猜测。已终结轮次没有实际答案时展示 cancelled，不伪装仍在提问或成功；
  secret 的实际答案不进入展示投影。
- 无逐 token 全史扫描，无 bridge 持久化副本。历史替换后从 Native 重新派生；
  原生未来若提供同 ID item，则合并而非生成重复行。

```text
Settings → AppSettings → broadcast → Host 串行 preferences
                                          │
native request ────────────────→ InteractionBroker 串行入口
native resolved / turn end ────→          │  到达即清理，不等待投影 I/O
                                          │
                    注册资格 → 队首 startedAt
                                          ├─ 60s → visibleCountdown
answer / snooze / disable ─────────────────┤
                                          └─ 300s → respond({answers:{}}) 一次
                                                │
                           conversation + sessions-index 同一投影
                                                │
            desktop-continuous ─ live ───────────┤
            web-remote-replayable ─ snapshot/gap ─┘
```

## UI Surface Matrix

| User scenario | UI entry                                       | Shared implementation          | Display/draft owner | Default/inherit source | Validation/gating             | Commit action         | Authority/persistence | Mode boundary                   | Must remain isolated from           |
| ------------- | ---------------------------------------------- | ------------------------------ | ------------------- | ---------------------- | ----------------------------- | --------------------- | --------------------- | ------------------------------- | ----------------------------------- |
| 切换自动继续  | General Settings                               | 既有 Switch 与设置保存         | Settings            | AppSettings 缺省 true  | 不再屏蔽 Codex 偏好           | workspace preferences | broker                | 每个已连接 Host；不新建 runtime | retention、账号、模型配置           |
| 原生问题      | `V4InteractionDialogs` → `CodexQuestionDialog` | 既有 V4 snooze 与末分钟 hook   | 当前表单            | pending snapshot       | 普通原生问题；secret 只留内存 | resolve / snooze      | broker / 原生结果     | desktop + compact Web           | MCP、permission、Plan               |
| 后台等待胶囊  | 既有 `TaskInteractionBadge`                    | sessions-index pending summary | 只读摘要            | broker deadline        | 同一 interaction ID           | 既有 snooze           | broker                | continuous / replayable         | task 选择、排序、workspace identity |
| 已结束问题    | 共享 Ask 工具卡                                | 原生工具名的展示映射           | 原生历史投影        | 原生结果               | 仅普通 question 工具          | 无写入                | Codex rollout         | live / 冷读                     | 无伪造 user row                     |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces            | Deliberately different                     | Why it matters for this change |
| -------------------- | --------------------------------- | ------------------------------------------ | ------------------------------ |
| UI/component         | 绝对时间展示、V4 snooze、Ask 历史 | 原生 secret 表单不使用持久化 legacy drafts | 不复制 timer 或泄漏 secret     |
| Option source        | 原生问题输入                      | 普通 permission / Plan 仍用各自 schema     | 不猜测授权                     |
| Default/inheritance  | 同一个 AppSettings true/false     | 问题资格只在注册时授予                     | 不追溯旧问题                   |
| Validation           | 同一 workspace/turn/request guard | 正常答案与自动空答案区分                   | 不放宽用户校验                 |
| Commit effect        | broker 单次响应                   | 权限不自动处理                             | 不形成第二条业务写入           |
| Persistence/recovery | snapshot 与 native history        | reverse-RPC 不从 rollout 重建              | 不向失效原生连接回复           |

## Feature Relationships

| Rank           | From              | Semantic edge                   | To                            | Condition              | Why inspect it                             | Evidence                                                |
| -------------- | ----------------- | ------------------------------- | ----------------------------- | ---------------------- | ------------------------------------------ | ------------------------------------------------------- |
| must-inspect   | AppSettings       | syncs-runtime-preference-to     | Host / broker                 | local + cached remote  | 移除强制 false 并保留串行                  | `codezAgentService.ts`                                  |
| must-inspect   | broker            | projects-authoritative-state-to | conversation + sessions-index | 当前原生连接           | 后台与恢复读到同一 deadline                | `bridge-snapshots.ts`                                   |
| must-inspect   | native question   | renders-in                      | native dialog + Ask history   | 原生工具名             | 暂停与空答案历史可见                       | `V4InteractionDialogs.tsx`、`projection-item-extras.ts` |
| invariant-only | 同一 snapshot     | recovers-via                    | continuous / replayable       | shared Host            | 不改变 clientMode、owner/lease 或 identity | 原有订阅协议                                            |
| invariant-only | ordinary question | must-remain-isolated-from       | permission / MCP / Plan       | 非原生 question method | 绝不自动批准                               | bridge interaction 回归                                 |

## Must-Preserve Invariants

| Invariant         | Surfaces/modes                         | Proof needed                                  | Evidence     |
| ----------------- | -------------------------------------- | --------------------------------------------- | ------------ |
| 一次原生写回      | answer / deadline / disable / resolved | fake clock 与在途 response 竞争               | CSAQ34-03/04 |
| 单一绝对 deadline | desktop / mobile / remote              | 两种 delivery 的 snapshot / resync 与摘要相等 | CSAQ34-05    |
| 关闭与重开不追溯  | 所有既有问题                           | 多 pending、跨 deadline、新 registration      | CSAQ34-02/04 |
| 非问题不计时      | approval / MCP / Plan                  | 无 autoResolution，无 timer response          | CSAQ34-06    |
| secret 不落盘     | native dialog                          | 正常回答、metadata 更新与 localStorage 检查   | CSAQ34-07    |

## Codegraph Evidence

| Seed                               | Query                            | Direct callers / key path                             | Depth | Interpretation                                                                   |
| ---------------------------------- | -------------------------------- | ----------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `InteractionBroker`                | `codegraph status`；定向源码追踪 | `BridgeRuntime` → `CommandRouter` / `BridgeSnapshots` | 2     | 当前环境索引未初始化；这些源码尚未 indexed，使用精确引用验证，不声称有调用图证据 |
| `resolveDesktopRuntimePreferences` | 精确调用引用                     | renderer runtime preference hooks → Host sync         | 2     | 仅删除 Codex question false 投影                                                 |
| `CodexQuestionDialog`              | 精确调用引用                     | `V4InteractionDialogs` → 原生表单                     | 1     | 复用现有命令与倒计时展示                                                         |

## Graph Drift Candidates / Graph Delta

| Status    | Node/edge                                                        | Semantic reason            | Evidence      | Action                                             |
| --------- | ---------------------------------------------------------------- | -------------------------- | ------------- | -------------------------------------------------- |
| confirmed | `service.interaction-auto-resolution-runtime` native broker seed | 现有普通提问语义覆盖 Codex | #34 与本 spec | 增加 native seed / alias，不从静态可达推断其他功能 |
| none      | 其他关系                                                         | 未发现需新增的产品 owner   | 当前接口      | 不扩展图谱                                         |

## Clarification Log / Boundary Decisions

既有 Q09–Q14、Q23–Q25 与 issue 的期望已定义设置和事件语义，无需用户重复裁决。
只修复这些已接受规则，不扩展 optional user submit、跨端答案草稿同步或原生进程恢复协议。

## Dimensions / Candidate Combinations / Accepted Cases

| Case ID   | Setup                                         | Action                                                       | Assertions                                                                              | Evidence layers                   | Evidence status                 |
| --------- | --------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------- |
| CSAQ34-01 | 默认开启，原生队首问题                        | 0/59/60/180/299/300s                                         | 阶段和绝对时间正确；空 answers 单次成功；原生模型续行、历史“未回答，已自动继续”         | clock + native provider + history | passed：B / N / U               |
| CSAQ34-02 | active / queued / disabled registration       | 关闭、跨旧 deadline、重新开启                                | active snoozed，旧问题永久不计时；新注册队首完整窗口                                    | broker + control                  | passed：B / N                   |
| CSAQ34-03 | 静默 / 可见 / 末秒                            | 首次操作、重复 snooze、正常答案                              | 永久暂停、幂等、只写一次；未知写回不重试                                                | broker + browser                  | passed：B / U                   |
| CSAQ34-04 | 多 thread / 多 pending                        | 前项移除；deadline 与关闭竞争                                | thread 独立；仅队首；按 broker 顺序唯一收口                                             | fake clock                        | passed：B                       |
| CSAQ34-05 | 同一 pending 的两种 delivery                  | 刷新 / resync；设置暂停后 mobile 恢复                        | 相同 ID/绝对时间/snoozed；sidebar summary 同步；不新建 runtime                          | runtime wire                      | passed：B / N                   |
| CSAQ34-06 | permission、MCP form、计划交互对照            | 跨 300s，正常允许/拒绝                                       | 不自动回应，不附 deadline，授权选项不变                                                 | bridge；既有 Plan GUI 未重跑      | partial：B，Plan 为源码隔离核查 |
| CSAQ34-07 | 390/1200px、深浅主题、中英文                  | 面板 hover、键盘选择、输入、末分钟点击、metadata 更新        | 一次 snooze；focus 不暂停；保留答案；无溢出/业务异常；secret 不落盘；特殊 ID 不伪造答案 | production React + commands       | passed：U，保持 pending         |
| CSAQ34-08 | 原生 turn pending，其他 thread 的历史读取阻塞 | answer / native resolved / interrupted / close；阻塞期间注册 | timer 清理；迟到 callback 不写回；消息到达顺序不受投影 I/O 影响                         | broker + native runtime           | passed：B / N                   |

## Pruning Decisions / Unresolved Questions

- 权限、MCP 与 `ExitPlanMode` 无计时资格，以隔离对照覆盖，不做所有秒数叉乘。
- 题数、语言、主题与 runtime 竞态不做全排列；GUI 宽窄屏/主题/语言只验证共享展示。
- 不真实等待五分钟。fake clock 保留生产常量；原生动态验收只在 `CODEZ_ENV=test`
  下复用现有 `CODEZ_E2E_ASK_USER_QUESTION_CLOCK_SCALE`，生产忽略该注入。
- reverse-RPC 是原生进程 lifetime。renderer 刷新、手机恢复和远端 attachment 重连复用
  同一 live broker；不声称从旧 rollout 复活失效的原生 request ID。
- 未定义且会改变本次修复范围的问题：无。

## Planning Handoff / Matrix Backfill / E2E Handoff Notes

规格先于实现；catalog 与 matrix 登记 CSAQ34，运行后补真实 artifact，不自动晋级。
固定原生 Codex + loopback synthetic Responses fixture 证明自动空答案和续行，
fake clock 覆盖竞态与两种 delivery，pending browser case 覆盖真实组件和 V4 command。
原生 loopback 回归在 `Codez desktop` 的 Linux 独立提问验收步骤执行，使用本次 workflow
解析出的同一份 Native release manifest，不能让打包版本与验收版本分叉。
既有 bridge 单命令步骤仍保持精确命令和单次执行；新增提问验收也必须由
`scripts/test-codex-distribution-runtime.mjs` 精确断言，仅在 remote-assets 执行一次。
修改 workflow 后独立执行 `node --test scripts/test-codex-distribution*.mjs`，
不能用 pre-push 的零选中工程测试代替此 Node 门禁。
只把外部模型回复替换成 case-local fixture，不使用真实账号、地址或凭据；
浏览器覆盖不冒充实体手机、SSH 网络或原生 Electron 全链路 E2E。

工具详情展开的 ResizeObserver 提示单独记录：使用未改动的共享 Timeline/ToolLayout
与既有纯文本 Ask 展示路径做无 native pending/timer 的对照。不通过屏蔽业务异常
或修改倒计时来消除提示；功能断言、真正的 pageerror 与浏览器布局提示分开报告。
浏览器取证等待共享卡片的展开/淡入动画真正完成，并检查内容没有被动画高度裁切；
不能用 DOM 中已有答案文字代替可见详情验收。

## 2026-11-04 执行证据

- **B**：`packages/desktop/.e2e-artifacts/csaq34-verification-19dfMu`。
  完整 bridge 套件以 `tsx --test --test-concurrency=1 test/*.test.ts` 在所属包执行：
  836 passed / 4 skipped；最终四文件定向回归 102/102。
  默认并发的完整入口曾触发未改动 usage 测试的 60ms event-loop-lag 预算
  （82.4ms、87.7ms）；不修改预算，单文件及上述受控并发全套均通过。
  4 个跳过均是既有 opt-in Native 回归，不代表本次 Native 验收跳过。
- **N**：`packages/desktop/.e2e-artifacts/codex-question-native-Bi8LmR`。
  `node --test scripts/test-codex-question-auto-resolution.mjs` 1/1：
  仓库固定 `codex-20261020-001405` 的 `codex-cli 0.163.0`，隔离 loopback 模型；
  空答案成功续行、两种 delivery 同时间、共享历史、重启冷历史、关闭跨 deadline、
  重开不追溯、正常答案均执行。
- **U**：`packages/desktop/.e2e-artifacts/codex-question-auto-resolution-DPIXDl`。
  pending browser 5/5：四组宽度/主题/语言分别独立以 hover、真实输入、秒数点击、
  键盘选项作为首次意图；验证 59→1 秒、metadata 草稿保留、双击只回一次、
  secret 脱敏与不落盘、普通/自动详情完整可见，以及 `constructor` / `__proto__`
  问题的真实答案和空答案展示。第五组为未改共享卡片的 ResizeObserver 对照。
  布局提示已记录；业务 pageerror 与其余 window error 为空，不宣称浏览器零提示。
  另一次独立 agent-browser 操作证据在
  `packages/desktop/.e2e-artifacts/codex-question-auto-resolution-dxep6R`，已关闭会话。
- Host/Bot/remote 五个既有 Node 回归文件 22/22，UI 三个既有 Node 回归文件 75/75。
  完整命令输出在 B；不恢复已退役 App 单测。
- `pnpm typecheck`、`pnpm --filter @codez/desktop typecheck:e2e`、
  `pnpm lint`（106 条既有 warnings / 0 errors）与架构检查（0 violations）通过。
  全仓 `pnpm fmt:check` 有 1733 个未改动文件的既有格式失败；本次变更文件单独检查，
  不把全仓格式写成通过。feature graph 4 条 dangling edges 与 HEAD 一致，新增 0；
  codegraph 索引未初始化，不宣称索引验证成功。

未执行实体手机、真实 SSH 网络、全链路 Electron 或既有 `ExitPlanMode` GUI；
权限/MCP 的跨 deadline 对照与 Native 方法资格已由 B 验证，Plan 既有分支为源码隔离核查。
这些证据不改变正式 E2E 晋级/人工审核要求。

### 首次推送的 CI 门禁修正

`7c4e896d` 的 Android 与手机远控页面构建通过；桌面
`41840860430` 在 distribution 回归失败 1/97。确认原因是新增提问验收时把
既有 bridge 单命令改成多行，未同步 `test-codex-distribution-runtime.mjs:43`
的精确命令断言（0 !== 1）；此时提问 Native 回归尚未开始执行。
修正将新回归拆为独立 Linux 步骤，保留原 bridge 精确门禁，并明确检查新回归仅
执行一次、不复制到六平台 build job。此修正不改变提问实现、计时窗口或测试预算。

修正后 distribution 全套 97/97、`pnpm typecheck`、`pnpm lint` 与架构检查通过。
另用 CI 相同的 release resolver 选出完整 `codex-20261103-233208`
（`codex-cli 0.166.0`），再次执行真实提问验收 1/1：
`packages/desktop/.e2e-artifacts/codex-question-native-hzVBZd`。
B 的 `distribution-final.log` 和 `native-ci-release.log` 保存该次输出；
本地回退版与 CI 选中版均证明空答案、模型续行和冷历史，不依据版本号推定兼容。
