# Codex desktop capabilities

## Outcome

Codex desktop exposes controls through one additive, version-tolerant capability contract. bridge facts are authoritative, trusted service owners may expose actual end-to-end paths, and Host hello/UI are projections. A missing capability field means `unsupported`, never an inferred success from a command error string.

## Capability contract

The bridge implements `runtime/capabilities` on the same dispatch surface used by operations. Its result contains a required `codex` object. Each feature has exactly one state:

- `supported`: the bridge can dispatch the operation and observes its success/failure semantics.
- `degraded`: the bridge can provide a bounded, non-parity implementation or observation.
- `unsupported`: the bridge does not provide the feature.

Required features and initial states:

| Feature                      | State                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `auxiliaryTextGeneration`    | `supported` when bridge auxiliary dispatch is active                                           |
| `observedSessionUsage`       | `supported` for native thread usage facts                                                      |
| `observedAppUsage`           | `supported` only when App Usage exposes and renders those observations                         |
| `sharedContextContentCopy`   | `degraded` only when the trusted Host resolver is installed                                    |
| `scheduledPromptAutomations` | `supported` (native turns use durable run correlation)                                         |
| `nativeBrowserCuaMcp`        | `unsupported`                                                                                  |
| `readOnlyWorkflowHistory`    | `supported` (independent native-turn history query)                                            |
| `safeDesktopFileRewind`      | `supported` (Desktop-owned transaction with read-only Codex projection)                        |
| `legacyWorkflowRuns`         | `unsupported`                                                                                  |
| `autoReviewApprovals`        | `supported` only when native guardian approval is enabled and requirements allow `auto_review` |
| `messageFeedback`            | `unsupported` (native Codex exposes no per-message feedback API; only `feedback/upload`)       |

Disconnect has no capability projection: the previous explicit state may remain cached for display, but a fresh read is `unavailable`. Host and UI must not synthesize support while the authority cannot answer.

### Host hello capability ownership

`hostCapabilities` in the V4 `hello` has two owners, and they must not be mixed:

- The connection attachment owns only per-connection facts: `nativeDialogs` and `localTerminal` (derived from `clientMode`), plus `binaryFrames` and `compression` (negotiated by the relay link it sits on).
- The base runtime owns every backend-dependent key: `workspaceHookReview`, `independentPlanState`, `genUiContext`, `workflowRunDeltas`, `residentRowsRange`, `inputPrediction`, `codex`, `codexUnavailable`.

The attachment forwards a runtime-owned key only when the base hello states it `=== true`, and omits it otherwise. Omission is the protocol's own encoding of "not supported": `hostCapabilitiesSchema` documents these keys as wire-compatible with absence meaning `false`, and consumers must test `=== true`. An attachment must never hardcode a runtime capability to `true`, because that advertises support the base explicitly gated off for the Codex backend — phones would then preload `rowsRange` into a guaranteed `sessionNotResident` error and send `inputPrediction` into a guaranteed `-32601`, and the UI's explicit `genUiContextUnsupported` guard would never fire. All three degrade silently, so the lie is only observable as a feature that never works.

`inputPrediction` additionally stays behind the Host switch: the base advertises it only when the runtime is not the default Codex bridge and the remote input-prediction switch is on. A failed prediction query still degrades to an empty result (a ghost hint must never block input), but it now leaves a warning carrying the backend fact, so "the switch reads on yet hints never appear" is diagnosable.

Known exception: `historyFirst` is still declared by the attachment. The base gates it off for Codex together with the workflow keys, but the bridge does serve `v4/conversation/rowsRange`, metadata-only resume and cursor paging, so "the subscription ACK only means history is readable" holds on Codex. Whether the base under-advertises or the attachment over-advertises is unresolved; this key is deliberately left at its pre-existing value pending that decision.

## Ownership and event order

```text
BridgeRuntime dispatch → runtime/capabilities.codex
                      → Desktop-local Host hello capability projection (bridge + registered owner)
                      → UI hook/gating projection (copy only)
```

