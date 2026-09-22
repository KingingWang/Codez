# Codex bridge

Codex owns execution, threads, persisted items, queues, credentials and configuration.
This executable translates desktop contracts and derives rebuildable projections.
It is not imported by services; the boundary is stdio. The public TypeScript port
allows fake transports in tests. Unknown mutations fail closed, and mutations
with an unknown outcome are never blindly retried. No real user credentials are
used by tests. See specs/codex-desktop-adapter.md for recovery and delivery rules.

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
