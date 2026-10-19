# Codex desktop workflow history

## Outcome

Codex exposes an independent, read-only projection of native thread turns. It is not a Dynamic Workflow (DWF) run model and must not populate or mutate the legacy `workflowRuns` projection. The bridge owns every projected fact; Host and UI only forward, gate, and render it.

## Contract

- Wire method: `v4/codex/conversation/historyRuns`.
- Parameters:
  - `sessionId` (required): native Codex thread id.
  - `limit` (optional, 1–100, default 50): maximum returned rows.
  - `status` (optional): filter by projected `running | completed | failed | interrupted | unknown`.
  - `beforeTurnId` (optional): stable pagination cursor. A page is the matching turns before that native turn id, newest first.
- Result:
  - `runs`: projected native turns, newest first.
  - `nextBeforeTurnId`: present only when an older matching turn exists.
  - `atSeq`, `atRevision`, `atLogEpoch`: bridge projection watermarks at query time.
  - `source`: `native-thread` when facts are available.
- A projected run contains only observed or directly derivable values:
  - `runId` is stable as `codex-turn:<threadId>:<turnId>`.
  - `threadId` and `turnId` are native ids.
  - `status` maps `inProgress → running`, `completed → completed`, `failed → failed`, and `interrupted → interrupted`. A turn whose source facts cannot establish one of those outcomes projects `unknown`; it never guesses success.
  - `startedAtMs`, `completedAtMs`, and `durationMs` are optional and omitted when native timing is absent.
  - `toolChain` preserves item order and labels command executions, MCP tool calls, and file changes. An unrecognized native item projects an `unknown` tool-chain entry rather than being dropped or mislabeled.
  - `fileChangeSummary` is derived only from completed native `fileChange` items and counts paths, additions, and deletions from native diffs.
  - `result` is the latest native final-answer agent message in the turn, bounded by the protocol.
  - `failure` is derived from native turn error data.
  - `usage` is omitted unless a future native fact makes per-turn usage derivable. Cumulative thread usage is never copied to an individual turn or represented as zero.
  - `artifacts` contains only completed file-change paths. It does not claim DWF published artifacts.
- No mutation method is added. Start, resume, cancel, rewind, and DWF controls remain outside this surface.

## Ownership and event order

```text
native thread/read + thread/turns/list
  → ThreadStateStore (single projection cache/owner)
  → history-run pure projection
  → v4/codex/conversation/historyRuns
  → Host read-only forwarding
  → UI capability-gated summary
```

- The query uses the existing read-only conversation client path and does not establish another runtime, queue, or accepted state.
- The bridge serializes native events through `ThreadStateStore`; the query takes an atomic snapshot of that owner's state.
- The query is stateless and timeout-retry safe. Repeating identical parameters returns the current authoritative projection for that window.
- `beforeTurnId` refers to a native turn identity, not a row id or DWF run id. After reconnect it remains valid when that turn still exists. If history has changed and the cursor source no longer exists, the query fails with an explicit missing-history-cursor error; clients restart from the first page. It never silently merges pages across changed history.
- Filters and pagination apply after native turn validation but before projection size truncation. They never cause additional native writes.

## Capability and UI rules

- `runtime/capabilities.codex.readOnlyWorkflowHistory` is the only UI gate. Host hello copies that object unchanged.
- Missing, unsupported, or unavailable capability means no query is issued and the UI shows an explicit unavailable state.
- The UI presents the surface as “Codex thread history”, with status, timing, tool chain, result, failure, sparse usage availability, and derivable file artifacts.
- The UI must say that this is a projection of Codex thread history, not a complete DWF equivalent, and must not render DWF start/resume/cancel controls.
- Capability support does not imply legacy `workflowRuns` support. That remains explicitly unsupported, and Host must not advertise or synthesize `workflowRunDeltas`.

## Failure semantics

- A deleted or foreign workspace thread is an explicit read failure; no synthetic unknown run is emitted.
- Invalid native history fails schema validation rather than being coerced into success or zero values.
- Missing optional facts remain absent. In particular, absent usage, timing, result, file changes, and artifacts are unavailable, not measured zero.
- Old bridge/Host/UI peers simply do not know the method or capability and expose nothing.

## Acceptance scenarios

1. Completed, running, failed, and interrupted native turns project their observed status and sparse facts.
2. A source whose terminal outcome cannot be established projects `unknown`; unrecognized items remain visible as unknown tool-chain facts.
3. Missing source/thread fails explicitly and creates no run.
4. Filters and `beforeTurnId` pagination are deterministic; repeated/reconnected identical reads are safe, and a vanished cursor fails explicitly.
5. Missing capability prevents the query and renders unavailable in UI projection.
6. The legacy `workflowRuns` state remains absent for Codex, `workflowRunDeltas` remains unadvertised, and no DWF mutation controls are exposed.
