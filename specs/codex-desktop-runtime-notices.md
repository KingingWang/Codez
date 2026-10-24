# Codex desktop runtime notices

## Outcome

Native Codex warnings and model-provider authentication recovery are diagnostics only. They must be written to the existing Host service log and must not appear above the composer, in synthetic chat messages, or in the V4 conversation projection. These notices are not durable Codex turns, terminal errors, or retry state.

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
Codex notification → bridge bounded runtime-notice parser → bridge stderr diagnostic
                  → Host closed-payload parser and credential redaction
                  → existing service logger
```

The bridge parses each supported notification once and emits at most one bounded log diagnostic for it. It does not retain notices, touch `ThreadStateStore`, publish a replacement snapshot, write native history, create a queue, or issue RPCs. Workspace-global and thread-targeted notices use the same diagnostic path; targeting metadata is diagnostic context, not authorization to project content into another conversation.

The native event handler keeps supported notice methods outside the ordinary thread-state notification path so malformed notices cannot become native-event fatal errors. Unknown future methods keep the existing ignore behavior.

## Log contract

The bridge emits a single-line JSON diagnostic with an exact prefix. The Host accepts only the closed notice kinds and allowlisted fields, rejects malformed or oversized payloads, redacts credentials, and writes the result through the existing service logger. Warning-like notices use `warn`; completed authentication recovery uses `info`.

Each accepted diagnostic contains:

- native `kind` and bounded `message`;
- optional bounded `detail` for configuration and deprecation notices;
- optional `threadId`, plus required `turnId`, `provider`, and `phase` for authentication recovery;
- no configuration source path, synthetic row, `ConversationSnapshot.runtimeNotices`, `StatePatch.runtimeNotices`, or change to `control.lastError`, `control.apiRetry`, queue admission, or turn status.

Message and detail bounds are 4,096 and 16,384 characters respectively. The encoded diagnostic is bounded as well. Repeated native events are separate log observations; no process-lifetime notice cache or durable acknowledgement is introduced.

## Presentation and compatibility

Neither desktop nor mobile renders these diagnostics. The retired additive snapshot field is not emitted by the new bridge. If an older sender still includes `runtimeNotices`, current receivers strip it and the composer ignores it rather than displaying stale native text.

## Acceptance scenarios

1. A global `warning`, `configWarning`, or `deprecationNotice` produces one bounded service-log entry and no conversation frame, row, `lastError`, or `apiRetry` change.
2. A targeted `warning`, `guardianWarning`, or auth-recovery notification logs its allowed targeting metadata without entering that thread's snapshot or any other conversation.
3. Auth recovery started/completed preserves `threadId`, `turnId`, `provider`, and `phase` in diagnostics; completion logs at info level and does not create or clear API retry state.
4. Malformed or oversized events do not fatal the runtime or enter production logs. Extra non-allowlisted payload fields and configuration source paths are not accepted.
5. Initial subscribe, live notification, resync, desktop-continuous, and web-remote-replayable carry no runtime-notice projection and publish no notice-driven replacement snapshot.
6. The composer does not display native warning/detail or auth-recovery text, including when an older Host snapshot still contains the retired field.
