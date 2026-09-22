# Codex remote project discovery validation

## Scope and diagnosis

The supplied macOS report came from the build based on `e7865fff`. Remote
execution used the intended remote cwd, but project membership could remain
empty. Three adapter/index boundaries required correction:

- Legacy snapshots supplied a workspace key but omitted `workspaceIdentity`.
  The shell task index consumes the latter, so remote rows could be indexed
  under the local-path partition.
- Initial index seeding committed rows without invalidating an already cached
  empty Host membership list.
- A warm connection did not rescan history created externally. The pinned native
  `thread/list` default also excludes other providers and non-interactive exec
  sessions unless explicitly requested.

Only ZCode is changed. Native Codex source, credentials, history and user log
archives are not modified or included in the commit.

## Ownership and behavior

`useCodexProjectDiscovery` invokes the existing workspace-scoped list service on
desktop project activation, reconnection and window focus. In-flight focus calls
coalesce. Tab/conversation metadata updates do not initiate another scan, and a
disconnected remote target never falls back to local services.

The bridge lists paginated native history for the execution cwd across providers
and user-facing sources. After an explicit list response it refreshes existing
index subscribers; targeted repair reads do not recursively invalidate them.
The remote task-index syncer remains the only shell-row writer. It inserts missing
rows in bounded batches and publishes a scoped invalidation after commit without
overwriting pins, archive/deletion state or custom titles. Discovered historical
terminal sessions do not resume native history or replay completion/unread events.
Opening a discovered conversation resumes the original native thread ID.

Desktop-continuous and mobile-replayable consumers retain their existing
connection ownership and recovery behavior. No second UI history store is added.

## Physical path matching

Discovery ownership is decided by physical directory, not by path spelling. Codex
persists two cwd representations for one thread: `thread/list` returns the raw
rollout value (the literal `thread/start` cwd or the CLI `getcwd()` result), while
`thread/read` returns the canonicalized store value with Windows verbatim prefixes
stripped. The two can disagree for the same thread, and both can differ from the
path the desktop supplied.

Strict string equality therefore dropped discovered history on macOS, where
`/var/folders/...` is a symlink to `/private/var/folders/...`, and rejected resume
on Windows, where temporary directories use 8.3 short names such as
`C:\Users\RUNNER~1\...`. List filtering, resume ownership and `thread/started`
attribution now canonicalize both sides and keep a raw-equality fallback for
directories that no longer exist. Canonicalization never widens ownership:
relative input and genuinely different directories stay rejected.

The Linux CI lane originally masked this because `/tmp` is not a symlink. The
native regression now starts Codex and the store from a symlink alias (a junction
on Windows), so every lane reproduces the alias-versus-physical spelling split.

## Verification

Commands run using Node 24.14.0 and pnpm 10.33.2:

| Check                                                  | Result                                           |
| ------------------------------------------------------ | ------------------------------------------------ |
| `pnpm typecheck`                                       | Passed                                           |
| `pnpm lint`                                            | 0 errors, 70 warnings                            |
| `pnpm fmt:check`                                       | Passed                                           |
| `pnpm architecture:check --changed`                    | 0 violations, 0 baseline                         |
| Bridge suite with `CODEX_AUXILIARY_TEST_BINARY`        | 324 passed, no skips                             |
| Services/desktop/server Codex tests                    | 42 passed, 1 opt-in packaged-assets test skipped |
| Codex UI settings tests                                | 24 passed                                        |
| Distribution + bundled bridge + native discovery smoke | 46 passed, no skips                              |
| Browser interaction runner                             | 20 checks passed, no page errors                 |

The new real-native fixture uses isolated temporary `CODEX_HOME` and a loopback
model server. It creates persisted `codex exec` history, creates a desktop thread
with a different provider, rejects another cwd, and resumes the external thread
for a second completed turn. It runs after native executable verification on
all six targets in the existing automatic-release workflow.

The SQLite regression covers commit-before-invalidation, preservation of shell
state, late history discovery without native `readSession`, repeated scans,
same-path remote identity isolation and disposal during an asynchronous scan.
Browser checks exercise the actual hook, TabStore and remote service registry,
with injected RPC services rather than a real SSH server.

## Validation limits

Local verification is Linux x64. A live macOS-to-SSH desktop session and native
macOS/Windows packaging are not claimed as locally tested; the release matrix
provides the cross-platform build/native-smoke checks. Existing misplaced shell
rows are not destructively migrated: reopening the connected project discovers
native history and rebuilds the correct remote membership.
