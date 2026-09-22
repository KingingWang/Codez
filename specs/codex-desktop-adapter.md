# Codex desktop adapter

Status: implementation in progress. A capability is not accepted until its test evidence exists.

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
- No shell interpolation, no ZCode-only arguments passed to Codex, no stdin logging.
- Explicit experimental opt-in is necessary for queue and structured user input.
- Validate message envelopes and mapped payloads at runtime. Keep generated
  types bound to the actual pinned executable; version text alone is insufficient.
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

Settings use Codex APIs rather than writing ZCode's old provider/MCP/skill config.
Show effective configuration and actionable errors. Test fixtures must use an
isolated temporary Codex home; never mutate the developer's real credentials.
Preserve legacy ZCode data; never claim text-only import is lossless migration.

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

The remote deployment owner remains `packages/server/src/remote`: reuse its pinned
per-platform release manifest, verified component installer and install-root lock.
For the Codex product (`ZCODE_DESKTOP_RUNTIME=codex` or compiled Codex flavor), use
`~/.zcode-codex/server`; explicit `legacy` keeps the existing root and GLM pipeline.
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

Startup sets `ZCODE_CODEX_COMMAND=<runtimeRoot>/codex/codex`,
`ZCODE_CODEX_BRIDGE_PATH=<runtimeRoot>/codex/bridge.cjs`, and
`ZCODE_CODEX_BRIDGE_HOME=~/.zcode-codex/bridge`, expanding remote home in the remote
shell, never the desktop home. ZCode application data and bridge metadata are
isolated under `~/.zcode-codex`; native Codex uses the remote machine's existing
home/config/auth resolution, without copying local credentials.
The service resolver consumes the deployed bridge path even without desktop
presentation context; missing explicit paths fail closed, with no legacy fallback.
Native model/plan selection, network environment and executable PATH are preserved;
legacy provider/account/browser/subagent preparation is not a Codex prerequisite.
Explicit `ZCODE_AGENT_SERVER_COMMAND` and custom legacy resolvers retain precedence.
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
