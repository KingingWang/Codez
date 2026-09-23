# Codex desktop adapter

Status: native desktop adapter implemented and validated on 2026-09-22, within
the capability and validation boundaries recorded in
`docs/codex-desktop-validation.md`. This is not acceptance of unsupported legacy
feature parity. A capability is not accepted until its test evidence exists.

## Scope

Replace the desktop's model execution with the unmodified `KingingWang/codex`
app-server, initially pinned to `codex-20260921-084453` / commit `40b83ea62f`.
All implementation and generated protocol artifacts live in this repository.
The adjacent Codex checkout is read-only reference material, never a build input.
Retain the desktop shell, Git, files, terminal and Host attachment routing.

## Ownership and boundaries

```text
UI draft → Host identity/lease route → Codex bridge command correlation → Codex RPC
                                                                     ↓
UI projection ← V4 snapshot/sequence ← bridge derived projection ← Codex events/history
desktop: continuous stream; mobile: replayable snapshot/gap repair; same authority
```

Codex owns threads, turns, tools, durable history, accepted queue items, account
credentials and effective configuration. The bridge owns protocol translation,
pending server requests, attachment staging and command correlation. Its conversation
and index projections are derived, not a second accepted queue. Main/Host/relay
retain process/routing responsibilities, not agent business state.

Use `workspaceIdentity?.trim() || workspacePath` for isolation; use workspacePath
only for execution and filesystem operations. Preserve remoteSessionId and trusted
connection scopes. Never start a separate agent for a mobile attachment.

The Host passes its already-resolved workspace key into the Codex process even for
local path fallback. Filesystem aliases (for example macOS `/var` and `/private/var`)
may resolve to the same execution directory; verify this asynchronously by realpath
before normalizing internal cwd inputs. Never normalize or equate explicit workspace
identities based on filesystem equality. Missing paths and foreign identities fail
closed, and native config/skills/plugin requests stay on the canonical execution cwd.

## Runtime contract

- Launch the selected native executable with `app-server --listen stdio://`;
  handshake `initialize` then `initialized` exactly once per connection.
- No shell interpolation, no Codez-only arguments passed to Codex, no stdin logging.
- Explicit experimental opt-in is necessary for queue and structured user input.
- Validate message envelopes and mapped payloads at runtime. Keep generated
  types bound to the actual pinned executable; version text alone is insufficient.
- Staging the pinned executable retries transient network resets, timeouts, 429
  and 5xx responses a bounded number of times after removing the partial file.
  Size/checksum mismatches and other 4xx responses fail closed without retry, so
  a runner-side CDN reset cannot waste a full native build and a tampered or
  truncated artifact can never be published.
- A failed or ambiguous mutation is not automatically retried. Reconnect reads
  authority and reconstructs projections. Do not promise crash-time exactly-once.
- Pending approvals are scoped to connection generation/thread/turn/request ID;
  late replies cannot approve another run. Unknown request kinds fail closed.
  Human approvals/questions have no default RPC deadline; an explicit interaction
  deadline is independent of the bounded ordinary RPC/write deadline.
- Native settings reads are method-allowlisted and cwd-scoped. Explicit foreign
  workspace identities are rejected even for the same local path; local callers
  without an identity retain the path fallback. Plugin paths must come from the
  native marketplaces visible to this attachment. Global account/configuration
  changes remain native-owned and are explicitly presented as global UI actions.
- Deleted threads cannot be resurrected by in-flight projection loads or authorize
  an old attachment. History/live merges use item identity and preserve terminal
  content against late start/delta notifications.
- Native queue contents are owned by Codex. Unsupported auto-drain/paused intent
  semantics must be reported, never silently acknowledged.
- Native queues automatically dispatch when idle (including cold resume). An
  explicit queue request is not a request to hold an idle turn. External queue
  entries retain their native IDs; unknown admission metadata uses documented
  unavailable display sentinels, not fabricated timestamps or client identities.
- Native `thread/queue/start` requires idle. The running-state UI must not offer
  legacy stop-and-promote semantics; separate interrupt/start mutations cannot
  safely emulate an atomic selection in the presence of native auto-dispatch.
- Queue/steer keep the native thread's effective settings. Reject per-input
  model/reasoning/mode changes that these native methods cannot honor; editing
  queued text preserves its existing image/non-text inputs. Reject legacy held
  queue dispositions, browser context and restricted-tool intents before mutation.
