# V4 Conversation API Retry Status

## Summary

V4 conversation must show the model API retry status from
`ConversationSnapshot.control.apiRetry` at the bottom of the current running
turn. Main sessions and read-only Subagent sessions share the same timeline
presentation. The composer no longer renders this status.

The retry authority belongs to the CLI `ProductProjection`. The renderer only
renders the current session snapshot and must not infer retry state from request
logs, elapsed time, or local network observations.

## Behavior

```text
Agent/runtime retry event
  -> ProductProjection
  -> ConversationSnapshot.control.apiRetry
  -> SessionPane
  -> ConversationTimeline current live turn
  -> ChatApiRetryStatus
```

- `apiRetry: null` renders no retry label.
- A non-null retry state renders only in the current running turn's tail slot,
  after the turn's existing assistant work.
- The retry label replaces the generic `ChatLoading` indicator while retry is
  active; the two statuses are never rendered together.
- The active retry label keeps the running Thinking label's `text-ui-base`,
  `font-medium`, and shimmer motion, but lowers its visual weight with the
  semantic `foreground-subtle` peak color. It deliberately reuses the base
  shimmer's low-alpha soft stop so the moving trough remains visible; Retry
  therefore avoids Thinking's pure black/white peak without flattening the
  animation contrast.
- Historical turns never receive the current `apiRetry` state. If there is no
  running live turn, the renderer does not attach the status to an older turn.
- `model_retry_scheduled` sets the retry state for every runtime-classified
  retryable provider/network reason, not only HTTP 429.
- Core SSE stream recovery (`StreamRecoveryStarted`,
  `StreamRecoveryRetryStarted`, or a recovery-tagged model request) uses the
  same state. `retryNumber/maxRetries` is converted to the V4
  `attempt/maxAttempts` shape.
- V4 keeps `maxAttempts` in the protocol shape. The UI displays retry count, so
  `maxRetries = max(maxAttempts - 1, attempt)`. For example, `maxAttempts=11`
  converts an attempt to the `1/10` user-count shape. Every non-null counted
  retry state renders that count, including the first retry.
- A retry state may carry the latest bounded `errorDetail` and `errorStatus`.
  The renderer keeps this detail transient and exposes it from the retry label
  in a popover; it is not written as a transcript row or durable session error.
- `nextRetryAt` is computed with the CLI event clock. The current timeline does
  not render a countdown because a single snapshot is not a ticking clock.
- Existing i18n keys remain the only user-facing copy source:
  `chat.apiRetryStatus`. Moving the status into the timeline keeps the former
  composer copy: `重新连接中... x/y` / `Reconnecting... x/y`.

## Retry count and latest error presentation (2026-10-20)

只要 `apiRetry` 是 counted 变体，UI 就显示当前重试次数；`attempt=1/2`
不能被降级成通用 `ChatLoading`，否则用户无法判断 429 等错误是否正在持续恢复。
这里的 `attempt` 是投影层已经转换后的“第几次重试”，不是原始
`maxAttempts` 总尝试次数。

当状态携带非空 `errorDetail` 时，重试文案变为可点击触发器。浮窗显示最近一次
重试失败的错误响应摘要，并可包含 `HTTP nnn`。没有详情时仍显示普通状态文案，
不生成空浮窗；状态更新后浮窗内容跟随最新快照替换。

```text
ProductProjection.control.apiRetry
              |
              v
      TurnChatLoadingSlot
        | counted -------------------> Reconnecting... x/y
        | errorDetail present --------> clickable retry label -> latest error popover
        | no counted state -----------> ChatLoading (only when the turn is otherwise loading)
        | progress / terminal --------> apiRetry cleared
        v
  current live turn only
```

计数和详情都由同一个 `control.apiRetry` 所有者提供；不得在
`normalizeCodezApiRetryStatus`、`ProductProjection`、service tracker 或 protocol schema
中把早期重试改成 `null`，否则会丢失恢复态，影响 snapshot、desktop continuous 和
mobile replayable 的恢复一致性。若当前 turn 被权限/问答/maintenance 阻塞，
仍遵守现有 loading gate。

## State lifecycle

