# Codex desktop usage observation

## Outcome

Codex usage displays only native facts emitted by Codex. Missing token, request, and tool counts are unavailable rather than zero. Session views show sparse cumulative thread usage. App Usage is a Desktop-owned local observation cache, exposes a separate Codex observation summary by workspace key, and is never merged with Coding Plan data.

## Session facts

`thread/tokenUsage/updated` and conversation snapshots may expose only safe-integer facts the bridge has observed:

- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- optional `contextWindow.usedTokens`
- optional `contextWindow.maxTokens`

Conversation snapshots expose the additive `usage.codexObserved` object for these facts. The legacy dense session shape remains compatibility-only. Its unavailable fields must display as unavailable; they are never normalized to zero. When `codexObserved` exists, the session context meter uses only its observed `contextWindow.usedTokens` and `contextWindow.maxTokens`; if either is absent, the meter shows no measured value instead of falling back to dense zero.

Per-turn header rows (`turnHeader`) may also expose an optional sparse `turnUsage` summary (`inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) representing the cumulative usage across all model steps within that turn. In the Codex adapter, each `thread/tokenUsage/updated` notification carries thread-cumulative `total` and single-request `last`; the bridge anchors the turn's pre-turn baseline (`total - last` on the first observed update for that turn, falling back to `last` when `total` is absent) so multi-step tool-calling turns accumulate across all requests in the turn while remaining idempotent against duplicate notifications. In the Codez CLI runtime, `ProductProjection` accumulates main-turn `ModelComplete` usage into `turnHeader.turnUsage` (and cold hydration synthesizes `ModelComplete` usage from persisted assistant message token metadata so restored sessions preserve both per-turn `turnUsage` and session `cumulative` usage).

In the conversation UI, each assistant turn status bar ("Worked for ...") displays a compact per-turn token summary and cache hit rate when `turnUsage` (or `outputTokens`) is present, with a hover tooltip showing the per-turn token breakdown (`inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`, and per-turn cache hit rate) alongside the current session's cumulative token summary and session cache hit rate. The composer context usage panel (`ChatContextUsage`) also displays the session cumulative token summary and always displays valid cache hit rates when present.

## Desktop observation cache

The cache owner is Desktop/Host services. The agent service observes validated conversation frames only: snapshot `usage.codexObserved` values reconcile authoritatively, while `state.updated` usage deltas follow normal delivery. It is keyed by `workspaceIdentity?.trim() || workspacePath`; `workspacePath` remains the execution/display path. The agent service exposes the retained snapshot/query by that same workspace key through the usage-stats service; renderer callers cannot supply cache contents or mutate observations.

The retained snapshot crosses the Host→renderer RPC boundary, whose object codec is JSON: JavaScript `Map` instances serialize to `{}` and lose their entries. The snapshot's `threads` collection is therefore an ordered array of `{ threadId, observation, conflict }` entries, never a `Map`. Renderer consumers normalize the value defensively (array, `Map`, or legacy object) because desktop/mobile renderers may attach to an older Host; an unrecognized shape degrades to an empty list plus a warn log, never a render crash.

Canonical identity bytes use fixed field order and stable object-key order:

```json
{
  "contextWindow": { "maxTokens": 0, "usedTokens": 0 },
  "inputTokens": 0,
  "outputTokens": 0,
  "workspaceKey": "",
  "threadId": ""
}
```

Only fields actually present in the sparse payload are serialized. The observation id is the SHA-256 hex digest of those UTF-8 canonical bytes. It never includes a native update id, timestamp, delivery connection, or request id.

## Delivery and reconciliation

```text
normal delivery: bridge state.updated deltas → per-thread latest-wins → duplicate no-op
reconciliation: authoritative conversation snapshot → replacement outside delivery order
```

For each thread:

1. An identical observation id is an idempotent no-op.
2. A distinct observation replaces the retained latest observation, even if cumulative values regress.
3. A cumulative regression marks the aggregate `conflict`; it is not merged or silently dropped.
4. A valid authoritative snapshot replaces the retained observation regardless of prior duplicates.
5. Reconciliation clears that thread's conflict when its value equals the delivered latest value; otherwise the conflict remains.
6. Reconciliation never clears a conflict caused by another thread.
7. Restart/reconnect replay first applies ordinary delivered observations and their conflict rule, then authoritative snapshots under the replacement rule.

Malformed/incomplete records remain sparse and do not invent values. Disconnect leaves the last observed cache usable but explicitly observation-stale; it must not mark new facts.

## UI boundary

App Usage copy must state that Codex usage is desktop-observed telemetry and is not an official billing statement. Setting's Usage section (`UsageStatsSection`) is unified as a pure local App Usage panel (`AppUsagePanel`) without remote Coding Plan quota/reset/monitor tabs, because providers are user-configured.

In the Codex desktop bridge runtime, `v4/usage/stats` aggregates local Codex persistence under `CODEX_HOME` (`~/.codex` by default: `state_*.sqlite` `threads`, `thread_history_*.sqlite` `thread_turns`, and session rollout `.jsonl` `turn_context` / `token_count` events) into the canonical `AppUsageSnapshot` contract:

- All-time summary metrics (`totalTokens`, `peakDayTokens`, `longestSessionMs`, `currentStreakDays`, `longestStreakDays`)
- 52-week token activity heatmap (`heatmap`)
- Time-range filtered (`7d`, `30d`, `all`) daily per-model token trend (`dailyModelUsage`) and per-model usage breakdown (`models`, including `inputTokens`, `outputTokens`, and optional `cacheReadTokens`)

`AppUsagePanel` renders the pre-fork four-section layout (lifetime summary strip, 52-week token activity heatmap, time range switcher `7d` / `30d` / `all`, daily model token trend chart with per-model breakdown tooltip, and model usage donut chart + breakdown list).

The Host-owned `CodexUsageObservationCache` and `CodexOnlyUsagePanel` remain available for explicit observation-race QA harnesses and isolated thread telemetry checks, where read responses stay scoped to the current workspace identity and Host service generation:
Read responses are scoped to the current workspace identity and Host service
generation. A later refresh, Host reconnect, identity switch or unmount
invalidates earlier pending reads, including their error/loading completions;
an old response cannot replace a newer owner projection.

```text
local CODEX_HOME (state sqlite + rollout jsonl) ─┐
                                                 ├─ v4/usage/stats → AppUsagePanel (summary + heatmap + daily model trend + model pie)
legacy agent DB (codez-cli sqlite) ──────────────┘
```

Acceptance: one observed thread + failed legacy usage source still renders the
Codex totals without an unrelated "unable to load" or "no usage data" alert;
an empty cache does not claim measured zero tokens; observation read failure
shows a Codex-specific error; Web legacy charts still render.
Delayed old-Host success or failure after a same-key reconnect cannot override
the newer Host's observation/error/loading state.
For a multi-thread aggregate, a token category is an exact total only if
every observed thread carries that category. If any thread omits it, render an
unavailable marker (`--`), not a partial sum or measured zero. A present native
zero is a valid measured value. This also applies to the shared observation
summary in legacy App Usage; it must not invent sparse Codex facts.
All five metric labels must remain legible at ordinary desktop and narrow
mobile widths in both supported locales. Wrap long labels; do not rely on
ellipsis to distinguish input/output from cache-read/cache-write facts.

The renderer imports usage snapshot types without evaluating the Host-owned observation cache. The public services barrel exposes these snapshot types as type-only exports; the cache and its Node crypto identity implementation stay in the Host service. The desktop shell must render the main navigation without Node built-ins in the browser module graph; the Host→renderer RPC snapshot remains the sole data path.

## Acceptance scenarios

1. Identity is deterministic for fixed canonical inputs, absent fields stay absent, and native update ids do not affect it.
2. Duplicate normal delivery is a no-op.
3. Newest delivery wins and regression becomes latest plus aggregate conflict.
4. Authoritative snapshot A replaces a regressed A→B stream and clears only A's conflict.
5. An unrelated conflicted thread remains conflicted after another thread reconciles.
6. Restart replay follows normal delivery first and authoritative replacement second.
7. Identity and path fallback isolate workspaces.
8. Runtime-unavailable retains the last cache but marks it stale; a new validated observation returns it to current.
9. App Usage renders observed totals plus explicit stale/conflict status while keeping agent-db and Coding Plan data separate.
10. The snapshot crosses RPC without losing thread entries, and a renderer attached to a legacy or malformed shape renders an empty observed summary instead of crashing.
11. Legacy in-memory Map entries have `{ observation, conflict }` values;
    normalization preserves the nested observation and rejects entries with
    missing or malformed payloads rather than passing them to the totals view.
12. A fresh isolated Electron renderer opens with visible navigation and no `node:crypto` browser-compatibility exception, even when usage cache types are imported.
13. At 1200px desktop and 390px mobile viewport widths, every observed metric
    label is readable without horizontal scrolling or hover-only expansion.
