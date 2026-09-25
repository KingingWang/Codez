# Codex native Browser/CUA MCP

## Scope

This feature exposes the Desktop-owned in-app browser to Codex as the fixed native MCP server
`codez-desktop-browser-cua`. It does not recreate Codex execution, tool admission, or browser
ownership. Codex remains the execution authority; Codez only brokers the local browser capability.

This checkout's `@codez/codez-cua` package is an API-compatible placeholder. Its runtime reports
unavailable and fails closed. Consequently the combined capability is never `supported`; it is
`degraded` when the native Browser path is available and `unsupported` when it is not.

## State ownership and boundaries

`BridgeRuntime` remains the sole capability authority through `runtime/capabilities`. UI derives
support only from Host hello; it never probes methods, parses error strings, or treats an MCP status
as capability truth.

Desktop Main owns one process-wide native broker:

- POSIX: a deterministic Unix domain socket under the OS temporary directory.
- Windows: a deterministic named pipe under the user's pipe namespace.
- The endpoint is regenerated only at app restart. It is never selected by a Codex session.
- Main writes a random 32-byte token to a `0600` file under Desktop user data. The token is never
  placed in Codex config, UI, logs, or descriptors.
- Every endpoint request is validated with the native request schema, size-bounded, and authorized
  by timing-safe token comparison.
- Main dispatches strict `BrowserCommand` values through `BrowserGuestManager`. It returns the
  existing strict `BrowserCommandResult`; it does not expose filesystem or arbitrary process
  execution.
- Main selects only a live local application window, excluding CUA indicator and update windows. If
  no eligible window exists, the request fails closed as `backend_unavailable`.
- The broker closes during app quit. Requests that arrive afterward fail with `backend_unavailable`;
  they are never transformed into success.

Desktop Main exposes a single fail-closed readiness future covering both socket listen and token-file
write. Local Host initialization waits for that future to settle, then snapshots the broker's current
availability facts; endpoint/token failure settles unavailable and must never block or reject Host
startup.

The bridge artifact exposes a separate `bridge.cjs native-browser-cua-mcp` stdio MCP entry mode. It
authenticates each request by reading the configured token file. Its environment contains only:

```text
ELECTRON_RUN_AS_NODE=1
CODEZ_NATIVE_BROWSER_CUA_ENDPOINT=<stable endpoint path>
CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE=<stable token file path>
```

It must never receive `CODEZ_NODE_REPL_BROWSER_BROKER_SOCKET` or
`CODEZ_NODE_REPL_BROWSER_BROKER_TOKEN`.

Main injects only stable native availability facts into the Host bridge process environment. The
bridge capability parser derives:

- `unsupported` when either native environment fact is absent or invalid;
- `degraded` when the stable Browser path exists and CUA is unavailable;
- `supported` only when both Browser and CUA runtimes are actually available (not reachable in this
  checkout).

## Command and configuration contract

UI obtains a strict descriptor from Main using Desktop command
`GetCodexNativeBrowserCuaMcpDescriptor`. The descriptor reports whether the bridge artifact exists,
whether the Main service is running, endpoint/token-file paths, executable, command arguments, and
CUA availability/permission reasons. Missing command, malformed data, remote UI, or missing runtime
means unsupported/runtime-unavailable and disables native mutation.

For dev and packaged builds Main resolves the bridge artifact exactly as the Host bridge command
resolver does:

1. packaged `resources/codex/bridge.cjs`;
2. explicit absolute `CODEZ_CODEX_BRIDGE_PATH`;
3. repo-local `packages/codex-bridge/dist/bridge.cjs`.

The descriptor command is:

```json
{
  "command": "<Electron process.execPath>",
  "args": ["<resolved bridge path>", "native-browser-cua-mcp"],
  "env": {
    "ELECTRON_RUN_AS_NODE": "1",
    "CODEZ_NATIVE_BROWSER_CUA_ENDPOINT": "<endpoint>",
    "CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE": "<token file>"
  }
}
```

