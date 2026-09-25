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

App Usage copy must state that Codex usage is desktop-observed telemetry and is not an official billing statement. It must render the Codex observation summary separately from agent-database usage: only observed threads and observed token fields are shown; absent facts stay unavailable rather than becoming zero. It must render cache-owned conflict and disconnect-staleness flags rather than inferring them in the renderer. Coding Plan remains an independent remote source and is never read or merged by this cache.

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