- No Host/UI feature matrix, method probe, or error-message parser may rewrite a state.
- A runtime method change must be reflected in the bridge-derived test fixture; Host/UI drift fails that contract test.
- Old bridge/Host/client peers with an omitted `codex` object are treated as fully unsupported.
- Existing coarse Host hello booleans remain compatibility-only and do not expand.
- Host must not advertise or forward `workflowRunDeltas` for Codex unless the bridge itself emits that projection. Batch A/B therefore omits it (`=== true` means support; omitted means unsupported).
- The service hello queries the default Codex bridge's `runtime/capabilities`, validates `codex`, and overlays only trusted service-owner facts. A failed discovery read emits `codexUnavailable: { reason: "bridge-unavailable" }`; an old bridge omits both `codex` and `codexUnavailable` and resolves every feature as `unsupported`.
- `sharedContextContentCopy` is degraded only when a trusted assembly explicitly marks the installed Host/service reader as authorized because the end-to-end path is visible content copy rather than reference parity. A function that always rejects (including the desktop-attached-remote unsupported ConversationShare wrapper) is not an owner fact. It remains unsupported in remote/mobile/legacy fail-closed service-assembly paths.
- `observedAppUsage` is supported only when the Desktop-owned cache has an explicit service query and App Usage renders that observation data; it never merges Coding Plan data.
- Connection-scoped Host hello calls the base service for the validated composite projection, preserves its own connection identity, and copies only `codex`/`codexUnavailable`; terminal callers cannot supply or rewrite either trusted field.

## UI rules

- `supported`: enable the control.
- `degraded`: show an explicit degraded reason and disable only the unsupported portion.
- `unsupported`: hide when the entry is optional, otherwise disable with the reason.
- Per-message like/dislike row actions are optional entries: when
  `messageFeedback` is not `supported` the renderer must not pass a feedback
  handler, so the buttons are absent instead of silently reverting after a
  doomed `setAssistantFeedback` command.
  This Codex gate applies only to the Desktop conversation surface. Shared
  Web/legacy conversation panes retain their existing feedback handler and do
  not query Codex hello solely for message feedback.
- Capability-unavailable: show an unavailable state and issue no doomed operation.
- General settings footers must not claim that the native Browser is available
  or degraded on every Host. The scoped Browser/MCP card alone reports the
  bridge-projected status; an unsupported or remote Host must never see a
  contradictory global availability claim.
- Capability status is stable while a connection remains active. UI refreshes after lifecycle `available` and after restart/`transportReplaced`; the subscriptions coexist because stable Local Host transport replacement is emitted only on the restart channel.
- Codex must gate the legacy `workflowRuns` discovery query on an explicit
  `legacyWorkflowRuns: "supported"` hello projection. `unsupported`,
  `unavailable`, a missing Codex projection, or a capability refresh in progress
  issues no legacy workflow-runs RPC. Non-Codex runtimes keep the existing
  retrying discovery query; Codex capability facts must not be synthesized from
  a legacy Dynamic Workflow implementation, mapped from another method, or
  inferred from a command error. Closing the gate invalidates the cached
  discovery answer; a later supported refresh must query the new runtime rather
  than reusing the previous runtime's journal result.
  The same gate covers restored workflow-run directory tabs and the remote
  native-Host detection pending window; those entry points must not fall back to
  a legacy query before the current target is known.

## Acceptance scenarios

1. Bridge authority reports every required feature exactly once.
2. Host hello is byte-equivalent to the bridge `codex` object.
3. An old hello omits `codex`; the UI resolves every feature to unsupported.
4. An unavailable bridge read produces an unavailable state, not support.
5. Legacy workflow delta control is hidden/disabled and no client workflow-delta declaration is sent.
6. Bridge projects `messageFeedback: "unsupported"`; conversation rows render no
   like/dislike actions and issue no `setAssistantFeedback` command.
7. The same shared conversation pane on Web/legacy retains like/dislike actions
   without a Codex capability object; unsupported or unavailable Desktop
   capability state must not disable feedback on that non-Desktop surface.