```text
model_retry_scheduled / stream recovery
                 |
                 v
       apiRetry = current retry
                 |
       +---------+-------------------+
       |                             |
       | next request started        | retryable request failed
       | (no model progress yet)     | before scheduling
       |                             |
       +---------- keep -------------+
                 |
      first meaningful model progress
      (text/reasoning/tool lifecycle)
                 |
                 v
          apiRetry = null

request completed / non-retryable failure / turn terminal / next turn
                 |
                 v
          apiRetry = null
```

`model_request_started` for adapter attempt 2+ does not prove recovery and must
not clear the label. A non-empty text/reasoning delta or meaningful tool event
does prove user-visible progress and clears it. This prevents the status from
flashing off during the retry request itself.

## Delivery and isolation

```text
                         +-> desktop-continuous
one CLI projection -----+
                         +-> web-remote-replayable
```

- `control.apiRetry` is session-scoped. A background session cannot overwrite
  another session's timeline status.
- Both delivery profiles receive the same control state. Continuous versus
  replayable only changes delivery/backpressure behavior; it does not create a
  second retry authority.
- A replayable snapshot may restore an in-progress retry. Relay, Electron main,
  and host routing do not own or synthesize the retry state.
- Retry is runtime-memory state: renderer refresh, task switching, and mobile
  reconnect within the same CLI runtime may restore an active retry from the
  snapshot; a CLI/runtime cold restart clears it.

## Boundaries

- `control.apiRetry` 增加可选的 `errorStatus` 与有界 `errorDetail` 字段；
  详情只保留在当前运行态，不写入持久化 transcript。
- No retry transcript part or timeline row is persisted. The display is a
  transient live-turn slot driven only by `control.apiRetry`.
- The existing `retryNotice` row remains reserved for user-triggered assistant
  retry semantics and is not reused or extended.
- No changes to send, queue, stop, or row retry behavior.
- No changes to retry count, backoff, retry classification, or final-failure
  behavior. Fault catalog cases such as N03/N04 still own those decisions.
- Retry count, backoff, retry classification, clearing boundary, and final-failure
  behavior remain unchanged. The change only removes the renderer's early-attempt
  hiding rule and adds a transient details popover.
- No changes to desktop `desktop-continuous` or mobile
  `web-remote-replayable` delivery semantics.
- Read-only Subagent detail still forbids manual retry commands; showing the
  provider retry status does not make the timeline interactive.

## Regression evidence

- Projection tests must cover adapter retry schedule, attempt start retention,
  meaningful progress clearing, request terminal clearing, and core stream
  recovery.
- The projected snapshot must pass the V4 runtime schema.
- The same `state.updated` retry delta must survive both delivery profile
  filters.
- Timeline tests prove `maxAttempts=11` renders `1/10`, `2/10`, and `3/10`,
  retry status replaces `ChatLoading` for every counted attempt, a supplied
  `errorDetail` renders a clickable latest-error popover, and `apiRetry=null`
  renders nothing.
- Read-only `SessionPane` tests prove child details receive the same state while
  the composer remains absent.
- The SAT25 desktop fault-stream E2E exercises both owners in one run: Main
  observes `1/10` and `2/10`, opens the latest-error popover, then observes
  `3/10` before clearing on the successful tool response; the spawned child
  observes the same counted retry in its read-only detail pane and clears on
  text progress.

## Implementation status (2026-10-20)

1. `TurnChatLoadingSlot` 对所有 counted retry 直接渲染 `ChatApiRetryStatus`，
   不再按 attempt 隐藏计数；Codex 原生重试继续只显示上游报告的计数。
2. counted 与 Codex retry state 都可携带当前失败的有界详情；点击状态文案打开
   最新错误浮窗，进度或终态清理后详情随状态一起消失。
3. projection、协议 schema、legacy task compatibility 和 i18n 同步扩展；
   retry 详情仍是运行态，不进入 transcript 或 durable session error。
4. 回归测试覆盖早期计数、详情投影、popover 触发器和 native retry 生命周期；
   SAT25 fixture/manifest 同步验证 Main 与 child 的可见计数和详情。
