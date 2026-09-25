# Codex desktop safe file rewind

## Outcome

Desktop owns the rewind transaction and durable recovery record. Codex supplies only immutable turn/file-change projection plus the conversation revision/row guard. The renderer may preview and explicitly confirm, but never writes workspace files or infers capability from errors.

## Capability and ownership

```text
Renderer preview/confirm
  → Desktop file rewind service (single transaction owner)
       ├── Codex bridge: immutable file-change projection + revision guard
       ├── durable ledger under workspaceKey
       └── scoped workspace backup/restore (no blanket Git operation)
```

- `safeDesktopFileRewind` is advertised only when the Desktop-local default Codex bridge and registered transaction owner are both present. Desktop-attached remote, mobile replay, non-default bridges, missing/old/degraded/disconnected/failed capability reads, and unregistered owners resolve to unsupported/unavailable and issue no doomed request.
- The bridge advertises the row-level `canRewindFiles` action on a `turnHeader` row only when that turn is in a terminal state, has at least one projected file change, and its projected changes are not already `reverted`. The renderer combines the row action with capability support and handler presence; the action alone never authorizes a transaction.
- Native `fileChange` entries describe `add` and `delete` kinds with the complete file body as raw content, not unified hunks. The bridge projection converts them into equivalent full-range line patches (`add`: all `+` lines; `delete`: all `-` lines) so per-turn addition/deletion counts are real and an added file's preimage reconstructs to empty (rewind deletes it). A `delete` change restores only through the fail-closed path this batch: the missing live file is reported `checkpoint_missing` and never fabricated from the projection. Unified-hunk `update` entries keep hunk parsing; when a `kind` field is absent the entry is treated as an update for backwards compatibility.
- Identity is `workspaceIdentity?.trim() || workspacePath`. The identity string is recorded in the ledger; a later request must match it exactly. Path fallback is valid only when no identity was originally recorded.
- The preview digest is computed from the canonical projection: revision, log epoch, row target, affected paths, actions, operation counts, and tool names in fixed order.
- The transaction service has one in-flight transaction per workspace key. A confirmed transaction is idempotent by confirmation id.
- A successful transaction owns a Desktop reverted-projection overlay. The service records the guarded session/row/entity target plus the resolved immutable turn id, notifies the bridge's projection overlay after terminal `success`, and the bridge validates the row still maps to that turn before projecting its file changes as `reverted` while retaining counts. The bridge overlay is runtime-derived state: it is not reconstructed by scanning the workspace or by guessing another process's ledger location. The notification bumps conversation projection seq/revision and republishes a full snapshot after the transaction receives the overlay acknowledgement, invalidating terminal caches without rewriting Codex history or the file-change facts. Retrying the same successful confirmation after a bridge restart may replay the overlay from the retained ledger turn id; absent that explicit retry, restart does not claim an unproven recovered projection.

## Preview and transaction order

1. Query Codex with `sessionId`, row target, revision, and log epoch. Any stale revision, missing row, or projection error fails read-only.
2. Build an affected-path preview. A path is safe only when its projected operation is a text `ApplyPatch`, its live entity is a regular file or expected-missing file, the path stays inside the workspace, and the immutable projected patches can reconstruct the pre-turn content. Any untracked/type-changing/external/binary/unsupported projection makes the whole preview `canApply: false`.
3. After explicit UI confirmation, atomically write the `confirmed` ledger containing confirmation id, exact workspace identity/path, target, revision guards, preview digest, backup identity, and affected paths.
4. Atomically copy each current regular file to the immutable backup directory, then verify every backup byte hash and record `backup-complete` with those hashes.
5. Re-read every affected live file and require its hash to equal the recorded baseline. Any mismatch is a read-only failure.
6. Mark `restoring`, then restore only preview-listed paths from validated projected preimages. Never invoke `git reset --hard`, a path-less `git restore`, or any workflow-history mutation.
7. Mark `restored`, hash every restored path (or verify expected deletion), then atomically write terminal `success`. `failed` before mutation and `needs-manual-recovery` after possible mutation are also terminal for automatic processing.

## Failure and crash semantics

| Observed ledger state             | Safe next action                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| no ledger                         | start a fresh preview/confirm flow                                                             |
| `confirmed`                       | no workspace mutation has occurred; revalidate and create backup                               |
| `backing-up`                      | retain any complete backup files; discard only an unverified partial staging tree and recreate |
| `backup-complete`                 | baseline recheck may resume; no mutation has occurred                                          |
| `restoring`                       | mutation may have occurred; retain backup/ledger and require manual recovery                   |
| `restored`                        | verification is read-only and may rerun, then write `success`                                  |
| `success` / pre-mutation `failed` | immutable no-op for later requests                                                             |
| `needs-manual-recovery` / unknown | no automatic mutation; inspect ledger paths, hashes, and backup                                |

Every failure retains the ledger and, after backup completion, the backup. Backup and ledger writes are staged then atomically renamed. A ledger that cannot be parsed or validated is treated as `unknown`, never repaired by writing workspace files.

## UI contract

- Desktop uses the same preview dialog and requires the explicit destructive Confirm click; cancel before confirmation creates no ledger.
- The undo entry requires both capability support and `previewFileRewind`/`applyFileRewind` handlers. Unsupported, unavailable, old-host, and read-only views disable or hide the entry and do not call apply.
- Status reports the terminal outcome and retains actionable failure text. Any post-confirmation failure names the retained ledger/backup location and says automatic retry is disabled.

## Acceptance scenarios

1. Successful scoped restore records the ordered states and final success.
2. Canceling the dialog or losing capability before apply creates no ledger/backup/mutation.
3. Stale revision, missing target, unsafe projection, path escape, identity mismatch, binary/type change, missing target, baseline mismatch, backup verification failure, and restore verification failure fail closed without unsafe mutation.
4. Every adjacent crash boundary observes the documented next action; restart never auto-continues `restoring`, `needs-manual-recovery`, or unknown.
5. A legacy path-only checkpoint is migrated to the workspace-keyed ledger, but cannot be claimed after an identity is recorded; a blank identity remains local path fallback.
6. Old bridge/Host peers expose the feature as unsupported and UI sends no request.
7. A successful overlay marks the validated turn as reverted, republishes at a new revision after acknowledgement, rejects stale revision reads, and a same-ID retry can restore the bridge-derived overlay after restart without mutating files or history.
8. A turn whose only change added a new file projects real addition counts, advertises `canRewindFiles` after completion, previews with delete-the-added-file as the restore plan, and an applied rewind removes the file. A turn that only deleted a file shows real deletion counts while its preview fails closed as `checkpoint_missing` rather than restoring from projection.
9. Absolute native paths are accepted only inside the workspace; a sibling
   path with the same prefix and a parent traversal both fail closed. A
   full-content add must match its current text before the scoped delete.

## Current deployment boundary

The default Desktop bridge exposes the read-only projection/guard and Desktop provides the local Host transaction owner. Remote/mobile replay and non-default Codex bridges are not supported in this batch; their projections must remain unsupported rather than degraded.
