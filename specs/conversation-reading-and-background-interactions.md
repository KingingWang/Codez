# Conversation reading position and background interaction reminders

## Product rules

- Each conversation pane owns its own transient scroll-following state. A user who scrolls
  away from the bottom keeps the current reading position when a new model turn starts,
  when streaming content or tool calls arrive, and when the virtualized timeline remeasures.
  A user at the bottom continues to follow new content. Explicitly clicking “back to bottom”
  resumes following; switching conversations restores that pane's existing scroll memory.
- Submitting another prompt or promoting a queued prompt does not implicitly override a
  user-chosen reading position. The first submission from a draft may still focus the
  newly created conversation.
- A pending permission, question, or plan approval in another conversation produces an
  actionable, localized in-app reminder in the current window when notifications are
  enabled. The action navigates to the waiting task; it does not answer on the user's
  behalf. The existing platform notification path remains available when the window is
  not focused. A request in the currently viewed conversation retains its dialog and
  existing snapshot-based notification behavior.
- Initial/recovered sessions-index snapshots are a baseline, not new alerts. Each
  subsequent interaction ID is announced at most once per observed transition. Resolved
  or replaced requests remove their outstanding reminder. Settings opt-out suppresses
  notifications, but does not change pending interaction badges or dialog behavior.

## Ownership and boundaries

```text
user wheel/keyboard/touch → pane timeline following ref → hold/follow scroll
model rows/remeasure ────────────────────────────────→ hold/follow scroll

CLI/Host pending interaction → sessions-index (conflated summary)
  → workspace notification observer (edge + transient toast ID)
  ├─ focused window: in-app action → existing task navigation → dialog
  └─ unfocused window: IPlatformService.showTaskNotification
conversation snapshot → current task dialog + its existing detailed notification
```

The CLI/Host remains the sole authority for pending requests and answers. The
sessions-index summary contains only interaction ID, kind, tool name and task title;
the observer neither stores answer data nor subscribes to background conversation
snapshots. Toast IDs and observed edges are renderer-local presentation state. Workspace
identity and endpoint scope follow the existing sessions-index registry; local path fallback
is unchanged. No protocol, persistence or replay shape changes are required.

## Ordering, failure and acceptance

- Bind the workspace RPC attachment, receive the initial index baseline, then compare live
  upserts by session ID and interaction ID. A repeat frame does nothing; a new ID supersedes
  the previous reminder. On resolve/removal/scope change, dismiss the old reminder. On
  reconnect the first live baseline must not replay old requests. Stale effects from an old
  scope must not notify the new scope.
- Desktop continuous and mobile Web replayable delivery both derive alerts from the same
  conflated sessions-index facts; replay/recovery is never interpreted as a new request.
  The current session still uses its conversation snapshot for actual reply authority.
- E2E: start a long-running task A, scroll upward through older text/tool calls, let the
  model start a new turn and stream more content. The viewport remains on the older
  content; “back to bottom” follows again. Repeat with an immediate prompt and a queued
  “send now” action while scrolled away.
- E2E: while viewing task B (and while a settings tab covers the workspace), make task A
  enter AskUserQuestion and then ExitPlanMode. An in-app reminder identifies A and opens
  its dialog on action; a repeated index frame creates no second reminder. Answering
  dismisses it. With the window unfocused, a platform notification is also eligible.
  A cold start with A already waiting does not generate a new alert, but its sidebar badge
  and dialog remain available. Test with notifications disabled and with remote reconnect.
