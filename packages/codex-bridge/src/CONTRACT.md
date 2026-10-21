# Codex bridge

Codex owns execution, threads, persisted items, queues, credentials and configuration.
This executable translates desktop contracts and derives rebuildable projections.
It is not imported by services; the boundary is stdio. The public TypeScript port
allows fake transports in tests. Unknown mutations fail closed, and mutations
with an unknown outcome are never blindly retried. No real user credentials are
used by tests. See specs/codex-desktop-adapter.md for recovery and delivery rules.

The local native-control MCP carrier has independent Browser and Computer Use
enablement gates. Browser broker readiness never authorizes or hides CUA tools.
The Local Host owns the authenticated Helper grant; the MCP reads its private,
atomic projection at each CUA call, with bounded cancellable waiting only while
the grant is absent. It never restarts an Agent or replays a desktop action to
recover readiness. Remote browser relays receive no local CUA grant. See
specs/computer-and-browser-control-isolation.md for the settings matrix and
the remaining runtime-restart / Windows live-verification boundaries.

The Host-authorized `desktopContextPromptEnabled` process option adds a native
developer section at the transport's create/resume/fork admission boundary.
`desktop-context.ts` owns its text and composition. Effective user developer
instructions are preserved, configuration reads are fresh and failures reject
admission before mutation. Model/base and collaboration instructions are never
replaced; configuration files and history are never rewritten. Ephemeral/system
generators and non-desktop processes are unchanged. See
specs/codex-desktop-context-prompt.md for precedence and recovery boundaries.

Presentation identities are turn-scoped; raw native IDs remain the RPC authority.
The session index collapses duplicate native thread records without changing
history. Sidebar invalidation shares the existing coalescing publisher across
command completion, thread lifecycle, `turn/started` and completed `userMessage`
items so a newly persisted first turn becomes visible without waiting for title
generation or turn completion, while never blocking ordered conversation events.
Production fatal diagnostics include fixed
failure categories and origin labels, not arbitrary exception text or user paths.
Ordinary native RPC timeouts emit a bounded stderr warning containing only the
allowlisted native method name, elapsed milliseconds, and pending request count.

Project discovery lists native user-facing history across providers in the scoped
cwd. A generic legacy session-list read invalidates existing index subscriptions
after replying; concurrent workspace-wide `store.list()` scans coalesce only
while in flight so discovery and index subscribers share one `thread/list`
paging pass without retaining a stale cache after completion. Targeted
`sessionIds` reads inspect loaded state or lock-free
`thread/read` metadata without scanning all workspace threads or recursively
invalidating index subscriptions. Legacy
session responses retain the Host-authorized workspace identity, key, and verified
`workspacePath` spelling (falling back to a local path-alias `workspaceId` when
omitted), because Host lineage verification and shell task-index persistence match
project roots by the caller's path spelling while native execution uses `store.cwd`. Discovery
does not resume threads; explicit conversation opening retains the native resume
path. `v4/sessionsIndex/reconcile` inspects bridge tombstones, loaded state and
lock-free `thread/read` metadata without scanning or resuming threads; `deleteSession`
on an unloaded thread verifies workspace ownership via lock-free `thread/read`
without resuming, and treats an already-deleted or rollout-missing thread as
idempotently deleted so `reconcile` can confirm deletion.
Native history is never copied, moved or deleted to repair shell visibility.

For local multi-folder Codez projects, Host-validated creation supplies the
primary cwd and additional directories to native `thread/start.runtimeWorkspaceRoots`.
A namespaced native `threadSource` carries only the _initial_ Host project-origin
hint; it is not Codex's own `projectId`. Native summaries pass that hint to Host
for first insertion, never subsequent reassignment. An assigned task's cold
resume supplies current `[thread.cwd, ...additionalDirectories]`, while a
task with no explicit Host project omits the override to preserve native
persisted roots. A loaded runtime does not refresh on re-subscribe. Single-root
directory membership is a read-only Host task-list projection, not a Codex
thread mutation. See specs/codex-desktop-adapter.md.

Native workspace membership is decided by physical directory, never by path
spelling. Codex can return two different cwd representations for one thread — the
raw rollout value from `thread/list` and the canonicalized store value from
`thread/read` — so list filtering, resume ownership and `thread/started`
attribution canonicalize both sides (macOS `/private/var`, Windows 8.3 short names
and verbatim `\\?\` prefixes). A canonicalization failure falls back to raw
equality and must never widen ownership: relative paths and genuinely different
directories stay rejected.
Attribution therefore needs filesystem resolution, so native event projection is
asynchronous. The runtime keeps one serialized event tail, which preserves native
ordering, and request/response paths still project their own turns synchronously.

Native app-server `error` notifications with `willRetry: true` are transient,
turn-scoped retry observations, not terminal errors or bridge retry commands. The
bridge retains only a validated HTTP status code, optional validated positive
integer `(attempt, maxRetries)` counts, and a bounded `errorDetail` for the
current in-progress turn and projects them through V4 `control.apiRetry`; it
never persists native error text, fabricates retry counts or replays mutations.
Model progress, terminal notifications and turn completion clear the observation.
Both delivery modes read the same current snapshot; native thread history cannot
restore the status after a bridge restart.

Subagent child threads stay Codex-owned: the parent thread's collab items are the
only source of child identity, and a child is projected as a read-only session
(`readOnly: "subagent-child"`) that never accepts writes, never enters the
session index, and is listed only through `session/subagents` by parent id.
Attach uses the native resume path only while Codex already has the child loaded
(`idle`/`active`), where resume means replay-plus-subscribe; a `notLoaded` child is
projected from lock-free reads without resume, because resuming it rewrites the
child rollout and bumps the `updatedAt` that `session/subagents` reports as
`endedAt`. Any resume refusal still degrades to a read-only snapshot instead of
failing the view. See specs/codex-desktop-subagent-drilldown.md.

A running subagent must leave `snapshot.subagents.running` when its task ends;
the parent thread's collab items are the primary fact, but native v1/v2 often
never write a terminal fact there. The bridge therefore also tracks child-thread
liveness: the loaded child's native `status`, `turn/started` / `turn/completed`
/ `thread/status/changed` events for any thread (native auto-attaches a listener
for initialized connections when a child thread is created), and a one-shot
`thread/list` seed for children spawned before the bridge connected. A child
observed non-active stops the status-panel timer without waiting for parent-side
facts; a re-driven child (`turn/started`) becomes running again, matching native
resume semantics. Child lifecycle events touch the parent session so
re-projection is immediate. Unobserved children keep the parent-side fact.
