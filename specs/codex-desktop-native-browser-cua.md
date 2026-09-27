# Codex native Browser/CUA MCP

## Desktop-only registration migration

The native browser MCP is a Desktop-only tool. The Desktop Main broker owns the live window
capabilities; each local window Host owns its Codex app-server connection; Codex still owns tool
execution. New registrations must be passed as process-scoped `-c` overrides when the Host's
bridge starts Codex, never written into the shared user `config.toml`.

Main binds each browser request to the live window from which its local Host originated. A
window-scoped capability is minted only after the broker is ready, has an independent token file,
and is revoked on window close. The broker derives the target window from that capability; a
request may not select an arbitrary `windowId`. The bridge keeps the existing validated MCP
stdio server and sends commands through the existing authenticated broker protocol. No new
browser command execution path or duplicate task/session state is introduced.

```text
Main broker ready → per-window capability → local Host init
  → workspace bridge spawn → Codex app-server -c (MCP server only in this process)
  → Codex MCP stdio bridge → token file → Main resolves live owner window → browser guest
window close → capability revoked → subsequent requests fail closed
```

The server is exposed to all threads in this local window's app-server, including resume and
mobile control attached to that same Desktop Host. Remote workspace runtimes, independent CLI,
and other clients never receive this temporary registration. A locally unavailable broker or
missing bridge artifact must fail closed without providing a misleading tool catalog. The MCP
server remains optional; broker failure must not prevent the whole Codex session from starting.
Only Main owns the window capability; UI configuration state is a projection, not a second owner.
Future Desktop-only tools may use the same process-scoped override mechanism but must supply
their own validated capability and lifecycle.

The previous installer wrote only the fixed `mcp_servers.codez-desktop-browser-cua` user key.
Existing global installations must be handled separately: remove that key only when its value
matches a known Codez-generated registration, preserving all other MCP entries and any manually
customized value. The UI reports an unmatched global entry as still shared but never offers
automatic deletion of it; it must not claim Desktop-only isolation until the shared registration
is gone. Configuration deletion is a one-time migration, never part of normal startup. Repeated
migration attempts and stale config versions must be safe and must not remove user edits.
The former "Install to Codex" UI changes to Desktop availability plus migration status.
The migration reads `config/read.layers`' user layer, never the merged effective `config`:
that merged view also contains the Desktop app-server's temporary `sessionFlags` override, even
after the persistent user entry is gone. If the user layer cannot be inspected, the UI warns
instead of treating the temporary server as a deletable legacy entry.

Acceptance cases:

1. Fresh local Desktop with no global registration: only its Codex app-server sees the native
   browser MCP; independent CLI and remote workspaces do not, even while Desktop is running.
2. Two Desktop windows: a request from A executes only on A; after A closes the same credential
   cannot operate B. B remains usable. Invalid, missing, or stale credentials fail closed.
3. Existing exact Codez-generated global entry: after scoped migration, CLI no longer lists the
   tool and other user MCP entries are byte-for-byte untouched; Desktop remains able to use it.
4. Customized same-name entry: no implicit deletion; UI says it is still shared and leaves it
   untouched for manual user review. A failed verified deletion leaves both config and status consistent.
5. Packaged and dev builds: process overrides use a validated absolute bridge artifact, quoted
   TOML values and a stable per-window endpoint/token-file path; no secret token in CLI args,
   settings, descriptor, logs, or screenshots.
6. Reconnect/resume and mobile remote control of a Desktop Host reuse the same window-scoped
   runtime. Closing the window or broker fails pending/new browser calls explicitly.

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

Desktop Main owns one process-wide native broker with a separate capability per local window:

