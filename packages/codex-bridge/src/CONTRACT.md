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
