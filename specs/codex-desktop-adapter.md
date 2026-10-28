# Codex desktop adapter

Status: native desktop adapter implemented and validated on 2026-09-22, within
the capability and validation boundaries recorded in
`docs/codex-desktop-validation.md`. This is not acceptance of unsupported legacy
feature parity. A capability is not accepted until its test evidence exists.

## Scope

### Upstream v3.15.1 compatibility

Rebase preserves every fork behavior and its regression suite. The obsolete
3.14.4 version bump and previous generated dependency inventory are superseded
by 3.15.1 and a freshly generated inventory; neither contains product behavior.
The Codex bridge and distribution implementation remain unchanged by replay.

Keep upstream guarded mode alongside Codex custom, and apply the Codex-only
mode rejection at the upstream's new input-admission owner. Window-owned native
browser relay targets desktop-spawned remote backends, not independently owned
server environments. Retain upstream topic-history attachment metadata and
full-file upload bytes. Plugin/Gen UI sends use the same composer command path
and normalize the accepted result without losing command correlation.

Acceptance includes typecheck, lint, architecture, native bridge/distribution
tests, attachment and remote identity tests, composer/queue/continue/scroll and
worktree safety regressions, and an isolated desktop smoke. Upstream path
renames and service signatures must not silently disable fork UI entrypoints.

The upstream root Vitest gate must not collect fork `node:test` suites as empty
Vitest suites. Root unit and affected-test commands retain both frameworks:
Vitest runs its own suites; Node runs native suites in isolated processes with
bounded concurrency. Source-related checks conservatively run all native suites.

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
closed, native config/skills/plugin requests stay on the canonical execution cwd,
and `session/*` responses retain the caller's verified `workspacePath` spelling
(falling back to `workspaceId` when it is a local path alias of `cwd`) so Host
project roots and lineage checks never diverge across symlinks.

### Single-folder projects and native history

Project organization remains Host-owned (`tasks-index.sqlite`); Codex owns each
thread's immutable execution cwd, history and runtime workspace roots. A
single-folder project with root A is a read-only directory view, both locally
and on an online remote Host: its task rows include every indexed, non-deleted
native thread on that Host and workspace identity whose physical
cwd is A, including pre-existing CLI/Desktop threads, unclassified threads and
threads explicitly assigned to an A+B project. Creating the project never rewrites
the threads' `project_id`, cwd or history. Archived threads remain archived; pin,
unread, deletion and global recent-list deduplication still operate on the one
underlying task row. The unclassified section continues to represent actual
`project_id IS NULL`, not the complement of directory views.

A project with two or more local roots has no directory-union view: only threads
with that project's explicit Host `project_id` appear under it. New project
threads use its primary root as cwd and native `runtimeWorkspaceRoots` containing
the cwd and the other current roots. For native creation, the Host verifies the
selected project/cwd and resolves the roots before the bridge's `thread/start`.
The bridge writes a namespaced, durable native `threadSource` origin marker.
Once `thread/start` or `thread/fork` returns its authoritative native thread ID,
the Host immediately reserves the created task's project ownership (`cli_created_at = NULL`,
so unsubmitted prewarm drafts stay hidden from task lists) before returning the
creation/fork response, allowing immediate `v4/conversation/subscribe` on remote
and multi-folder projects to resolve ownership without racing asynchronous
`sessions-index` ingestion; if an index summary arrives first or rebuilds an
unreserved row, `threadSource` still seeds the **initial** assignment. An explicit unclassified creation has
a distinct marker, so unique-root migration heuristics cannot claim it. Existing
task rows, including rows moved by the user, never have their assignment
overwritten by later native summaries. An unknown/missing project fails closed,
not as an unclassified task. The legacy Codez CLI never receives or interprets
this project identity. Native `thread/start.projectId` is _not_ the Codez project
ID: Codex requires that ID to exist in its own project registry.

On cold native resume, the Host resolves the task's explicit project from the
same SQLite snapshot as its roots and passes an explicit array (including `[]`)
for an assigned project. The bridge supplies `[thread.cwd, ...additionalRoots]`
to `thread/resume.runtimeWorkspaceRoots` only when loading an unloaded thread;
an already loaded runtime is not refreshed by navigation or re-subscription.
The V4 subscribe and explicit legacy resume/read routes use the same Host
resolution; a native fork records the parent's **current Host assignment**
(which may differ from its creation marker after a move), while its live
runtime roots inherit the parent until the next cold resume.
An unclassified/external thread leaves the native parameter absent so its
Codex-persisted roots are preserved, including when it is opened from the A
single-folder view. An online remote Host may read an existing indexed,
unclassified thread only when its authorized workspace identity and cwd match
an undeleted single-root project on that Host. This read-only exception never
permits a projectless remote creation, an unindexed session, extra execution
directories or cross-Host access; the task's `project_id` remains NULL. Two
remote projects with the same root may each display that one task row. Project
deletion keeps historical roots resolvable; changing
roots affects the next cold load, never the stored cwd. The primary cwd alone
governs AGENTS/config discovery; the other roots are file-access roots, not
additional configuration roots. The native API requires absolute paths, and
resolution/validation failure must reject before starting a turn.

```text
create: project draft → Host validate A+B → native start(cwd=A, roots=[A,B], origin)
       → Host reserveCreatedTask(id, project_id) → ACK / immediate subscribe
       → native summary → Host applyCliFacts → project tree
open:  task ID → Host project_id+roots snapshot → bridge cold resume(roots=[cwd,...])
       → desktop continuous / mobile replayable share that runtime
view:  Host task rows + projects → single-root cwd projection / multi-root ID match
       → sidebar and project filters; no second task fact or native thread
```

Acceptance: create a fresh single-root A project after CLI A history already
exists and observe all A tasks without copying or reassigning them (including
when the active tab already uses A: the project-change event re-triggers scoped
native discovery); add an A+B
project and confirm its own A task appears in both project views while external
A/B tasks appear only in single-root A/B views; create two A+B projects sharing
A and prove neither captures the other's tasks. Check native start/cold resume
parameters, B access and A-only config, edited roots after process restart,
external native A+B roots when opened from A, and desktop/mobile projection
equivalence. Remote projects remain fixed single-root execution targets, not
fixed-membership views: scan external history on explicit activation, then
project only the matching Host, canonical workspace identity and directory.
Opening the external thread must succeed without rewriting its project
assignment or native roots. A second remote project on the same Host and root
shows the same row without duplication; another remote Host with the same path
shows none of its threads. Multi-root projects retain explicit membership.

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
- Concurrent workspace thread-list scans (`ThreadStateStore.list()`) coalesce
  only while an identical scan is in flight on that bridge instance, preventing
  duplicate `thread/list` paging bursts across `session/list` discovery and
  multiple `sessions-index` subscribers without caching a stale list after the
  scan settles.
- Settled turn row projections (`settledTurnRowsCache`) are cached per turn
  when that turn is no longer `inProgress` and has no pending interactions.
  Subagent anchor facts are scoped by `(turnId, anchorItemId)` so turns without
  subagent anchors remain 100% cache-eligible even when another turn in the
  thread spawned subagents, and turns with subagent anchors validate their
  cached subagent status signature before reuse. Bridge snapshot enrichment
  (`BridgeSnapshots.conversation`) never mutates cached `ConversationRow`
  objects in place when overlaying idle `actions`, `turnUsage`, `fileChanges`,
  or attachment references.
- `projectThread` supports an internal trusted-rows fast path after incremental
  `conversationRowSchema` validation of newly projected rows, avoiding repeated
  full-tree `conversationSnapshotSchema` and `routedTopicFrameSchema` re-parsing
  of unchanged settled history on every streaming delta notification.
- `ThreadProjectionState` maintains an incremental `turnId → turn` and
  `(turnId, itemId) → item` index owned by `ThreadStateStore`, so `item/started`,
  `item/completed`, `turn/plan/updated`, and streaming `*Delta` notifications
  resolve the active turn and item in $O(1)$ without scanning historical turns.
  Settled turns cache their parsed `CodexTurn`, subagent facts, row slices,
  attachment projections, and file-change summaries; active-turn streaming deltas
  keep projection work proportional to the active turn and tail window rather
  than total historical turns, while preserving `rowId`, `seq`, `revision`,
  `logEpoch`, and protocol schemas.