- POSIX: a deterministic Unix domain socket under the OS temporary directory.
- Windows: a deterministic named pipe under the user's pipe namespace.
- The endpoint is regenerated only at app restart. It is never selected by a Codex session.
- Main writes a random 32-byte token per window to a `0600` file under Desktop user data, only
  after the endpoint listens. Token contents never enter Codex config, UI, logs, or descriptors.
  Endpoint and token files are removed on close only by the instance that owns them: a competing
  instance whose bind fails (for example a second app launch racing the single-instance handoff)
  must not overwrite or delete the live instance's credentials — otherwise every later MCP request
  fails `authentication_failed` and new MCP sessions cannot connect.
- Every endpoint request is validated with the native request schema, size-bounded, and authorized
  by timing-safe token comparison.
- Main dispatches strict `BrowserCommand` values through `BrowserGuestManager`. It returns the
  existing strict `BrowserCommandResult`; it does not expose filesystem or arbitrary process
  execution.
- Main selects only the live local application window bound to the supplied token. No fallback to
  another window exists; after its owner closes the request fails closed.
- The broker closes during app quit. Requests that arrive afterward fail with `backend_unavailable`;
  they are never transformed into success.

Desktop Main exposes a fail-closed socket readiness future; after it settles Main registers the
window capability and snapshots availability into its Local Host. Endpoint/token failure disables
only this optional tool and never blocks Host startup.

The bridge artifact exposes a separate `bridge.cjs native-browser-cua-mcp` stdio MCP entry mode. It
authenticates each request by reading the configured token file. Its environment contains only:

```text
ELECTRON_RUN_AS_NODE=1
CODEZ_NATIVE_BROWSER_CUA_ENDPOINT=<stable endpoint path>
CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE=<stable token file path>
```

It must never receive `CODEZ_NODE_REPL_BROWSER_BROKER_SOCKET` or
`CODEZ_NODE_REPL_BROWSER_BROKER_TOKEN`.

### Independent client isolation

Only the Desktop Host's bridge starts Codex with the process-scoped MCP override. Independent CLI
and remote workspace runtimes receive no new registration. Until the verified legacy global
entry is explicitly removed, however, other clients may still list that old entry. On
`tools/list` a missing token or unreachable broker yields no tools; individual calls still
authenticate. Closing one window revokes only that window's token.

The stdio entry must serve both eras from the same factory: Codex's MCP client opens with a
2025-06-18 legacy `initialize` (no envelope metadata), so `legacy` must be `"serve"` — rejecting
legacy openings fails the handshake (`-32022`) and the server never becomes usable. Era routing is
the SDK's; the tool definitions and validation above are shared by both eras.

The `browser_command` tool's advertised input schema is generated from the `browserCommandSchema`
subset restricted to `NATIVE_BROWSER_CUA_MCP_BROWSER_METHODS`. Codex's tool pipeline drops JSON
Schema union combinators (`oneOf`/`anyOf`) before the model sees the tool — observed live as the
model receiving `{"type":"object"}` and emitting empty arguments — so the advertised schema is a
flat object: a `method` enum plus every command field as an optional property
(`additionalProperties: false`, only `method` required). Same-name fields with conflicting shapes
collapse to their shared primitive type. Per-method required fields are documented in the tool
description cheat-sheet and enforced authoritatively by the bridge's pre-dispatch validation and
the Main broker (which share the same zod union and therefore cannot drift); the bridge rejects
schema-invalid arguments with field-path errors before reading the token or contacting the broker.

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

Normal startup never writes to Codex config. The only user-level mutation is explicit migration:
re-read the writable user layer and its version, verify the exact known Codez-generated entry,
then remove only this fixed key with `expectedVersion`. Mismatches and concurrent writes fail
closed. Future Desktop-only tools reuse the bounded process-scoped MCP list.

## UI status taxonomy

The MCP panel reports all independent facts rather than collapsing them:

- runtime: installed, missing, service-not-running, or descriptor unavailable;
- configuration: temporary Desktop injection, legacy global entry present, or unavailable;
- connection: `connecting`, `connected`, `disconnected`, `disabled`, or `failed`;
- authorization: native status/auth state remains distinct from connection state;
- start/tool failure: process-start failure, tool listing failure, and tool error remain visible;
- CUA: runtime and permission unavailability explain the combined degraded state;
- capability: unsupported, unavailable, degraded, or supported as projected by Host hello.