- Conversation revert does not imply file rewind. File rewind requires a separate
  preview and a supported safe implementation; never use destructive Git reset.
- Editing/retrying a historical input requires matching epoch/revision and stable
  row/entity, an idle turn, native `thread/revert`, fresh paginated history and a
  new epoch before `turn/start`. `workspaceMode: rewind` is rejected before mutation.

## Desktop surfaces

### Follow-up turn reliability and send latency

- Native item IDs are scoped to a turn, not a whole conversation. Presentation
  entity IDs encode `(turnId, itemId)` without collisions; native RPCs retain raw
  IDs. Repeated IDs inside one turn remain invalid. Resume and live projections
  use the same identity mapping, including edit/revert, tools and attachments.
  V4 pending interactions carry an additive optional `turnId`; native approvals
  populate it so repeated tool IDs cannot attach to another turn. Existing legacy
  interaction producers may omit it; reply authority remains in the broker.
- Session indexes have one entry per native thread ID even when multiple rollout
  files or pages describe it. Choose the most recently updated record; ties keep
  the first encountered record. Preserve first-encounter ordering and do not
  mutate or remove native history. Invalid records still fail validation.
- Codex remains the sole execution authority. Conversation event processing must
  not await sidebar index/configuration IO. The existing subscription publisher
  owns coalescing, sequence and stale-route rejection; no parallel event queue or
  retry of accepted mutations is introduced.

```text
native notification → ordered conversation state → conversation publisher
                  └→ independent sidebar invalidation → coalesced snapshot IO
desktop continuous / mobile replayable → same owner, separate existing routes
```

- Composer preparation reuses the existing workspace-scoped model catalog owner;
  a ready catalog must not be re-fetched on every send. Missing/invalidated state
  still awaits authoritative discovery, configuration changes invalidate it,
  and stale reads from another workspace cannot authorize sending.
  The hook keeps one scope entry and shares its in-flight read. Explicit settings
  config/account success invalidates all mounted catalogs before checking whether
  the settings panel is still mounted (native configuration is global). The UI
  invalidation signal carries no configuration values and is not an authority or
  a second cache. Focus/runtime restart remain refresh boundaries; invalidation
  is synchronous, and StrictMode replay/unmount cannot authorize stale readers.
- Fatal production diagnostics expose an allowlisted failure category and safe
  code-location information, never arbitrary native error text, prompts, paths,
  tokens or user IDs. Fatal execution/transport failures are not silently retried.
  Shutdown attempts native transport close even when derived-resource cleanup
  fails, and reports cleanup rejection through the same bounded diagnostic path.
- Regression acceptance: two sequential completed turns with reused item IDs;
  duplicate thread records within/across pages; deterministic selection; delayed
  sidebar IO while next-turn events flow; both delivery modes; close during an
  outstanding refresh; warm sends without extra catalog RPC; production failure
  diagnostics that exclude synthetic secrets.

Required: create/resume/list/fork/archive/delete/name, text/image input, streaming,
tool/plan/diff display, stop/steer/native queue, approvals/questions, account login
and logout, models/reasoning/permissions/configuration, skills/MCP/plugins, history
and process recovery. Independent Git/files/terminal remain available. AI Git
message generation uses a restricted auxiliary Codex conversation.

Git auxiliary model selection reads the target workspace's native `config/read`
(with cwd) and paginated `model/list` through `codexRequest`, not the legacy
Provider Runtime View. Effective configured model/provider/reasoning takes
precedence, including custom-provider models absent from discovery; when no model
is configured, use the visible native default. Missing selection, invalid native
responses or cyclic pagination fail before generation with no legacy fallback.

```text
Git request (workspace path + identity) → native config/catalog read
  → native selection → workspace/generateText → bridge restricted auxiliary turn
```

No additional selection cache or config writer is introduced. Native configuration
remains authoritative; the same workspace identity routes discovery and generation.
Default local/deployed Codex bypass legacy provider/account preparation throughout;
explicit legacy/custom resolvers retain their existing selection path. A failed
auxiliary mutation is never automatically retried. Tests use isolated temporary Git
repositories and in-memory native responses; they do not write developer settings.

Settings use Codex APIs rather than writing Codez's old provider/MCP/skill config.
Show effective configuration and actionable errors. Test fixtures must use an
isolated temporary Codex home; never mutate the developer's real credentials.
Preserve legacy Codez data; never claim text-only import is lossless migration.

