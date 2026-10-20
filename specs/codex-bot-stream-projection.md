# Codex Host Bot 流式回复投影（v4 帧 → legacy session 事件）

Status: 实现于 2026-09-24。修复 codex runtime 下飞书等 Bot 通道发消息后
「会话里有回复、机器人侧什么都看不到」（流式卡片不创建、最终回复不发送）。

## 问题与根因

Bot 回复链路（`botsService.watchTaskStream`）消费 `CodezStreamEvent`，其上游是
`codezTaskServiceAdapter.onDynamicTaskEvent` →
`codezAgentService.onDynamicSessionEvent` → legacy `session/subscribe` RPC +
`session/event` 通知。

Codex bridge 刻意不实现 legacy 流式面（`session/subscribe` 直接报错
"Codex adapter does not support session/subscribe"），只发 v4
`conversationFrame` 通知，且只发**全量 snapshot 帧**（每次变更整帧重编码，
无增量 delta）。桌面 UI 走 v4 帧通道所以正常；legacy 读路径在 codex 模式下
完全无事件源，Bot 订阅重试 8 次后放弃，收不到任何
`agent_message_chunk` / `task_complete`。

## 所有权与边界

```text
Codex bridge（codex 事件 → v4 conversation snapshot 帧，唯一事实源）
  → codezAgentService.onDynamicSessionEvent（codex 分支）
      · 建立 v4 conversation 订阅（每 workspace+session 一条共享上游，引用计数）
      · TopicWireFrameAssembler 重组物理分片 → ConversationTopicFrame
      · codexSessionEventProjection 做**快照差分**，合成 legacy CodezSessionEvent
  → 既有 adapter mapServiceEvent / mapSessionEvent（零改动复用）
  → CodezStreamEvent → Bot watchTaskStream / Host mirror（taskRealtimePort）
```

- 新增 `packages/services/src/codez-agent/codexSessionEventProjection.ts`：
  纯函数式快照差分投影器，是唯一「v4 快照 → legacy session 事件」翻译所有者。
  无 IO、无定时器，可独立单测。
- `codezAgentService.onDynamicSessionEvent` 在 `usesDefaultCodexBridge` 时走新分支；
  legacy 模式行为不变。bridge 不新增任何协议面。
- 合成事件只使用既有 legacy 词表（turn.started / model.streaming / tool.updated /
  turn.completed / turn.failed），下游 mapSessionEvent、task index、runtime command
  收口逻辑不改。

## 投影规则（快照差分）

bridge 只发 snapshot 帧，因此投影器对相邻快照做差分：

- 行按 `rowId` 索引；`assistantText`/`reasoning` 行记录已发射文本长度，
  增长部分投成 `model.streaming`（`text_delta`/`reasoning_delta`）。
  同一内容重复到达（快照重发）不产生重复事件。
- `userInput`/`turnHeader` 行首次出现且属于新 turnId → `turn.started`
  （回合边界由行驱动，turnId 权威）。
- `toolCall` 行首次出现 → `tool.updated{kind:"scheduled"}`；
  状态进入 running → in_progress 更新；进入 success → `result`；
  error/cancelled → `error`。终态后不再发射。
- `turnHeader` 进入 completedSuccess/completedInterrupted/failed，或
  `control.phase` 进入对应终态（兜底）→ `turn.completed` / `turn.failed`。
  `turn.completed` 携带该轮 assistantText 全量拼接为 `response`；
  adapter 的 streamedTurnKeys 会在 chunk 已流式送达时抑制重复正文。
- 首帧快照是「追到 live 边缘」：历史行只登记不发射；state=streaming 的
  行发射一次当前累积文本作为起点。

## 事件顺序

```text
Bot sendPrompt → adapter 记录 activePromptInputId（既有）
Bot watchTaskStream → onDynamicTaskEvent → onDynamicSessionEvent(codex)
  → v4 conversation/subscribe（首帧 snapshot：登记基线，若有 running 回合补 turn.started + 流式尾巴）
  → 后续 snapshot 帧：text 增长 → agent_message_chunk（流式卡片更新）
  → toolCall 生命周期 → tool_call / tool_call_update
  → 回合终态 → task_complete / task_error（封卡、发最终回复）
订阅 dispose → 引用计数归零 → conversation/unsubscribe + 投影器销毁
```

## 合同与限制

- 合成事件 envelope：`eventId` 唯一（`codex-v4-<seq>-<i>`）、`turnId` 在回合内
  一致、`traceId` 回合内稳定（`codex-turn-<turnId>`），保证 adapter turnKey 一致。
- `includeSnapshot`（replayable 恢复路径）当前没有消费者
  （onDynamicTaskEvent 的唯一调用方是 Bot，bot-channel-continuous）；
  codex 分支不产生 snapshot 服务事件。手机 mirror 经 `onDynamicStreamEvent`
  全局 emitter 间接受益于同一投影。
- 订阅建立失败有界重试（3 次，300ms 退避）；最终失败记 warn 并放弃
  （与 legacy 重试耗尽后放弃的语义一致）。
- runtime 重启后订阅不失效重建：与 legacy「重试耗尽即放弃」对齐，由下一轮
  用户消息触发新订阅。sessions-index syncer 的终态事件仍会收口 runtime command。