Configured-but-runtime-missing is shown as runtime missing and never as connected. Authentication
failure is reported as authentication/start failure, not as a connection inference about Browser
support. Unsupported and unavailable paths never trigger an installation write.

## Settings Browser section surfacing

The Settings → Browser section is Codex-supported and must not be gated by the unsupported-section
notice. Its browser-control entry is the same native card rendered in the Codex MCP panel: one
shared component owns descriptor loading, status classification, and explicit legacy cleanup,
so the two surfaces cannot drift. The legacy Browser Use plugin toggle is not surfaced for Codex:
`browser-use@codez-plugins-official` is a `.codez-plugin` manifest that Codex's plugin catalog never
lists, so a plugin toggle there would be a permanently disabled control. Chrome data import, the
insecure-certificate policy, and browser-data clearing are Desktop platform operations independent
of the agent adapter and remain in the section unchanged.

## Side pane surfacing

Browser tabs created through the native broker carry a window-specific synthetic owner scope
(`NATIVE_BROWSER_CUA_SESSION_ID`, workspace key prefix `NATIVE_BROWSER_CUA_WORKSPACE_KEY_PREFIX`)
because the MCP server is scoped to a window rather than to a Codez conversation. The
renderer keeps those exact values on the side-pane tab so guest attach validation in Main stays
consistent, but treats the tab as window-scoped: it matches any workspace and any conversation in
the owner window, and the pane reveals only when a native tab is newly created. Replayed or
restored ready events mount in the background and never steal focus.

## Failure semantics

- Invalid request schema: reject without dispatch and return `invalid_request`.
- Invalid/missing token: return `authentication_failed`; never dispatch.
- Broker unavailable/shutting down: return `backend_unavailable`.
- No local owner window: return `backend_unavailable`.
- Browser command rejected by schema: return `invalid_request`; do not call the manager.
- Manager failure: return the strict Browser result exactly.
- Legacy cleanup write failure: preserve the native error, stop immediately, and do not retry.
- Window close revokes its capability; stale requests fail closed.

## Permissions

There is no per-request OS accessibility grant in this implementation. Browser command policy is
the existing `BrowserGuestManager`/executor URL and command boundary. CUA remains unavailable with
its runtime/permission reason surfaced. A future CUA runtime must connect through the existing CUA
permission broker; it must not bypass that broker by virtue of being Codex-owned.

## Event order

```text
Main broker ready -> register window/token -> local Host init -> workspace bridge spawn
  -> app-server -c temporary MCP override -> tool request authenticates -> bound window
  -> window close revokes its token
```

There is no background write loop, automatic repair, or timed retry. A user-visible refresh only
rereads state; it does not mutate Codex config.

## Acceptance scenarios

1. Browser available, CUA unavailable: Host capability is `degraded`; the Desktop runtime alone
   receives the Browser tool.
2. Native Main environment absent: Host capability is `unsupported`; no MCP is injected.
3. Old bridge or omitted capability: UI projects unsupported and never guesses from MCP status.
4. Missing bridge/service: Local Host starts without the optional MCP.
5. Exact old Codez-generated config can be deliberately removed without modifying other entries.
6. Customized old config is never removed by automatic migration.
7. Invalid endpoint token: endpoint returns `authentication_failed` and dispatches nothing.
8. Invalid Browser command: endpoint returns `invalid_request` and manager is not called.
9. No eligible local window: endpoint returns a strict failed Browser result, never success.
10. Remote workspace/runtime: no Desktop MCP is injected even if a same-name server is present in
    Codex config.

## Migration boundary

Only the fixed `mcp_servers.codez-desktop-browser-cua` key may be removed during the verified,
explicit migration. All other MCP entries and the existing Browser/CUA plugin remain unchanged.