Dynamic workflows, off-peak business behavior, cloud sharing, browser/CUA tools
and remote deployment require explicit parity evidence. Missing capabilities are
visible and fail closed, and remain unfinished scope rather than being counted as
completed merely because their controls are disabled.

## Acceptance cases

1. Missing/wrong executable: actionable startup error; shell still opens.
2. Handshake: reject pre-initialization use; concurrent request IDs resolve once;
   invalid/oversized frames and process death reject pending operations.
3. Chat: create, send, stream text/reasoning/tool, completion, resume same thread.
4. Stop/steer: expected turn guard; late stop cannot stop a later turn.
5. Queue: add/edit/reorder/delete/start, refresh after invalidation; no local clone.
6. Interaction: allow/decline/cancel, structured answers, stale/disconnected reply.
7. Recovery: duplicate notifications, gap snapshot, restart, ambiguous send without
   blind retry; desktop and mobile delivery semantics checked separately.
8. Settings: existing login, login cancel/failure, config read/write conflict,
   model capability choices, MCP/skills/plugin state reflects Codex.
9. Isolation: two workspaces, same path with different remote identity, two windows.
10. Installed app: native binary path, Unicode/spaces, terminal, graceful shutdown.

Evidence: targeted node tests, actual isolated app-server smoke, desktop interaction
smoke, pnpm typecheck/lint/architecture checks, and per-platform CI artifacts.

## Remote Codex deployment

### Project conversation discovery

Opening/adding a connected Codex project explicitly refreshes its native session
index, including conversations created by Codex CLI outside this desktop. A warm
connection is not proof that the persisted thread list is current. Discovery is
read-only, paginated, scoped to the execution cwd and the remote attachment's
existing workspace identity; it never copies history into a second execution store.
List all model providers explicitly (the pinned native server defaults to its
configured provider), and include user-facing CLI, editor, exec and app-server
sources, not subagent/internal auxiliary threads. Preserve archive/delete and
workspace isolation boundaries. Opening a discovered conversation resumes its
native thread ID through the existing command path.
Workspace membership is decided by physical directory, never by path spelling.
Codex persists two cwd representations for one thread: `thread/list` returns the
raw rollout value (the literal `thread/start` cwd, or the CLI `getcwd()` result)
while `thread/read` returns the canonicalized store value with Windows verbatim
prefixes stripped. The two can disagree for the same thread, so discovery
filtering, resume ownership and `thread/started` attribution canonicalize both
sides and keep a raw-equality fallback for directories that no longer exist.
Canonicalization must never widen ownership: relative input and genuinely
different directories stay rejected. Attribution needs filesystem resolution, so
native event projection is asynchronous; the runtime keeps one serialized event
tail so native ordering is unchanged, and request/response paths still project
their own turns synchronously.
Legacy `session/read`, `session/resume` and `session/list` projections must carry
both the authorized `workspaceKey` and explicit `workspaceIdentity`. Downstream
task-index persistence consumes `workspaceIdentity`, not `workspaceKey`; dropping
it would silently file remote conversations under a local-path partition. A fresh
native scan rebuilds the correct remote shell rows without deleting legacy data.

```text
project activation → scoped session/list → native thread/list
                          ↓ after response
existing index subscribers refresh → native thread/list
                                                          ↓
remote task-index syncer → insert missing shell metadata → workspace list invalidation
                                                          ↓
Window Host task membership + native live details → project sidebar
```

The remote task-index syncer is the only shell-index writer. Initial discovery
must publish one scoped list invalidation after newly inserted rows are committed,
and observers must treat that commit/invalidation boundary as asynchronous rather
than inferring it from a fixed number of event-loop ticks. It must not replay
historical terminal events or unread signals. Existing pin, archive, deletion
tombstones and custom titles remain authoritative shell state. Late results from
a disposed/replaced subscription cannot publish to a new owner.
Background list observers stay existing-only; explicit project activation may
start the configured runtime. Desktop continuous and mobile replayable clients
retain their existing connection/lease and recovery semantics.