An explicit UI action performs exactly this sequence:

1. reject before writing when capability or descriptor is unavailable;
2. one `config/batchWrite` to the writable base user layer/version;
3. write only `mcp_servers.codez-desktop-browser-cua` with `mergeStrategy: "replace"`;
4. one `config/mcpServer/reload`;
5. read all pages of `mcpServerStatus/list`;
6. stop on the first failure and require an explicit refresh/retry.

The write is a whole-object replacement. `createSession.mcpServers`, per-session MCP overlays, and
environment overlays are prohibited.

## UI status taxonomy

The MCP panel reports all independent facts rather than collapsing them:

- runtime: installed, missing, service-not-running, or descriptor unavailable;
- configuration: configured with the exact fixed object or not configured;
- connection: `connecting`, `connected`, `disconnected`, `disabled`, or `failed`;
- authorization: native status/auth state remains distinct from connection state;
- start/tool failure: process-start failure, tool listing failure, and tool error remain visible;
- CUA: runtime and permission unavailability explain the combined degraded state;
- capability: unsupported, unavailable, degraded, or supported as projected by Host hello.

Configured-but-runtime-missing is shown as runtime missing and never as connected. Authentication
failure is reported as authentication/start failure, not as a connection inference about Browser
support. Unsupported and unavailable paths disable the install action; no doomed native mutation is
issued.

## Failure semantics

- Invalid request schema: reject without dispatch and return `invalid_request`.
- Invalid/missing token: return `authentication_failed`; never dispatch.
- Broker unavailable/shutting down: return `backend_unavailable`.
- No local owner window: return `backend_unavailable`.
- Browser command rejected by schema: return `invalid_request`; do not call the manager.
- Manager failure: return the strict Browser result exactly.
- Config write/reload/status failure: preserve the native error, stop immediately, and do not retry.
- App restart replaces the endpoint; Codex reload or a later explicit retry establishes the new
  process. Stale endpoint requests fail closed.

## Permissions

There is no per-request OS accessibility grant in this implementation. Browser command policy is
the existing `BrowserGuestManager`/executor URL and command boundary. CUA remains unavailable with
its runtime/permission reason surfaced. A future CUA runtime must connect through the existing CUA
permission broker; it must not bypass that broker by virtue of being Codex-owned.

## Event order

```text
explicit UI action
  -> descriptor validation
  -> config/batchWrite (fixed name only)
  -> config/mcpServer/reload
  -> paginated mcpServerStatus/list
  -> projected UI status
```

There is no background write loop, automatic repair, or timed retry. A user-visible refresh only
rereads state; it does not mutate Codex config.

## Acceptance scenarios

1. Browser available, CUA unavailable: Host capability is `degraded`; UI explains Browser-only
   degradation and still allows explicit configuration.
2. Native Main environment absent: Host capability is `unsupported`; install is disabled.
3. Old bridge or omitted capability: UI projects unsupported and never guesses from MCP status.
4. Missing bridge/service: descriptor fails before any Codex write.
5. Valid configure action: writes only the fixed server object, reloads once, then reads every
   status page.
6. Any operation failure: no automatic retry; user must refresh or retry.
7. Invalid endpoint token: endpoint returns `authentication_failed` and dispatches nothing.
8. Invalid Browser command: endpoint returns `invalid_request` and manager is not called.
9. No eligible local window: endpoint returns a strict failed Browser result, never success.
10. Remote workspace/runtime: native mutation is unavailable/disabled even if a same-name server is
    present in Codex config.

## Migration boundary

Only the fixed `mcp_servers.codez-desktop-browser-cua` key is owned by this feature. The installer
replaces that whole value and leaves every other MCP server untouched. Existing legacy Browser/CUA
plugin configuration and the per-session `node_repl` broker remain unchanged.
