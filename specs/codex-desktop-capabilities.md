# Codex desktop capabilities

## Outcome

Codex desktop exposes controls through one additive, version-tolerant capability contract. bridge facts are authoritative, trusted service owners may expose actual end-to-end paths, and Host hello/UI are projections. A missing capability field means `unsupported`, never an inferred success from a command error string.

## Capability contract

The bridge implements `runtime/capabilities` on the same dispatch surface used by operations. Its result contains a required `codex` object. Each feature has exactly one state:

- `supported`: the bridge can dispatch the operation and observes its success/failure semantics.
- `degraded`: the bridge can provide a bounded, non-parity implementation or observation.
- `unsupported`: the bridge does not provide the feature.

Required features and initial states:

| Feature                      | State                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `auxiliaryTextGeneration`    | `supported` when bridge auxiliary dispatch is active                    |
| `observedSessionUsage`       | `supported` for native thread usage facts                               |
| `observedAppUsage`           | `supported` only when App Usage exposes and renders those observations  |
| `sharedContextContentCopy`   | `degraded` only when the trusted Host resolver is installed             |
| `scheduledPromptAutomations` | `supported` (native turns use durable run correlation)                  |
| `nativeBrowserCuaMcp`        | `unsupported`                                                           |
| `readOnlyWorkflowHistory`    | `supported` (independent native-turn history query)                     |
| `safeDesktopFileRewind`      | `supported` (Desktop-owned transaction with read-only Codex projection) |
| `legacyWorkflowRuns`         | `unsupported`                                                           |

Disconnect has no capability projection: the previous explicit state may remain cached for display, but a fresh read is `unavailable`. Host and UI must not synthesize support while the authority cannot answer.

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
- Capability-unavailable: show an unavailable state and issue no doomed operation.
- Capability status is stable while a connection remains active. UI refreshes after lifecycle `available` and after restart/`transportReplaced`; the subscriptions coexist because stable Local Host transport replacement is emitted only on the restart channel.

## Acceptance scenarios

1. Bridge authority reports every required feature exactly once.
2. Host hello is byte-equivalent to the bridge `codex` object.
3. An old hello omits `codex`; the UI resolves every feature to unsupported.
4. An unavailable bridge read produces an unavailable state, not support.
5. Legacy workflow delta control is hidden/disabled and no client workflow-delta declaration is sent.