Acceptance: cold remote project with CLI history and empty shell index; a new
desktop thread appears without restarting; reopening a warm project discovers
new external CLI history; cross-provider history remains visible; two remote
identities with the same path stay isolated; repeated scans preserve shell state
and do not replay completion/unread events; concurrent list consumers do not
replace each other's ownership; discovered history can be resumed.
The six-target release matrix runs the discovery/resume regression against its
verified native Codex executable with isolated configuration and a loopback model
fixture; ordinary adapter unit tests may skip that test before native staging.

The remote deployment owner remains `packages/server/src/remote`: reuse its pinned
per-platform release manifest, verified component installer and install-root lock.
For the Codex product (`CODEZ_DESKTOP_RUNTIME=codex` or compiled Codex flavor), use
`~/.codez-codex/server`; explicit `legacy` keeps the existing root and GLM pipeline.
The `codex-runtime` component mounts at `codex` and must contain `codex`,
`bridge.cjs`, and `distribution.json`. Its cache/live identity includes archive
SHA, not only a release tag. Missing files or failed installation cannot produce a
successful component marker. Node must report v24.14.0 before server startup.
Detect the target OS/architecture remotely: Linux/macOS x64/arm64 are supported;
WSL uses Linux artifacts regardless of the desktop host OS.

```text
remote detect → existing deploy lock → pinned manifest / verified components
              → Node + server + pty/tools + codex-runtime (no GLM)
              → remote-home-expanded startup env → existing stdio handshake
              → same workspace identity / Host owner / lease
```

Startup sets `CODEZ_CODEX_COMMAND=<runtimeRoot>/codex/codex`,
`CODEZ_CODEX_BRIDGE_PATH=<runtimeRoot>/codex/bridge.cjs`, and
`CODEZ_CODEX_BRIDGE_HOME=~/.codez-codex/bridge`, expanding remote home in the remote
shell, never the desktop home. Codez application data and bridge metadata are
isolated under `~/.codez-codex`; native Codex uses the remote machine's existing
home/config/auth resolution, without copying local credentials.
The service resolver consumes the deployed bridge path even without desktop
presentation context; missing explicit paths fail closed, with no legacy fallback.
Native model/plan selection, network environment and executable PATH are preserved;
legacy provider/account/browser/subagent preparation is not a Codex prerequisite.
Explicit `CODEZ_AGENT_SERVER_COMMAND` and custom legacy resolvers retain precedence.
Codex hello advertises independent plan state through native collaboration mode,
but never advertises the unsupported legacy workspace hook review mutation surface.

No new queue, identity, lease or transport owner is introduced. Desktop continuous
and mobile replayable delivery still use the same remote Host and bridge owner.
No ambiguous model mutation is retried by deployment. Targeted tests cover manifest
mounts, SHA refresh, incomplete/failed deployment, startup quoting, runtime choice,
and service preparation bypass. Live SSH/WSL parity remains a separate acceptance
claim until exercised against real targets.

### Packaged archive consumer

`DeployOptions.bundledRemoteAssetsDir` points to the read-only packaged
`codex-remote` root (also preserved by the shared Host-message schema). It contains
`releases/<appVersion>/manifest-<target>.json` and
`components/<target>/<id>/<sha256>.tar.gz`. Providing this root selects the bundled
source exclusively: missing/invalid manifest, wrong target/mount, corrupt archive
or incomplete extraction fails closed without legacy mock/CDN fallback.

The server consumer pins the manifest inside the existing deployment transaction,
validates SHA before extraction, and materializes requested components under their
declared mounts into the writable `remoteCacheDir`. Even the fixed `codex` mount
is isolated by target, manifest identity and requested component identities; no
extracted directory is shared between Linux/macOS or x64/arm64. Cache publication
is atomic, cached file contents are checked before reuse, and concurrent requests
share only a matching materialization. A canceled connection cannot proceed to
remote installation; independently shared cache work may finish safely.

```text
Desktop bundled root → validated Host option → remote target + pinned manifest
  → archive SHA → isolated staging/extraction → atomic target-scoped local cache
  → existing local-upload installer → existing remote lock/stdio lifecycle
```

Bundled archives use local validation/upload even when a saved SSH preference says
remote-download: packaged desktop files have no remote download URL. Non-bundled
legacy/CDN strategies are unchanged. Tests must use real tar archives and verify
cross-target isolation, bad SHA/mount/path rejection, cache repair/concurrency,
Host schema passthrough, and actual Linux packaged Node/server execution through
the consumer rather than substituting mocked installer methods.