- `BridgeSnapshots.conversation` coalesces concurrent in-flight snapshot builds
  keyed by `(sessionId, epoch, revision, canonicalAdditionalDirectories)` and
  invalidates any stale in-flight entry on revision advance, reload, or deletion.
  `BridgeSubscriptions` shares a single logical `RoutedTopicFrame` JSON/UTF-8
  encoding and physical frame sizing pass when fanning out the same topic
  revision to multiple routes, and the Host legacy session-event mirror bounds
  pre-ACK `stagedWires` by frame count and byte budget (`PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxStagedBytes`),
  resubscribing for a fresh snapshot on overflow rather than growing without bound.
- `AttachmentFiles` separates manifest/ownership validation from full-blob SHA-256
  verification and paginated slice reads: once a committed blob's `(workspace, id,
dev, ino, ctimeMs, mtimeMs, size, checksum)` tuple is verified, subsequent
  paginated preview reads verify `lstat`/`fstat` identity (`nlink === 1`, no
  symlink, matching `dev`/`ino`/`mtimeMs`/`size`) and read only the requested
  `[offset, offset + limit)` slice without re-hashing the whole file; blob
  replacement, size/mtime change, or verification failure invalidates the cache.
  Read-only attachment resolves/reads run with bounded concurrency while upload
  staging mutations remain safely serialized per upload scope.
- `useCodexProjectDiscovery` re-triggers active-tab native discovery on
  `state:projects` only when the set of undeleted project roots changes (or on
  initial baseline establishment), preventing `codexGlobalRolloutSyncer` and
  `codezTaskIndexSyncer` task-row broadcasts from creating a feedback loop of
  redundant `session/list` scans during live conversation streaming.
- `codexGlobalRolloutSyncer` reads bounded head/tail slices via file handles
  rather than loading multi-megabyte rollout `.jsonl` files into memory in full,
  uses `fs.watch` relative filenames for targeted single-file stat/parse on
  incremental rollout appends, avoids unconditional full-directory walks on
  ordinary `readTree`/`readProjects` calls once the initial baseline scan has
  completed and the watcher/poll loop is healthy, and diff-checks
  `session_index.jsonl` entries so a single thread rename only invokes
  `applyCliFacts` for the affected session(s).
- The startup baseline scan still walks the whole `$CODEX_HOME/sessions` tree and
  still verifies every candidate session against `tasks-index.sqlite`, but it does
  not re-parse rollout files whose `(mtimeMs, size)` are unchanged since the last
  process. `codexGlobalRolloutSyncer` owns one durable parse-facts cache per
  resolved `$CODEX_HOME`, stored under the Codez data root
  (`codex-rollout-cache/<scope>.json`) and never inside `$CODEX_HOME`, written
  atomically (temp + rename, cross-process file lock) only when its serialized
  content actually changed, and bounded by an entry cap above which nothing is
  persisted. The cache stores only facts derived from the rollout file itself —
  `(mtimeMs, size, settled, candidate)` — and never the `synced` flag, because
  `synced` means "already reflected in this Host's `tasks-index.sqlite`
  partition": persisting it would create a second durable store with no
  transaction binding it to the index, and a cache that claims `synced` for a row
  the index no longer has (task deleted in Codez, database rebuilt or migrated,
  identity resolution changed, cache copied between machines or Hosts) would make
  that session permanently invisible with no self-healing path. Entries are
  therefore always loaded as not-synced, so every startup re-reads the index row
  and re-applies divergent facts, keeping the existing self-healing backstop
  intact while removing the O(all history) head/tail parse. Keeping only
  file-derived facts is also what makes the cache safe to share between Hosts and
  windows over one `$CODEX_HOME`. Any version mismatch, scope mismatch, corrupt
  or unreadable cache fails open to today's full-parse behaviour with a `warn`
  log, never to a skipped session. Acceptance: a warm start performs the tree
  walk and one `stat` per rollout, opens only genuinely new or changed rollouts,
  and produces exactly the same `applyCliFacts` calls a cold start would.
- Concurrent read-only control-plane and native settings reads (`config/read`,
  `model/list` and paginated list reads) coalesce per `CodexRpcPort` and
  canonical request key only while an identical read is in flight, preventing
  duplicate `config/read` and `model/list` bursts across `useCodexModelCatalog`,
  `catalog/read`, `workspace/readPresentation` and `workspace-config` topic
  snapshots without retaining a stale response after the read settles.
- When an ordinary native RPC times out (`Codex RPC request timed out; outcome is unknown`),
  the bridge emits a bounded, redacted stderr warning with only the allowlisted
  native `method`, `durationMs`, and `pending` count; Host process management
  parses that allowlisted line into a production `warn` log without logging
  parameters, paths, or user content. Read-only topic subscriptions
  (`conversation/*` and `sessions-index/*` `subscribe`/`resync`) treat that
  timeout as a transient read failure and perform bounded backoff retries
  (`250ms / 1_000ms / 3_000ms`) before surfacing the manual reconnect error
  panel, and `useCodexModelCatalog` applies the same bounded backoff retries
  (`250ms / 1_000ms / 3_000ms`) on transient runtime-recycle (`Codez agent transport closed`,
  `Codez Protocol client disposed`, `Codez Agent runtime is not running`) and
  read-only RPC timeout errors while keeping catalog readiness in `"loading"`
  so new draft sessions self-heal without permanently disabling message submission,
  whereas commands and mutations never auto-retry.
- Composer creation and send failures (including prewarmed and fallback sessions)
  expose a nonempty trimmed `CommandAck.message` before `reasonCode`, then the existing
  fallback text. The localized failure summary, draft retention, command ID and machine
  reason-code observability remain unchanged. Blank messages must not hide the reason.
  Acceptance covers all creation/send branches and verifies that detailed failed ACKs
  do not cause a new command/session or duplicate first input.
- Pending approvals are scoped to connection generation/thread/turn/request ID;
  late replies cannot approve another run. Unknown request kinds fail closed.
  Human approvals/questions have no default RPC deadline; an explicit interaction
  deadline is independent of the bounded ordinary RPC/write deadline.
- Command-execution approvals preserve Codex's `availableDecisions` order and
  recognize both string decisions and object decisions. The bridge assigns each
  offered item a stable unique V4 `optionId` (using an index for repeated
  network amendments), stores `optionId → native decision` only in the pending
  reverse-RPC owner, and resolves by returning that exact original object.
  Renderer-supplied amendment content cannot rewrite or synthesize a decision,
  and a camelCase decision name alone is never sent back as a string. An empty
  native list projects no implicit approval option; a missing list retains the
  compatible `accept`, `acceptForSession`, `decline`, and `cancel` choices. The
  public command schema and the `item/permissions/requestApproval` response
  shape remain unchanged.
- Native MCP tool-call approval arrives as `mcpServer/elicitation/request` with
  `mode: "form"`, `_meta.codex_approval_kind: "mcp_tool_call"` and an empty
  object `requestedSchema`. It is a choice, not a form answer. The bridge owns
  its pending reverse-RPC identity and projects it as a V4 permission with
  Allow, optional session/always grants only when `_meta.persist` offers them,
  and Cancel. The renderer sends the selected option ID through the existing
  `resolveInteraction` command; the bridge validates that exact offered option
  and replies to the original native request with `action: "accept"` (and only
  the selected supported `_meta.persist`) or `action: "cancel"`, never a
  free-text answer or implicit approval. Unmarked/non-empty-schema MCP forms
  retain the ordinary user-input path. Duplicate, stale, cross-thread, and
  failed native writes retain the existing broker's fail-closed behavior.
  The same pending projection is delivered live on desktop-continuous and
  recovered via the existing web-remote-replayable snapshot route; neither
  Main nor renderer owns an accepted permission.

```text
native MCP tool approval → bridge pending reverse RPC → V4 permission projection
  → renderer option → resolveInteraction → bridge validates offered option
  → one native elicitation response → native tool runs or is cancelled
desktop: continuous; mobile: replayable snapshot/gap repair of the same pending ID
```

Acceptance: a marked empty-schema `cua_status` request presents Allow/Cancel
without a text field, Allow executes the tool, Cancel does not, and offered
session/always choices return only their corresponding native persistence
metadata. An ordinary MCP form still asks for input; forged option IDs or
unoffered persistence never reach Codex.

- Native settings reads are method-allowlisted and cwd-scoped. Explicit foreign
  workspace identities are rejected even for the same local path; local callers
  without an identity retain the path fallback. Plugin paths must come from the
  native marketplaces visible to this attachment. Global account/configuration
  changes remain native-owned and are explicitly presented as global UI actions.
- Deleted threads cannot be resurrected by in-flight projection loads or authorize
  an old attachment. History/live merges use item identity and preserve terminal
  content against late start/delta notifications.
  `v4/sessionsIndex/reconcile` reconciles up to 256 session IDs for the authorized
  workspace: tombstoned IDs in the bridge return `{ exists: true, deleted: true, ... }`,
  existing workspace-owned threads (cached or via lock-free `thread/read`) return
  `{ exists: true, deleted: false, ... }`, and missing or foreign-workspace IDs
  return `{ exists: false, deleted: false }`. `deleteSession` is idempotent when the
  thread is already deleted or has no rollout on disk (when not loaded in memory,
  it inspects lock-free `thread/read` without calling `thread/resume`, verifies
  workspace ownership and writable status before calling `thread/delete`, and
  treats a missing thread/rollout as already deleted and records the bridge
  tombstone so subsequent reconcile confirms deletion). When `sessionsIndex/reconcile`
  returns `exists: false` for a Host row with a pending deletion intent
  (`handoff_pending & 1`), `task-facts` completes the deletion (`applyCliDeletion`)
  instead of leaving `cli_deleted = 0`.
- Snapshot omission reconciliation reads Host task rows only when their CLI deletion
  has not been confirmed, or when a delete/title handoff is still pending. A
  confirmed `cli_deleted = 1` row without either pending intent must not issue a
  native read on each snapshot; Host `deleted` alone is not proof of CLI deletion.
  Host checks the snapshot generation between bounded batches so stale snapshots
  do not start another batch. On one bridge/native connection, reconciliation
  shares a small read-only `thread/read` concurrency budget across simultaneous
  reconcile requests; explicit conversation reads and mutations are not queued
  behind this background budget. Only the native missing-thread error and proven
  foreign-workspace ownership produce `exists: false`. Native timeouts, overload,
  connection errors and unknown RPC failures reject the entire reconcile request:
  Host preserves existing rows and handoff intents for a later fresh snapshot,
  never completing a pending deletion from a failed read.
  ```text
  sessions-index snapshot → Host tasks-index (filter confirmed tombstones)
                          → Host task-facts (small batches + generation check)
                          → Bridge (shared read-only slots per native connection)
                          → Codex thread/read (authoritative existence)
    explicit missing/foreign → Host mirrors verified absence
    timeout/overload/unknown  → reject batch; Host keeps row and handoff intent
  ```
  Regression acceptance: hundreds of confirmed tombstones do not reach the
  native adapter; two simultaneous reconciliation requests stay within the
  shared read budget and preserve response order; an interrupted read cannot
  confirm pending deletion; a replaced snapshot starts no further stale batch.
  Opening a conversation and desktop continuous/mobile replayable subscriptions
  retain their existing native owner and delivery behavior.
- Native queue contents are owned by Codex. Unsupported auto-drain/paused intent
  semantics must be reported, never silently acknowledged.
- Native transport frames are newline-delimited JSON with a hard cap of 32 MiB
  per frame in each direction. JSON never carries a raw newline inside a frame,
  so an oversized inbound frame is skipped by discarding bytes up to the next
  raw newline; the connection survives and memory stays bounded regardless of
  the dropped frame's true length. The oversized-response regression allows
  slow CI runners to generate and stream the whole frame before asserting
  `LIMIT`; it then verifies a later ordinary request and a valid large response
  on the same connection. Its deadline does not change the product's RPC default.
  Dropping is explicit, never silent:
  - A dropped response fails its in-flight request with a `LIMIT` transport
    error. The request id is read from the retained frame prefix; when the id
    is not visible there, every in-flight request on that connection fails
    because the lost response cannot be attributed. No request is retried.
  - A dropped server-initiated request receives an error reply when its id is
    visible in the retained prefix, so the native side never waits forever on
    an answer we cannot address. When neither id nor method is visible, the
    connection is terminally failed instead of risking a hung interaction.
  - A dropped notification is logged with a bounded diagnostic (observed byte
    count and the allowlisted method name when visible, never payload content).
    Projection state stays authoritative-by-snapshot; a dropped live item is
    missing until the next reload and must not be fabricated.
- An outbound bridge→Host response that exceeds the frame cap fails its own
  request with a `LIMIT` error result; it never terminates the bridge. Fatal
  treatment remains for invalid JSON, invalid UTF-8, malformed envelopes and
  other protocol violations where resync is not provably safe.
- The bridge→Host output queue accepts a single valid maximum-sized frame; a
  full but otherwise healthy queue is backpressure, not an oversized frame.
  A frame that cannot fit the transport cap fails only its correlated request.
  Correlation hints must identify top-level envelope fields, never text inside
  a user-provided payload. Unknown envelope identity must fail closed rather
  than treating a possible server request as a response or notification.
- A cold Codex conversation must not return the full durable turn history in
  `thread/resume`: use the pinned native `excludeTurns` option, preserve the
  existing writer-conflict and unloaded-child branches, and read history from
  the read-only paginated `thread/turns/list` authority. An oversized full-turn
  page may be retried at the same cursor with a smaller limit, stopping after
  the single-turn boundary. When even one full turn exceeds the frame cap, read
  that turn's metadata with `itemsView: "notLoaded"` and use the pinned native
  `thread/items/list` with a bounded page size to reconstruct its complete
  items, identity and order. Empty pages that offer another cursor, repeated
  cursors, or repeated turn/item identities fail explicitly instead of looping.
  Only turns with `itemsView === "full"` may enter a published conversation
  projection. If a full-history `thread/turns/list` page returns any turn with
  `itemsView !== "full"`, or if a `turn/completed` notification arrives for a
  turn that is not already locally present with `itemsView === "full"`, the
  bridge reconstructs that turn's complete items through read-only
  `thread/items/list` pagination (preserving any already-observed live items if
  the native read races before persistence) before advancing revision or
  publishing a snapshot; it never stamps `itemsView: "full"` without hydration.
  A single oversized item still fails explicitly;
  neither read-only recovery nor `thread/resume` may silently truncate history
  or retry a mutation with an unknown outcome. An oversized-frame production
  diagnostic contains only the validated native method, frame-byte lower
  bound and frame kind, never the JSON prefix, content, parameters or path.
- Cold-open performance has two distinct observable boundaries: first genuine
  historical content painted and genuine runtime command authority ready.
  Returning an ACK or an empty shell is neither boundary. Existing desktop
  continuous and mobile replayable subscribers share one native history owner,
  while their delivery/gap rules remain distinct. The current whole-history
  row ordinals (including hidden continuation rows and synthetic subagent rows)
  mean a tail-only initial snapshot cannot claim a global `firstRowId` or
  `totalCount` without a complete, exact row outline. Until native history
  exposes such a bounded outline, cold loads must keep the existing accurate
  whole-history contract. Optimize within that boundary by avoiding a duplicate
  full-history resume response and by reusing the derived projection for
  same-epoch/same-sequence history queries; never claim on-demand old-history
  hydration from a tail-only UI window. A future outline-based tail-first
  release requires its own additive protocol contract and separate read-only
  versus executable-ready gates.
- For a synthetic large historical fixture, measure subscribe→first painted
  content, subscribe→interactive readiness, native frame bytes and request
  count, history-page query latency and bridge peak memory on matched old/new
  binaries, hardware and cache state. Compare ordinary and near-limit cases
  at least ten times each; do not compare a formerly failing >32 MiB case
  against a nonexistent successful baseline. Record results and correctness
  hashes rather than inserting arbitrary sleeps or relaxing the 32 MiB cap.
- Native queues automatically dispatch when idle (including cold resume),
  except that idle caused by an interrupt never dispatches. An
  explicit queue request is not a request to hold an idle turn. External queue
  entries retain their native IDs; unknown admission metadata uses documented
  unavailable display sentinels, not fabricated timestamps or client identities.
- Busy input follows the user's `codezInteractionBehavior` setting (`"queue"`
  by default, or `"guide"` when configured in General settings), while keeping
  per-send override in the composer: Queue (`requestedDelivery: "queue"`)
  places the follow-up in the visible, editable native queue, and Guide
  (`requestedDelivery: "guide"`) steers the running turn at its next model
  step.
- While a Codex turn is running, the composer must expose an explicit, accessible
  per-send Queue / Guide choice next to Send. Its default selection follows `codezInteractionBehavior` (defaulting to Queue when unset):
  it sends after the current task, appears in the editable native queue, and
  never silently becomes a steer. Guide sends `requestedDelivery: "guide"` on
  this submission only: it joins the current turn at Codex's next model step,
  not necessarily at the next tool call, and never interrupts or aborts the
  in-flight model sampling request (reasoning or response streaming) to do so.
  The bridge launches `codex app-server` with a process-scoped
  `-c features.instant_interrupt=false` override so an accepted steer waits for
  the active model request (and any tool calls emitted by that request) to
  finish before being sent in the next model request of the same turn, without
  mutating the user's shared `config.toml`. Codex does not expose un-injected
  steers in `thread/queue/list`. After a successful ACK the initiating composer
  may show an explicitly local "accepted, awaiting next model step" hint scoped
  to the current turn; it is not an authoritative queued item, cannot be
  edited, and disappears when a native user-input row carries the exact
  `sourceCommandId` returned by the accepted steer, or on turn change.
  The controller Host (`baseServices.settingService` when registered, otherwise
  the root `SettingService`) is the single preference authority for
  `codezInteractionBehavior` across local and remote workspaces: reading or
  saving this setting in a remote workspace never reads from or writes to the
  remote Source Server's `setting.json`. Both the local next-send choice and hint are scoped by
  `workspaceIdentity?.trim() || workspacePath` plus session and turn; switching
  between same-path remote identities cannot carry a choice or hint across.
  Codex's projected user-input row does not necessarily carry `guided: true`;
  matching only that display flag or text leaves a duplicate hint or removes
  the wrong one. The hint is not durable across reload; after restart only
  native projected facts are shown. A successful send resets any per-send override back to the configured default (`codezInteractionBehavior`, or Queue when unset); rejection
  keeps both the draft and the choice for retry. Returning to idle or switching
  sessions also resets any per-send override back to the configured default.
  Modifiers retain the existing inverse action (Queue → interrupt and start,
  Guide → Queue); neither action changes the global legacy follow-up setting.
  A running turn that settles between selection and admission follows the
  native command's documented idle delivery, and the UI reconciles from
  authoritative snapshot rather than inventing a second queue.
- The native queue card labels the count and execution timing in user language,
  keeps long input readable, and names its preempt action as an interruption
  of the current task. The editable queue list derives solely from authoritative
  `queue.items`; the local accepted-guide hint must remain visibly distinct
  from that list and must never manufacture an authoritative queue fact. Empty
  queue shows no card; no pause/resume affordance is shown for native Codex.

```text
running snapshot → Composer local next-send intent (defaults to codezInteractionBehavior: Queue / Guide)
  → sendText(requestedDelivery) → Host route → bridge → native queue/add | turn/steer
  → native queue/turn events → bridge projection → desktop continuous UI
                                     └── mobile replayable snapshot/gap repair
accepted queue: native Codex; selected next-send intent: Composer draft only
```

Acceptance for follow-up delivery:

1. An isolated Electron/Host/native turn held at the model request shows both
   modes via mouse and keyboard, readable in the active theme and compact
   viewport. A normal busy send creates one editable/deletable native queue
   card; release auto-runs it as the next turn with no duplicate transcript.
2. Selecting Guide and sending another busy input invokes `turn/steer` exactly
   once, exposes a clearly local accepted-guide hint (not a queue card), and
   after the next native model step displays the guided input in that same
   turn while the hint disappears. Reload during that interval does not claim
   the native queue contains the guide. The subsequent composer choice returns
   to Queue.
3. A rejected Guide preserves text, attachments and the selected mode; retry
   cannot create two accepted commands. Idle, session switch and fresh task
   hide the mode choice and resume the native start-now default.
4. A Queue item's preempt action warns that it interrupts the current task;
   the modifier's inverse result is announced for both modes. Locale, light/
   dark and narrow viewport retain labels, focus and reachability. In a compact
   busy Codex composer, disabled model details collapse to a labeled locked
   status before consuming space needed by Queue/Guide and Stop/Send; they are
   readable again at regular width or when idle. Desktop
   continuous and mobile replayable projections agree about admitted delivery.
5. The isolated Electron QA probe refuses to start if its chosen local CDP
   port is already listening, before creating a profile or launching Electron.
   A stale QA window on the same renderer preview must never be mistaken for
   the new mock instance. Probe does not stop or reconfigure the port owner;
   choose separate QA ports or close only the previous isolated probe.

- Preempt is interrupt-then-start, never a single atomic mutation: busy
  `requestedDelivery: "startNow"` and busy `sendQueuedNow` interrupt the running
  turn first. `turn/interrupt` resolves only after `TurnAborted`, and core
  reports the post-interrupt idle as `ThreadIdleCause::Interrupted`, for which
  the native queue extension skips auto-dispatch, so no queued item can slip in
  between the two mutations. A turn that finishes naturally just before the
  interrupt wins the race; the follow-up start then fails and the draft is
  restored. A failed interrupt never blocks the subsequent start decision.
- Queue/steer keep the native thread's effective settings. Reject per-input
  model/reasoning/mode changes that these native methods cannot honor; preempt
  is exempt because the interrupt settles the old turn before the new
  `turn/start` applies fresh settings. Editing
  queued text preserves its existing image/non-text inputs. Reject legacy held
  queue item guards (`expectedHeldQueueItemIds`), browser context and
  restricted-tool intents before mutation. A bare legacy `heldQueueDisposition`
  has no held-queue transaction to apply (the projection never reports choice);
  replayable senders (bots, automations, mobile) always carry
  `keepQueueAndSend` for legacy `session/send` parity, so it is accepted and
  ignored rather than rejected.
- Conversation revert does not imply file rewind. File rewind requires a separate
  preview and a supported safe implementation; never use destructive Git reset.
- Editing/retrying a historical input requires matching epoch/revision and stable
  row/entity, an idle turn, native `thread/revert`, fresh paginated history and a
  new epoch before `turn/start`. `workspaceMode: rewind` is rejected before mutation.

### Native file-change tool display

- A native `fileChange` item is the authoritative source for one `ApplyPatch` tool row. Its
  `changes[]` are per-file facts (`path`, `kind`, `diff`): `add` and `delete` carry the full file
  body, while `update` carries unified hunks. The bridge derives a bounded, validated
  `ToolCallRow.output.display` from those facts; it does not infer a diff from concatenated
  `output.text`, the current Git worktree, or a different turn's file summary.
- A single file uses the existing `file_diff` display; multiple files use `file_diffs` with
  individual entries. Each visible file shows its path, operation, full-fact additions/deletions
  and a structured patch. Rename displays the source and destination and opens the destination.
  The tool row retains its native item ID and status. Pending/approval diffs are proposed changes,
  not a claim that they were applied; failed/declined rows keep their failure outcome.
- The inline preview retains the existing file-tool limit of eight hunks and 160 diff lines.
  The entire derived display is also bounded by the row budget, including path metadata; when
  files or lines are omitted, preserve accurate total counts and an explicit truncation flag.
  The UI may show the bounded preview and a truncation notice, but must not offer it as the
  complete per-tool diff. No new full-output store or per-tool fetch API is created. The existing
  turn-level `fileChanges` query and Review action remain the route to the full available turn
  changes; they must not be substituted for a particular tool's change set.
- Desktop live projection, paged/cold history and mobile replayable snapshots carry the same
  typed display. This is a presentation projection only: no extra file write, command, queue,
  owner/lease, or delivery path. Legacy Codez `file_diff` rows and Office mode's hidden inline
  details keep their existing behavior.

### Conversation tail window and history paging

- The Codex publisher has no durable delta/replay log: every projection change
  republishes a whole snapshot and the client applies it as a full replacement.
  Rows a client paged in through `rows/range` are therefore dropped by the next
  frame, so the published tail window must be self-sufficient for the turn it
  already covers.
- The wire window starts at the last `snapshotTailWindowRows` rows and then
  extends backwards to the first row of the oldest turn that base covers. The
  extension is bounded by `snapshotTailWindowRows * 16` rows and by
  `logicalFrameAssemblyMaxBytes / 4` bytes, because the window is republished on
  every projection change and tool rows can reach the 64 KiB preview cap. It
  never crosses into an older turn; earlier turns remain the client's
  `rows/range` responsibility.
- Extension has two budgets, not one. Tool rows extend the contiguous run only
  while the total byte budget lasts; `turnHeader` / `userInput` / `reasoning` /
  `assistantText` rows draw on a reserved narrative budget (half of the total) and
  keep being collected after the tool budget is spent. The base window is
  mandatory and can itself reach ~3.75 MiB when 60 tool rows hit the 64 KiB
  preview cap, so a single shared budget starves the narrative to zero and
  reproduces the original defect: the whole turn collapses to tool rows and the
  user's own input plus every intermediate answer disappear. Narrative rows are
  what the user reads and are small in practice - one real 217-row turn carried
  430 KiB of `commandExecution` against 20 KiB of reasoning plus messages.
- The window is therefore `rowId`-ascending but not always contiguous: once the
  tool budget is spent, the retained narrative rows sit ahead of a gap in the tool
  sequence. Gaps are safe on the client (`apply.ts` treats an upsert for an
  unloaded `rowId` as a no-op, `row.removed` filters by `rowId`, and render units
  group by `turnId`), and `loadOlder` still pages backwards from
  `window[0].rowId`; only the gap itself cannot be refilled while the turn
  streams. The oldest covered turn's `turnHeader` is always retained even when the
  caps truncate that turn's middle: a window whose leading turn has no header
  makes the client re-run incomplete-leading-turn hydration on every frame,
  turning full-snapshot publishing into a paging storm.
- `rows.firstRowId` and `rows.totalCount` keep whole-projection semantics; only
  `rows.window` is trimmed. The client decides "already at the top" from
  `window[0].rowId === firstRowId`, so rewriting `firstRowId` to follow the trim
  makes `hasOlderRows` permanently false and silently disables `rows/range`
  paging, question-directory hydration and the load-older affordance. This matches
  the CLI publisher, which slices `window` only.
- Native Chat/Anthropic SSE reuses one `itemId` for every assistant message
  (`msg_assistant`) and every reasoning segment (`reasoning_<choice>`) within a
  turn, so Codex collapses a whole turn into one `reasoning` plus one
  `agentMessage` item pinned at the turn head. Repeated IDs inside one turn stay
  invalid per the identity rule above and remain an upstream defect; the bridge
  must not mint per-occurrence IDs, because paginated history reload collapses
  them again and would diverge from the live projection. The turn-anchored window
  is what keeps those head-pinned narrative rows visible despite the collapse.
- When the client receives a newer snapshot in the same `logEpoch` (monotonic
  `seq`, no branch rewind), `ConversationProjectionStore` retains any older rows
  (`rowId < nextSnapshot.rows.window[0].rowId` and `rowId >= nextSnapshot.rows.firstRowId`)
  already loaded into the local window (either present from the start of the conversation
  or paged in via `rows/range`, including partial upward paging before reaching `firstRowId`),
  so a user reading earlier turns
  while a turn streams does not have their viewport yanked downward on every
  tool/reasoning update or when the wire tail window slides past an earlier turn.
  On an epoch change (edit/retry rewind or runtime restart), the new snapshot replaces
  the window completely so removed branch rows are never revived. A tool-row gap inside
  the active turn left by an exhausted byte budget is still only refilled once that turn
  scrolls past the tail window and the client pages again.
- Because the Codex publisher emits full `snapshot` frames on every projection
  update, `ConversationProjectionStore` must not unconditionally increment
  `planDirectoryRevision` or `turnNavigatorDirectoryRevision` on same-`logEpoch`
  streaming snapshots. On same-`logEpoch` monotonic snapshots, `planDirectoryRevision`
  increments only when the terminal `ExitPlanMode` row set in the snapshot window
  changes, and `turnNavigatorDirectoryRevision` increments only when the
  `realUser` `userInput` row set in the snapshot window changes; initial snapshots
  and `logEpoch` changes still invalidate both directories. This prevents an
  idle or streaming `v4/conversation/plans` RPC storm and repeated turn-navigator
  full-history hydration on every snapshot frame.

## Desktop surfaces

### Settings deep links and honest diagnostics copy

- The command palette must not register two commands with the same title and
  handler (the old `suggested-settings` + `settings` pair rendered two identical
  `Settings` rows in every search). One entry lives in the `suggested` section.
- Codex-adapted settings sections are reachable from the palette on desktop
  Hosts: `Codex settings` (account panel), `Codex providers` (providers panel)
  and `Usage stats` deep-link through `setPendingSettingsSection` +
  `openSettingsTab`. Non-desktop clients omit these commands instead of
  showing entries that resolve to legacy surfaces.
- Task diagnostics copy actions must never hand the user a path that does not
  exist. `Copy task path` and `Copy log path` are disabled while the resolved
  path is unknown or proven missing (`exists === false`), in any runtime; the
  Codex adapter has no `.codez-session` snapshot concept (native rollout +
  tasks-index.sqlite are the facts), so `Copy task path` resolves to null and
  stays disabled. `Copy log path` resolves to the Host daily log under
  `getAppConfigDir()/logs` when that file exists (legacy CLI jsonl only as a
  fallback) and to null otherwise. Copying a phantom path is treated as a
  defect, not a convenience. Both task action menus and grouped task context
  menus must keep a non-null path with `exists: false` disabled.

### Failed native turns remain usable

- A native `failed` turn is an execution result, not a permanent input-admission
  failure. Once no native turn is active and no approval/question is pending,
  retain `control.phase = error`, the error banner and failed history, but project
  `inputRouting.mode = startNow`. The user can type and explicitly start another
  turn without dismissing the error, switching tasks or restarting the app.
- Codex may retain `thread.status = systemError` after a model error until the
  next turn starts. An explicit latest `failed` turn is the recovery boundary;
  a system error without that terminal fact remains blocked. Active/unloaded
  turns, pending interactions and writer-conflict guards remain unchanged.
- Native Codex owns turn/error state and queue admission. The bridge changes
  only derived input routing: no timer, automatic retry, history revert, queue
  drain, new state owner or special SSH path is introduced.
- Live desktop-continuous snapshots and web-remote-replayable resubscription
  derive the same decision, including after a bridge/history reload. Host
  workspace identity, remoteSessionId, lease and stale-command guards are unchanged.

```text
Codex error -> systemError -> turn/completed(failed) -> bridge snapshot
                                                     | error remains visible
                                                     | input: startNow
                                                     v
UI explicit send -> existing Host/lease -> turn/start -> Codex clears old error
```

Acceptance:

1. Inject a terminal Responses stream error in an isolated real Electron →
   Host → bridge → pinned Codex → loopback provider. Verify the error remains
   visible, the composer is editable, and explicit follow-up succeeds in the
   same thread. Fault injection is synthetic and never uses real credentials.
2. Reload the renderer while the failed turn is latest; history and the error
   remain, the composer stays editable, and Enter sends one new turn.
3. Unit/integration tests cover idle and systemError failed turns, both delivery
   modes and cold history, while preserving approval/question, active-unloaded,
   unresolved system-error and writer-conflict boundaries.

### Native model retry visibility

- Codex alone decides whether a model request is retrying. An app-server `error`
  notification with `willRetry: true` is a transient retry fact, not a failed
  turn. The bridge translates it into a turn-scoped, non-persisted V4
  `control.apiRetry` presentation state. It does not retry a request or store a
  second execution history.
- Show a localized "model request is retrying" status in the live turn from the
  first _reported_ notification. When the native `error.message` reports a
  positive integer `attempt/maxRetries` pair (for example `Reconnecting... 1/5`
  with `1 <= attempt <= maxRetries <= 1000`), project those validated integers
  on `control.apiRetry` and render `attempt/maxRetries` after the localized
  retry copy. Show `HTTP nnn` only when the native
  `codexErrorInfo.httpStatusCode` is a valid HTTP status. A bounded
  `additionalDetails` value may be projected as transient `errorDetail`; clicking
  the retry label shows that latest error detail in a popover. Never persist the
  detail, fabricate counts or deadlines when none are reported, or apply the
  legacy model adapter's "third retry" visibility threshold.
- Accept a retry notification only for the current in-progress turn on the
  already-owned thread. Duplicate or late events for a completed/older turn
  cannot revive the label. The first new model item/progress on that turn,
  terminal `error` notification, and turn completion clear it. A new turn starts
  without the previous turn's status.
- This is transient bridge-owned display state, not a durable Codex fact.
  Desktop uses the existing continuous subscription; mobile Web uses the same
  current snapshot on replayable resubscribe/gap repair. A bridge restart may
  lose an in-progress retry label until Codex sends another notification; it
  must never invent an old retry from thread history or a timer.
- Native Codex does not report every internal retry (including the first
  WebSocket retry in release builds). The GUI claims only that a _reported_
  retry is underway; showing every attempt would require an upstream Codex
  event change.

Acceptance scenarios:

1. In an isolated real Electron → Host → bridge → pinned Codex → loopback
   provider turn, set the fixture provider's _request-level_ retries to zero
   (without changing the product setting) and return two retryable HTTP 503
   responses (the release build may suppress the first WebSocket notification). While the following
   request is held, the live chat shows the retry label with HTTP 503 and no final error; release
   it, observe the answer and disappearance of the retry label.
2. A native `willRetry: true` notification without structured HTTP status shows
   the localized label without fabricating a code, count or deadline. A
   `willRetry: false` notification never creates a retry label.
3. Notifications for a different thread, older turn, or already completed turn
   do not change the current chat. A duplicate event does not create a second
   message; the next model item/progress or turn completion clears the label.
4. An existing V4 legacy numeric `apiRetry` still displays its existing
   attempt-count semantics. A replayable mobile snapshot reflects only the
   current turn-scoped status; desktop continuous delivery remains independent.

### Open renderer startup debt (not a gate)

The production main-window HTML currently emits 280 eager `modulepreload` links,
227 of them single-icon Lucide chunks. This is recorded as open performance debt,
not an acceptance gate: the intended direction is auditing `lucide-react` barrel
imports so the bundler keeps only icons actually imported at module boundaries,
never re-introducing one monolithic icon chunk, disabling module preloading, or
raising startup timeouts. Any future budget assertion must encode a target that a
real fix achieves, not the current baseline.

### Renderer bootstrap failure stays visible and recoverable

- Removing the startup shell must never be treated as proof that React mounted.
  The 3s fallback only removes the shell; `reactReady` is set exclusively by the
  `codez-react-startup-ready` event dispatched from the renderer entry.
- When the module graph fails (script/link resource errors, or dynamic-import
  rejections) and React has not mounted, the window must not stay blank: after a
  short evidence delay the bootstrap watchdog reloads once automatically, and on a
  repeated failure renders a dependency-free error surface with a reload action and
  the captured failure list. The watchdog is evaluated on a 2s interval up to a hard
  deadline, so late-arriving evidence is not missed between fixed timers.
- The watchdog is plain inline DOM/CSS with no imports so it still runs while the
  module graph is broken. It must be an ordinary (non-module) inline `<script>`
  that remains in the served and production-built HTML; `type="module"` causes
  Vite to bundle it into an external entry and removes the watchdog precisely
  when an entry chunk fails. It is skipped for the update-status window kind
  and never fires once React reports ready.
- Renderer-reachable service modules must be safe to evaluate without Node
  globals. In particular, importing the shared V4 connection-scope facade must
  not construct its Host-only diagnostic logger at module evaluation time:
  `createServiceLogger` reads `process.pid`. The Host owns that logger and creates
  it only when constructing an attachment scope. Renderer import must not start
  an attachment or allocate a second diagnostic owner. Acceptance: evaluate the
  connection-scope module without a global `process` and confirm import succeeds;
  constructing a Host scope still emits the existing bounded initial/recovery
  checkpoints for both desktop-continuous and web-remote-replayable connections.
  A production renderer startup with this module in the eager graph must reach
  `codez-react-startup-ready` instead of falling through to the bootstrap error
  surface. Do not shim `process` in the renderer to mask a Node-only side effect.
- Acceptance: building the desktop renderer retains `checkBootstrapFailure`
  inside a classic inline script independent of external module chunks. In an
  isolated GUI page with the entry chunk aborted, a user sees a bounded
  self-retry followed by an actionable failure surface, not a permanent logo.
  The failure surface must set its own opaque, readable background and text
  colors: Electron may show it over a dark startup body without the application
  theme stylesheet, so dark text on a transparent overlay is not acceptable.
  A normal successful React mount cancels the watchdog with no failure UI.
- Main owns the crash path the renderer cannot see: when a primary application
  window reports `render-process-gone` with a recoverable reason (`crashed`,
  `killed`, `oom`, `launch-failed`) and the app is not quitting, Main reloads that
  window in place, bounded to two automatic reloads per window so a crash loop
  cannot spin; the reload is deferred by one macrotask and re-checks window and
  WebContents liveness so it never runs against a half-torn-down object. Exceeding
  the budget logs an explicit warning instead of silently leaving the window dead.
  Non-primary windows keep their existing handling.
  The existing main-application WebContents registry identifies workspace
  windows before their first Host attachment; About, resource manager, update
  prompts and other auxiliary windows must not consume the recovery budget.
  In-place reload is the first-line recovery on every platform; the coordinator's
  discard-and-recreate of a crashed window stays the last resort (macOS `activate`,
  or a later primary-window request on other platforms), never the first response.

### Follow-up turn reliability and send latency

#### Interrupted-continue state diagnostics

The native Codex thread owns execution; the bridge owns the derived projection
and command admission; the renderer only owns its last applied snapshot. A
subscribe ACK reserves a route but does not prove that the initial frame reached
the renderer. For initial and recovery snapshots, record one bounded,
content-free state summary when the bridge has prepared the frame and another
when the renderer has applied it. Include session ID, subscription ID, log epoch,
sequence, projected phase and last visible turn ID. Do not log online frames,
item content, workspace paths, prompts or credentials. If a requested
interrupted-turn continuation is refused because any turn is `inProgress`,
record its command ID, native thread status, latest turn status, selected running
turn ID, number of `inProgress` turns and bridge epoch/sequence/revision.
Forward only strictly validated bridge stderr diagnostics into production logs;
malformed, oversized or unexpected fields remain debug-only. Diagnostics must
never change admission, retry or subscription ordering, or throw into the
runtime. Desktop continuous and mobile replayable both retain their existing
snapshot and recovery semantics.

```text
Codex events/history → Bridge state → prepared initial/recovery snapshot
                                      └→ command guard (same native owner)
desktop/mobile transport → renderer applied snapshot → continue intent
```

Regression acceptance: a prepared snapshot without a delivered frame has no
renderer-applied record; a delivered initial/recovery snapshot records the
same epoch/sequence/phase at both ends. A previous `inProgress` turn followed
by an interrupted latest turn produces a refusal summary identifying the
older turn without changing the failed ACK. No arbitrary stderr text, path,
item or prompt may be promoted into production logs.

For a missing initial/recovery frame, the attachment and renderer must expose
the intervening one-shot checkpoints: validated terminal physical wire received
by the service, that wire forwarded/staged/released or dropped by connection
ownership, physical wire received by the renderer, logical frame assembled,
and the logical frame routed to an open store or discarded due to missing/stale
ownership. Correlate by bounded session/subscription IDs, delivery kind and
logical ordinal; the assembled frame may also include epoch and sequence. A
fragmented snapshot logs only the terminal physical fragment per checkpoint,
not every chunk; online/stream frames remain debug-only except typed assembly
faults, whose bounded reason code must reach production logs. Record proxy replacement
and runtime invalidation with bounded subscription counts and reasons. Production
diagnostics must not contain raw wire payloads, conversation text, workspace
paths, credentials or arbitrary error messages. A logging failure must not
interfere with frame routing, replayable recovery or desktop continuous delivery.

```text
Bridge prepared → service received → attachment owned/staged/released
                → renderer physical received → logical assembled
                → store routed/applied (or bounded reason for discard)
```

Regression acceptance: a wire discarded before ACK due to a different ACK
subscription ID has an attachment reason;
one received at the renderer but not assembled has no logical checkpoint;
one assembled for a closed store or old subscription has an explicit discard
reason. Same tests cover desktop and replayable subscriptions without logging
ordinary online frames or changing owner/sequence rules.

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

### Root startup ownership

The local Host has already selected whether its default agent command is the native
Codex bridge. Expose that resolved fact through its existing system-info service;
the renderer must not infer agent mode from the desktop product flavor, window
kind, environment variables, a model name or the presence of legacy settings.
Until the Host replies, Root does not subscribe to or refresh the old Provider
Settings View. When the Host reports Codex, Root skips the old provider-family
migration, Provider Settings subscription, legacy OAuth restoration and
account-connection-loss subscription/refresh entirely. Its renderer-ready
notification must still be sent once so Main can deliver unrelated deep links.
Before notifying Main, it installs a transport-only callback for obsolete Codez
OAuth links: the preload sends its existing handled receipt after the callback
returns, but the native branch never calls the legacy OAuth service, logs URL
content or applies a legacy account. Without this receipt, Main would consume a
pending deep link and keep its launch gate waiting indefinitely. The explicit
legacy path continues to register its full existing OAuth callback before ready.
Re-rendering/re-subscribing a callback due to locale or other UI dependencies
does not re-notify Main for the same platform/renderer instance; a new renderer
instance must still notify Main once after installing its callback.
Other desktop runtimes, including an explicit legacy command/custom resolver,
and Web continue the current migration/refresh/subscription/OAuth path.
Older Hosts with no runtime
fact retain the legacy startup path; a failed Host-info read also falls back to
the preexisting legacy path and reports the read failure. This is a startup
routing fact, not another owner of native account/config/model state.

```text
Host selects command resolver → system info reports selected runtime kind
                                  ↓
                           Root waits for mode
                   ┌──────────────┴────────────────┐
             native Codex bridge              legacy/custom/Web
             skip old Provider path    migrate → refresh → subscribe View
             notify renderer ready      restore OAuth → observe connection
                   └──────────────┬────────────────┘
                         workspace/UI shell stays available
```

Acceptance: in an isolated default Codex Host, first render/reload makes no
legacy Provider refresh/getView/onDidChange, cached OAuth restoration or
provider-family migration write; Main still gets renderer-ready. The model
selector still obtains native `config/read` + `model/list`
from the selected workspace. Explicit legacy-command/custom-resolver Host and
Web continue their existing provider startup flow. Failed/missing info is
visible in diagnostics but cannot block the desktop shell. This change does
not alter desktop continuous or mobile replayable session delivery.
If a Host changes while the legacy migration's settings refresh is pending,
the old effect must re-check ownership after that await and must not initiate
a Provider refresh for the new Codex Host. A pending legacy OAuth deep link on
Codex is acknowledged by the preload/Main transport handshake without touching
legacy account state or stalling launch telemetry.
The same rule applies to the legacy OAuth cached-session restore path: after
reading the active provider and after refreshing its restored family selection,
check the original effect/Host is still current before refreshing Provider
state. An in-flight old Host response must not start a new Provider RPC after
native Codex has taken ownership.
The restored family selection helper itself awaits settings, Account Provider
state and entitlements. Pass the same ownership guard down that startup-only
path and re-check it before each subsequent read/refresh or settings write;
an outer guard after the helper returns cannot undo an old Provider refresh
or conditional selection write that the helper already started. The interactive
legacy login path without a startup owner keeps its existing semantics.
Likewise, the provider-family migration helper awaits settings, OAuth provider
and model selection before its setting write. Pass the Root effect guard into
that existing one-caller helper; after each await it must stop before initiating
the next old-service read or write when the Host changes. Completion after
effect disposal must not claim a new Codex Host performed legacy migration.
If a legacy Provider View read completes after its Root subscription is disposed,
the detached result must not publish a ready/error snapshot or remain available
to readers on the new Host. Likewise, a legacy OAuth callback/poll that was
already in flight before a switch may finish on its original transport, but
must not subsequently write Root's old account display/selection, refresh
the old Provider state or report login success after Codex takes over. The
transport still acknowledges the received deep link. Guard each subsequent
effect-owned continuation, including the steps inside a successful callback;
an already-started Host RPC cannot be retroactively undone.
An old cached-session reauthentication prompt belongs to the same legacy
effect: disposal cancels only that pending prompt, without dismissing an
unrelated dialog, and a late confirmation cannot initiate legacy reauthentication
on Codex. The dialog store remains the single owner of its pending request.

The legacy dynamic-workflow availability request is also a Root startup path,
not a native Codex capability. While the runtime mode is pending or Codex,
Root does not query its old coding-plan service and its UI projection stays
disabled, including when a previously enabled legacy response arrives late.
Web and explicit legacy Hosts retain the existing one-fetch-per-service
behavior. This gate does not imply that unsupported workflows have acquired
native parity.

The existing legacy runtime still advertises `workflowRunDeltas`. The base
Agent service owns that runtime fact; attachment hello forwards it only when
the base service explicitly advertises it. A native Codex or unavailable bridge
must not acquire legacy workflow support from an attachment or client claim.
Acceptance: legacy hello plus client declaration preserves trusted deltas on
subscriptions; a Codex hello without the capability does not advertise deltas.

```text
legacy Root effect → old OAuth / Provider / workflow read
       ↓ Host switch → effect disposed / generation invalidated
late old result → no new Root write, snapshot publication or workflow enable
       ↓ native Codex account/commands remain the sole authority
```

Acceptance: hold a legacy deep-link callback or polling result, Provider View
read and enabled workflow response; switch the same renderer to Codex, then
release each result. The deep link gets a transport receipt but causes no
new old account/UI mutation or Provider refresh, Provider View does not expose
the detached result, and the workflow entry remains disabled. A subsequent
legacy Host still loads fresh snapshots and preserves interactive login.
Hold a legacy reauthentication prompt across the switch: it closes without
confirming or invoking the old reauthentication action; an unrelated prompt
opened afterward remains owned by its own caller.

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
   invalid frames and process death reject pending operations; oversized frames
   skip with bounded diagnostics and fail the affected requests without killing
   the connection.
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
index, including conversations created by Codex CLI outside this desktop and
newly added projects whose workspace tab has not been activated yet (local roots
through base session discovery; online remote roots through the existing
Source settings attachment after workspace identity resolution). Explicit
`session/list` discovery on an unloaded workspace ensures the workspace's
`taskIndexSyncer` subscription is registered before starting the read-only
runtime so `runtimeLifecycle(available)` and the post-response
`sessions-index` refresh seed missing shell rows into `tasks-index.sqlite` and
notify `state:projects` even before a conversation tab is opened. In addition,
each Codex Host (local and standalone remote Source Server) watches its native
`$CODEX_HOME/sessions` rollout tree (initial scan on startup, which still walks
and stats the whole tree and still reconciles every candidate session against
`tasks-index.sqlite`, but reuses the durable per-file parse facts described above
so unchanged rollouts are not re-parsed on each process start + debounced
recursive fs watch with polling fallback only while recursive watch is unavailable + `readTree` catch-up, caching parsed `session_index.jsonl` thread names across unchanged `mtime`/`size` checks) to index user-facing CLI/exec/vscode/
appServer rollouts across all directories—including directories that have not
been added as projects—into `tasks-index.sqlite` via `applyCliFacts` and
publish `state:projects`. A warm
connection is not proof that the persisted thread list is current. Discovery is
read-only, paginated, scoped to the execution cwd and the remote attachment's
existing workspace identity; it never copies history into a second execution store.
Rollout head scanning must not promote Codex's earlier user-role
`<environment_context>` response item to the session title. The same holds for the
user-role `# AGENTS.md instructions for <dir>\n\n<INSTRUCTIONS>…</INSTRUCTIONS>`
fragment Codex persists before the first real user message in native sessions;
neither injected fragment is a user query or a title, even when the rollout carries
no `## My request for Codex:` separator. The scanner waits for the first
real user-message event (`user_message` or `item_completed/UserMessage`, including
the pinned native item's spelling), then derives the first-query title. Legacy
rollouts with only a clearly non-injected user-role response item may use that
item as a fallback, after user-message events and before a goal objective. A context-only
rollout creates no provisional title row through this scanner. A later file change
or initial scan after upgrade repairs a previously indexed injected-context title
using the same task ID and workspace identity, without changing organization,
archive/deletion, manual-title override or timestamps to Host wall time. Native
`thread/list` may arrive independently: injected-context previews remain
provisional rather than replacing a valid title, while accepted first input still
reaches the sidebar without waiting for an automatic model-generated name.
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
Host project storage also persists nullable resolved physical paths
(`project_roots.physical_path` and `tasks.physical_root_path`, backfilled
idempotently at startup without resetting `OWNERSHIP_DECIDED` or re-keying
`workspace_key`/`workspaceIdentity`) so symlinked project roots and physical
rollout cwds converge in both directions: cross-spelling writes for the same
`(host_id, task_id)` update the existing row in place instead of failing on the
unique index, first-discovery `uniqueRootProject` and remote directory checks
compare physical paths with a literal fallback when `realpath` is unavailable,
and single-root project views match same-host tasks by physical path while
preserving their original `workspacePath` and `workspaceIdentity` for resume.
Legacy `session/read`, `session/resume` and `session/list` projections must carry
both the authorized `workspaceKey` and explicit `workspaceIdentity`. Downstream
task-index persistence consumes `workspaceIdentity`, not `workspaceKey`; dropping
it would silently file remote conversations under a local-path partition. A fresh
native scan rebuilds the correct remote shell rows without deleting legacy data.

```text
project activation → scoped session/list → native thread/list
                          ↓ after response
existing index subscribers refresh (command ACK / turn/started / userMessage completed / rename / completed) → native thread/list
                                                          ↓
remote task-index syncer → insert missing shell metadata → workspace list invalidation
                                                          ↓
Window Host task membership + native live details → single-root directory view
                                                          ↓
user opens unclassified history → remote Host validates indexed task, workspace
 identity and cwd → native resume without roots override
                                     ├─ desktop continuous: existing Host attachment
                                     └─ mobile replayable: same session, snapshot + replay
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

## Writer-conflict read-only sessions

A historical thread can be held by another live writer (another window, CLI, or
app-server process). `thread/resume` then fails with JSON-RPC code `-32600` and a
message containing `already has an active writer` (Codex `rollout/writer_lock.rs`).
Both the code and the message must match; any other resume failure still rejects the
load and keeps the existing error surface.

- On a matching writer-conflict failure, load degrades to read-only instead of
  failing: the lock-free `thread/read` response envelope is projected through the
  same `decorateNativeThread` path, `thread/turns/list` pagination builds history,
  live notifications keep merging into the projection, and the state is marked
  `readOnly: "writer-conflict"`. The conversation renders history plus live
  projection; it never silently claims write authority.
- The native queue list is not read in this degraded mode (its lock semantics are
  not part of the verified lock-free read set), so the queue projects as empty.
  Bridge-local command ledger reads stay available; queue mutations are commands
  and are rejected by the guard below.
- Command admission is deny-by-default while the mark is present: every
  existing-session command is rejected with reasonCode `guard.codex.writerConflict`
  except `forkAssistant`. `thread/fork` reads the source rollout without taking the
  source write lock, so fork is the sanctioned escape hatch; a cold fork on an
  unloaded conflicted thread still completes the load fallback before dispatching.
  Enumeration is deliberately avoided so future write commands (file rewind, goal
  mutations) are covered automatically.
- The conversation snapshot carries the additive optional marker
  `writerConflict: { readOnly: true }`; old snapshots and old senders omit it and
  are treated as writable (schema freeze rule: optional/additive only). In
  read-only mode snapshot availability keeps `fork` idle-gated, blocks `compact`,
  `switchModelConfig`, `queueEdit` and `sendQueuedNow` with
  `guard.codex.writerConflict`, and suppresses userInput edit/retry row actions.
- The UI derives the mode from the snapshot field only: the timeline renders
  normally with a bottom-dock read-only banner (zh/en, with retry action) in place
  of the composer so it does not collide with the top-right status capsule; the
  composer, editable bottom-dock surfaces, drop target, Esc-stop and row
  edit/retry are disabled, and row fork actions stay enabled.
  The existing subagent-observer `readOnly` pane prop is not reused because it
  also disables fork.
- Recovery is explicit: conversation subscribe and resync invalidate a
  writer-conflict read-only entry, so the next snapshot read re-runs the load and
  retries `thread/resume`; a healthy thread is never invalidated. A full bridge
  reconnect naturally reloads everything. Once resume succeeds the projection is
  writable again with no marker.
- In the Desktop workbench, explicitly selecting a writer-conflicted task again
  is also a refresh intent, including a click on the already selected row and a
  return while its `SessionDataLayer` entry is keep-warm. The selected workspace endpoint,
  `workspaceIdentity?.trim() || workspacePath`, remote session and thread ID must
  address the same existing projection. That projection makes one in-flight
  subscribe/retry attempt shared by its panes; a missing entry follows the normal
  cold subscribe path. Selecting a healthy writable task, rendering a pane,
  focusing the window or receiving a sessions-index update does not force a
  conversation reload. The banner retry action uses the same attempt.
- A refresh keeps the last successfully read timeline visible and read-only until
  the replacement snapshot is complete. If the external writer still holds the
  lock, `thread/turns/list` refreshes the native-persisted history without
  duplicate rows and the writer-conflict guard remains. If the writer released
  the lock, successful `thread/resume` clears the marker and restores writable
  actions. A failed read or resume never clears the guard or discards the last
  good timeline; stale responses from a prior workspace, thread, or connection
  cannot replace the current view. The refresh itself must not change task-list
  membership, unread state, project assignment or activity time; the existing
  explicit task-selection unread clear remains a separate action.
- Waiting for the replacement frame applies only to writer-conflict refresh.
  Ordinary failed-subscription retry completes on its subscribe ACK: a valid
  equal-watermark CLI resume may emit no initial frame at all.
- External CLI/TUI writers do not deliver thread notifications to this bridge
  connection. The read-only view therefore promises only history persisted by
  Codex at the last successful refresh, not streaming-token parity or automatic
  following. The banner must describe the writer conflict as the result of the
  last check and offer "refresh history and retry" in both locales. No timer or
  background focus retry may call `thread/resume`: native cold resume can dispatch
  queued work, so claiming write authority remains an explicit user action.
  Desktop continuous and mobile replayable subscribers retain their existing
  independent delivery and recovery semantics.

```text
external TUI ── owns native writer lock; persists turns ──> Codex history
user selects task / presses retry
  └─> Renderer shared conversation store (one refresh attempt per thread)
       └─> trusted Host attachment ──> Bridge invalidates only the conflicted projection
            └─> native thread/read → thread/resume → thread/turns/list
                 ├─ writer still active: new persisted history + read-only snapshot
                 └─ lock released: attached history + writable snapshot
       desktop: desktop-continuous     mobile: web-remote-replayable
```

Acceptance: while an external writer remains live, append native-persisted turns
and explicitly reselect the thread; the new history appears once and all write
commands remain guarded. After the writer exits, reselect the same thread within
the keep-warm period; the first completed refresh removes the read-only marker
and restores the composer. A healthy thread, a different workspace identity,
an unrelated pane and repeated clicks during an in-flight refresh must not
cause an additional native history load or a cross-session state change.
