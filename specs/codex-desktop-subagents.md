# Codex desktop subagents (agent roles)

Status: implemented 2026-09-24. Manages Codex **file-based agent roles** from
Settings → Subagents in the Codex desktop adapter. The adjacent Codex checkout
(`codex-rs/agent-roles`) is read-only reference for the file format; this
repository never modifies it.

## Scope model

Codex discovers standalone role files recursively under `<config folder>/agents/`
for every config layer (`codex-rs/agent-roles/src/discovery.rs`). The panel
manages exactly two of those directories:

| Scope     | Managed directory                                       | Identity                                   |
| --------- | ------------------------------------------------------- | ------------------------------------------ |
| `user`    | `${CODEX_HOME}/agents/` (`~/.codex/agents/` when unset) | bridge process env / home                  |
| `project` | `<attachment cwd>/.codex/agents/`                       | the workspace the bridge attachment serves |

`CODEX_HOME` is read from the **bridge process environment**, matching
`find_codex_home()` semantics (env override, else `~/.codex`). For a remote
(SSH/WSL) workspace the bridge runs on the remote host, so both directories
resolve to remote paths; the desktop never reads the local Codex home for a
remote workspace.

Roles declared **inline** in `config.toml` layers (`[agents.roles.<name>]`,
including `config_file` references) are **out of scope for v1**: the panel does
not list, edit, or delete them, and does not claim the two directories are the
complete effective role catalog. UI copy states this explicitly.

## Transport

The Codex app-server exposes no agent-role RPC. `agents/*` must therefore never
enter `codexRequestMethodSchema` (`packages/shared/src/codex-runtime.ts`): that
allowlist is forwarded to the native process and an unknown method would be a
native error.

Instead the family travels as **top-level bridge control-plane methods**,
following the `plugins/*` precedent:

```text
UI panel → ICodezAgentService.list/write/deleteAgentRole
        → getReadOnlyClient(params)          (actual workspace carrier)
        → client.request(agents/list|write|delete, { workspace, ... })
        → Host/attachment routing (unchanged, identity-keyed)
        → bridge control-plane dispatch → control-agents.ts (fs I/O)
```

- Method names register in `codezProtocolMethods`
  (`packages/shared/src/codez-protocol/index.ts`): `agentsList: "agents/list"`,
  `agentsWrite: "agents/write"`, `agentsDelete: "agents/delete"`, with zod
  params/result schemas in the same protocol area.
- `packages/codex-bridge/src/control-plane.ts` adds the three names to its
  `methods` set and dispatches `agents/*` to `handleAgentRequest` in
  `control-agents.ts`. `bridge-runtime.ts` needs no change: it already routes
  every `supportsControlMethod` name with `{ rpc, cwd }`.
- Every params schema carries `workspace: codezWorkspaceRefSchema`; the bridge
  runs `checkWorkspace`, so the request workspace must equal the attachment cwd
  (fail closed on mismatch).

## Carrier rule (mandatory)

Every `agents/*` service method resolves its client through
`getOrStartReadOnlyClient(params)` / `getReadOnlyClient(params)` — the actual
workspace carrier. `getPluginManagementClient()` is forbidden for this family:
its synthetic management cwd would fail the bridge workspace check for project
scope, and it is always a local process, so remote (SSH identity) workspaces
would silently manage the wrong machine's files. Project scope must resolve to
`<actual workspace cwd>/.codex/agents` for local and remote targets alike;
service tests prove both.

## File schema and validation

A role file is TOML (`<name>.toml`). Managed fields, mirroring
`agent_role_config.rs`:

