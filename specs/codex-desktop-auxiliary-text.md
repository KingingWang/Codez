# Codex desktop auxiliary text

## Outcome

Auxiliary text generation is a restricted, one-shot native Codex operation. `BridgeRuntime` remains the only implementation and capability authority. Git commit-message generation is the initial caller and uses that same workspace runtime path, rather than a second provider/session or a legacy fallback.

## Contract

```text
caller → workspace/generateText → BridgeRuntime auxiliary owner
      → config/read (workspace-scoped)
      → ephemeral thread/start
      → exactly one turn/start
      → final agent message
      → thread/unsubscribe cleanup
```

- The auxiliary owner rejects duplicate operation ids and limits concurrent admission.
- The thread is `ephemeral`, read-only, non-networked, approval-free, has no environments, dynamic tools, or workspace roots, and uses exactly the selected provider/model/reasoning.
- Native configuration is read, never written. Model tools, MCP, hooks, plugins, agents, browser/computer use, shell, search, artifacts, and persistent context features are disabled. Existing MCP entries are individually disabled.
- Generation has a 30-second deadline, is cancellable by exact operation/thread/turn identity, and cleans up listeners and the ephemeral thread on completion, failure, cancellation, close, disconnect, deadline, or malformed native output.
- Caller cancellation uses `workspace/cancelGenerateText`. It never mutates an unrelated turn and never replays `workspace/generateText`.
- Git owns an operation-to-controller map on Host. The renderer sends a serializable workspace-scoped cancel command by `operationId`; no `AbortSignal` crosses the Git RPC boundary.
- Failure is terminal for that attempt. The service maps it to an actionable request failure and does not automatically retry or resume it.

## Capability and safety boundary

- `runtime/capabilities.codex.auxiliaryTextGeneration` is `supported` only when `BridgeRuntime` auxiliary dispatch is active. It is otherwise `unsupported`; missing capability fields and failed capability reads are treated as unsupported.
- Git reads the capability through the workspace runtime before account/model preparation. Unsupported, unavailable, malformed, or non-runtime paths fail closed with no `workspace/generateText` request.
- UI receives a capability projection from Host hello. It may enable generation only for `supported`; unsupported/unavailable states disable the control and show an actionable reason. Manual commit entry remains available.
- Generated text is treated as untrusted output. It is bounded, normalized, and validated as a conventional commit before use.
- Inputs are workspace-scoped and carry `workspaceIdentity` when present. Generation must never be admitted for a different execution path or identity.

## Acceptance scenarios

1. Successful generation creates one ephemeral thread and one turn, returns validated text, and unsubscribes without persistence.
2. Cancel, dialog close, runtime close, process disconnect, deadline, malformed/final-without-text output, unsafe tool activity, and oversized output fail closed and clean up.
3. A duplicate operation id is rejected before a second turn.
4. Capability unsupported/unavailable/malformed, legacy runtime, and disconnected runtime paths make no auxiliary request and show a disabled/degraded control.
5. Git generation issues no provider preparation or doomed native request and never automatically retries after failure.
