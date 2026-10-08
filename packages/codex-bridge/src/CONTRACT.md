# Codex bridge

Codex owns execution, threads, persisted items, queues, credentials and configuration.
This executable translates desktop contracts and derives rebuildable projections.
It is not imported by services; the boundary is stdio. The public TypeScript port
allows fake transports in tests. Unknown mutations fail closed, and mutations
with an unknown outcome are never blindly retried. No real user credentials are
used by tests. See specs/codex-desktop-adapter.md for recovery and delivery rules.

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
history. Sidebar invalidation shares the existing coalescing publisher but never
blocks ordered conversation events. Production fatal diagnostics include fixed
failure categories and origin labels, not arbitrary exception text or user paths.

Project discovery lists native user-facing history across providers in the scoped
cwd. A generic legacy session-list read invalidates existing index subscriptions
after replying; targeted repair reads do not recursively invalidate them. Legacy
session responses retain the Host-authorized workspace identity as well as its
key, because shell task-index persistence consumes the identity field. Discovery
does not resume threads; explicit conversation opening retains the native resume
path. Native history is never copied, moved or deleted to repair shell visibility.

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
bridge retains only a validated HTTP status code for the current in-progress turn
and projects it through V4 `control.apiRetry`; it never persists native error
text, fabricates retry counts or replays mutations. Model progress, terminal
notifications and turn completion clear the observation. Both delivery modes
read the same current snapshot; native thread history cannot restore the status
after a bridge restart.
