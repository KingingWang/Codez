# Codex scheduled prompt automations

## Outcome

Codex scheduled automations are honest native-turn executions. Codez owns definitions, enable/disable state, trigger history, single-flight claims, and schedule advancement. Codex owns thread creation, turn admission, queueing, tools, execution, and native history. This first version supports only a scheduled prompt: no off-peak execution claim, tool restriction emulation, cancellation, or attachments.

## Ownership and event order

```text
Automation scheduler
  claim definition → stable runId → create pending ledger row → dispatch request
  → never redispatch a run that has native-send evidence or a terminal state

Host automation dispatcher
  capability gate → resolve/create native thread → prepare native turn
  → ledger maps (workspaceKey, runId) → sendText commandId/client message id = runId
  → explicit ACK/history observation → atomic ledger transition
  → Codez run history/outcome projection
```

The `automation_runs` table remains scheduler-owned definition history (`claimed`, `dispatched`, `failed_to_dispatch`, `skipped`, plus display outcome). The separate `codex_automation_correlations` table is the only native-correlation state owner. UI and scheduler read projections; neither keeps an alternate accepted execution truth.

## Durable migration

Tasks-index SQLite migration `0004_codex_automation_correlations` is additive and idempotent. Fresh and old databases gain the table and unique index `(workspace_key, run_id)`. Running the migration again does not rewrite rows or change its ledger checksum. Old runs remain valid scheduler history and are never backfilled as native correlations: absence means no native execution evidence.

Each row maps `(workspace_key, run_id)` to `command_id`, `thread_id`, and `turn_id`, with `state`, `error`, and timestamps. `command_id` is always the projected run id. `thread_id` is written before native send once a target thread is resolved; `turn_id` is filled when observed or reconciled.

## Correlation state machine

- `pending`: claimed and prepared, with no native-send evidence. It may become `accepted` on explicit native acknowledgement, `failed` on explicit rejection (before any side effect), or `unknown` when a send may have occurred but its outcome is lost. Scheduler restart leaves `pending` unchanged and requires reconciliation, never an automatic resend.
- `accepted`: Codex admitted the command and the mapped turn is authoritative. Connection loss does not rewrite it. It may become only `completed` or `failed` from an observed/reconciled terminal turn.
- `unknown`: admission is ambiguous. Reconciliation queries Codex history by run-derived command id and mapped thread. It becomes `completed` on reconciled success, `failed` on reconciled failure or explicit pre-send rejection discovered by history, and `failed` when the target thread is deleted/unrecoverable. No evidence leaves it `unknown`; it is never resent.
- `completed` and `failed` are immutable. Late events, duplicate claims, duplicate ACKs, and duplicate scheduler terminal settlement are no-ops. Deletion observed after a terminal state never rewrites it.

There is no cancelled state or cancellation transition. Disabling or deleting an automation stops future claims only; a native turn already in flight continues to native completion/failure.

## ACK loss, restart, and reconciliation

The native send occurs at most once per `(workspaceKey, runId)`. A transport failure, timeout, duplicate admission result, process restart, or bridge ACK loss after ledger preparation transitions the row to `unknown`. Reconciliation searches the mapped thread history for a user message/turn whose `sourceCommandId` equals the run id. A terminal turn resolves `unknown` (or advances `accepted`) idempotently. A missing thread is failed only while non-terminal; a missing thread after a terminal state is an audit fact, not a state change.

The scheduler suppresses duplicate dispatch and terminal settlement using the correlation state. Late native terminal events remain valid and settle at most once. History deletion is audited only after the correlation is terminal.

## Native command boundary

Codex native commands contain text, model selection, mode/collaboration intent, and the run id as command/client message id. They do not contain `automationId`, `offPeakTaskId`, `toolDisallowlist`, `modelExecution`, off-peak execution fields, or attachment claims. Task-index attribution may retain the Codez automation id for grouping/navigation, but it is never sent as native execution context.

Capability `scheduledPromptAutomations` is `supported` only when all native dispatch, command idempotency, and history-correlation operations are available. A missing or failed capability read is treated as unsupported and prevents the side-effectful send; a bounded implementation reports `degraded` with its reason.

## UI surfacing

The desktop app renders the automations page directly; it must not gate the whole page behind the blanket "Codex adapter unsupported" notice. Scheduled prompts are supported on the Codex adapter, so `automations` is not a Codex-unsupported settings section. Tabs that depend on server-side gray configuration keep their own gating: the off-peak tab stays hidden unless the off-peak gray config enables it (or non-terminal tasks exist), and the saved-workflows tab stays hidden unless the dynamic-workflow gray config enables it. Template loading failure keeps the manual creation entry.

### Model selection for scheduled prompts

The selected automation workspace owns the model-catalog target. The UI's workspace-scoped model-selection hook passes its `workspacePath` and optional `workspaceIdentity` in the existing `ModelSelectionViewInput.workspace` together with the form's selection. The Codex Host reads `config/read` and `model/list` for that target; the legacy Host ignores the workspace field. No separate renderer catalog or writes to workspace defaults are permitted.

```text
select project → resolve its Host and workspace identity → read Host model view
  → show available models and preferred selection → validate fields → enable Create
```

Changing projects invalidates the previous model selection and view; a late response from the previous Host must not enable creation for the new project. Missing target, failed reads, or a catalog without a selectable model keep Create disabled and show the existing unavailable/error state. An explicitly selected model and its reasoning level must be preserved on refresh; the form must not synthesize a missing Codex effort.

## Acceptance scenarios

1. Migration `0004` succeeds on old/new databases, is idempotent, and enforces `(workspaceKey, runId)` uniqueness.
2. Scheduled and manual run ids stay stable across scheduler retry and project to the native command/client message id.
3. Duplicate claim or duplicate host dispatch cannot create a second native turn.
4. ACK loss becomes `unknown`; no resend occurs until history resolves the run.
5. History success/failure resolves `unknown`; deleted/unrecoverable threads fail only non-terminal runs.
6. Restart retains pending, accepted, unknown, and terminal rows; terminal rows are immutable.
7. Every unlisted state transition is rejected and terminal rows ignore late/deletion events.
8. Disable/delete affects future scheduling only; native completion and failure settlement remain idempotent.
9. Missing/degraded capability prevents native send and leaves a recoverable scheduler state rather than fabricating execution.
10. In a local Codex project with a native default model, opening Create shows the Host's models; completing title, schedule and prompt enables Create, and submission carries the selected native model. Switching to a second workspace reads its own model catalog without using stale choices. An unavailable workspace keeps Create disabled with an actionable read failure.