| Field (TOML)             | Wire field (camelCase)  | Rule                                                                                                                             |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | `name`                  | required, non-blank after trim. Files without it fall back to the filename stem in Codex; the panel always writes it explicitly. |
| `description`            | `description`           | optional; trimmed; present-but-blank is invalid.                                                                                 |
| `developer_instructions` | `developerInstructions` | **required non-blank** for standalone files (it is the role's system prompt).                                                    |
| `model`                  | `model`                 | optional; trimmed; blank clears the key.                                                                                         |
| `model_reasoning_effort` | `modelReasoningEffort`  | optional; trimmed; blank clears the key.                                                                                         |
| `nickname_candidates`    | `nicknameCandidates`    | optional non-empty list; entries trimmed non-blank, deduplicated, ASCII letters/digits/space/`-`/`_` only.                       |

Any other `ConfigToml` keys may exist in user files and are **preserved on
edit**: the bridge parses the TOML, merges the managed key set (set or remove),
and serializes back. Unknown keys, nested tables and non-managed values round
trip. TOML comments and formatting do **not** survive a panel edit
(parse→serialize is semantic, not textual); this is accepted for v1 and must
not be silently extended to claims of byte-fidelity. TOML handling uses
`smol-toml`, a direct dependency of `@codez/codex-bridge` at the workspace's
pinned version.

Validation failures reject the write with a JSON-RPC invalid-params error;
nothing is written. `agents/list` never fails the whole listing for one bad
file: malformed files are reported in `diagnostics` (scope, file, message) and
well-formed files still list.

## Write safety

- **Filename derivation (create only):** `<name>.toml`, where `name` must match
  `^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$` after trim. No path separators, no dots,
  no traversal. Existing files whose effective name (declared `name` or
  filename stem) does not fit this charset can still be listed, edited in
  place, and deleted — they are addressed by scanning, never re-derived.
- **Create vs update:** create fails if a file already yields the same
  effective name in that scope. Update (`originalName` present) requires an
  existing file whose effective name matches; renaming is not supported
  (delete + create instead), so one name always maps to one file and no orphan
  files are left behind.
- **Symlink refusal:** the managed directory is canonicalized once with
  `realpath` (a symlinked `~/.codex` stays usable). Symlinked `.toml` entries
  are never read or listed as roles — the scan skips them with a
  `symlink_skipped` diagnostic — and a create whose derived target path is a
  symlink is refused (`lstat` check) so nothing is ever written through a
  link. Update/delete of a symlinked name fail closed as not-found.
- **Confinement:** edit/delete resolve strictly inside the canonical managed
  directory (`path.relative` must not escape); nested files discovered by the
  recursive scan remain addressable, but never outside the managed root.
- **Atomic write:** content goes to a unique temp file in the same directory
  and is renamed over the target. A failed write leaves no partial role file.
- Mutations are never silently retried; failures surface to the UI with the
  bridge reason.

## Freshness semantics

Codex loads agent roles when a thread's config is built. The panel therefore
states "changes apply to **new** sessions/threads" and makes no runtime reload
promise. After a mutation the UI refreshes the file listing; running sessions
are unaffected.

## UI surface

Settings → Subagents in the Codex adapter routes into
`CodexSettingsSection` as an `agents` panel (instead of the former "not
supported" notice):

- `isCodexSettingsSection` includes `subagents`; `isCodexUnsupportedSection`
  no longer lists it; `SettingsPage` maps it to `initialPanel: "agents"`.
- `CodexAgentsPanel` lists roles grouped by scope (user / project), each row
  showing name, description, model/effort and the file path. Create opens a
  validated form (name, description, model, reasoning effort, developer
  instructions, nickname candidates); edit reuses the form with the name
  locked; delete requires confirmation. All mutations refresh the list.
- Copy (zh + en) states the file-scope model, the new-session freshness rule,
  and that inline config-layer roles are not shown.
- The legacy markdown Subagents service (`packages/services/src/subagents/**`)
  is a different format with its own state owner and is deliberately not
  reused.

## Failure semantics

- Workspace mismatch, invalid params, unsafe names, symlink targets, missing
  update targets and name conflicts fail closed with JSON-RPC errors; the UI
  shows the message and does not retry.
- A missing managed directory lists as empty, not as an error.
- The Codex native request path (`codex/request`) is unchanged and carries no
  `agents/*` methods.
