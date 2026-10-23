# Codex desktop runtime notices

## Outcome

Native Codex warnings and model-provider authentication recovery must remain visible in the same V4 conversation projection used by desktop and mobile clients. These notices are runtime observations, not durable Codex turns, synthetic chat messages, terminal errors, or retry state.

The pinned native notification vocabulary is:

| Native method                         | Scope                                                              | Projected content                                             |
| ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `warning`                             | `threadId: null` is workspace-global; a string targets that thread | `message`                                                     |
| `configWarning`                       | workspace-global                                                   | `summary`, optional `details`, optional source `path`/`range` |
| `deprecationNotice`                   | workspace-global                                                   | `summary`, optional `details`                                 |
| `guardianWarning`                     | required `threadId`                                                | `message`                                                     |
| `modelProvider/authRecoveryStarted`   | required `threadId` and `turnId`                                   | `provider`, `message`, phase `started`                        |
| `modelProvider/authRecoveryCompleted` | required `threadId` and `turnId`                                   | `provider`, `message`, phase `completed`                      |

Malformed or incomplete notifications are ignored without terminating the native event loop. Unknown future notification methods remain ignored.

## Ownership and event order

```text
Codex notification → bridge RuntimeNoticeStore → touch affected ThreadStateStore projection(s)
                  → existing BridgeSnapshots / subscription publisher
                  → additive ConversationSnapshot.runtimeNotices
                  → desktop-continuous and web-remote-replayable consumers
```

`RuntimeNoticeStore` is the only owner of this bounded, process-lifetime derived projection. It does not write native history, create a queue, persist a second session model, or issue RPCs. Workspace-global notices are retained for conversations loaded later in the same bridge process and are published to every currently loaded conversation in that bridge workspace. Thread-targeted notices are visible only through that thread's authorized conversation snapshot and are discarded when the thread is deleted or the bridge exits.

The native event handler applies the notice before touching the affected conversation. A global change touches every loaded conversation; a targeted change touches only its target. A notice arriving before its target is loaded may be retained within the bounded targeted cache, but cannot bypass existing workspace ownership checks when that conversation is opened.

## Wire contract

`ConversationSnapshot.runtimeNotices` is additive and optional for old snapshots and old senders. `StatePatch.runtimeNotices` uses the same whole-key replacement semantics as other A-region fields. New Codex projections always provide the array, including an empty array. Old receivers may strip the unknown key; new receivers treat an absent value as empty.

Each notice contains:

- a bridge-process-stable unique `id`, native `kind`, receipt timestamp `at`, bounded `message`, and optional bounded `detail`;
- optional `turnId`, `provider`, and `phase` for authentication recovery;
- no synthetic row, no change to `control.lastError`, `control.apiRetry`, queue admission, or turn status.

The snapshot carries at most 16 notices: the latest 8 workspace-global notices followed by the latest 8 notices targeted at that thread. Message and detail bounds are 4,096 and 16,384 characters respectively. The targeted cache is also bounded to 64 thread IDs. Identical consecutive notices in the same scope are idempotent. Authentication recovery upserts by `(threadId, turnId, provider)` so completion replaces the active recovery presentation rather than accumulating a stale independent warning; repeated identical phases remain idempotent.

No dismissal or durable acknowledgement is inferred. Restart recovery reads the new runtime's current snapshot; it does not replay notices from the previous process as Codex history.

## Presentation

The composer renders the snapshot notices above the input surface without blocking draft editing or submission. Warning-like notices use the existing warning surface; completed authentication recovery uses the success surface. Native text remains plain text. The UI derives everything from the snapshot and does not subscribe to a parallel desktop-only event channel, so mobile recovery shows the same content.

## Acceptance scenarios

1. A global `warning`, `configWarning`, or `deprecationNotice` reaches all loaded conversations and a conversation loaded afterward, without adding a row or changing `lastError`/`apiRetry`.
2. A targeted `warning`, `guardianWarning`, or auth-recovery notification reaches only its own conversation; a targeted notice received before loading appears after the existing authorized load.
3. Auth recovery started/completed preserves `threadId` through the containing snapshot plus `turnId`, `provider`, and `phase` on the notice; completion replaces the matching started item and does not clear or create API retry state.
4. Duplicate consecutive events do not advance a conversation revision. Capacity eviction stays bounded, malformed events do not fatal the runtime, and deletion removes targeted notices.
5. Initial subscribe, live recovery, resync, desktop-continuous, and web-remote-replayable all validate the same additive snapshot contract. An old snapshot without the field still parses and renders no notices.
6. The composer displays warning/detail and auth-recovery content as plain text while leaving the draft and send controls usable.
