# ZCode official plugins in Codex desktop

## Product contract

The desktop plugin-store entry opens the existing ZCode store experience in Codex mode.
Its Public segment presents the available official ZCode catalog, and its install,
enable, update and uninstall actions operate on the same native Codex plugin state
as Codex CLI. Installing is an explicit user action; opening the store must not
install or enable a plugin. Changes to the user's Codex configuration are visible
to other Codex clients on the same host.

The official online catalog uses the published ZCode marketplace identity
`zcode-plugins-official`; Codez's existing canonical UI identity remains
`codez-plugins-official`. Only the configured official source may map between
these identities. A personal source claiming the canonical identity is rejected.
Built-in definitions without shipped package assets are not installable entries.
The existing desktop Browser/CUA broker remains the Codex browser owner; the
ZCode-only node-repl host is not a separately installable Codex plugin.

## Owners and delivery

```text
Store action → IPluginManagementService → Host identity/lease route
  → Codex bridge (official catalog + native marketplace materialization)
  → Codex app-server plugin/marketplace RPC → Codex config and installed cache
  → bridge catalog read → Host projection → desktop continuous / mobile replayable UI
```

The bridge owns only the generated official-marketplace directory and catalog
snapshot; it must not keep an independent installed/enabled truth. Codex owns
the native marketplace registration, installed files, effective enablement and
the associated user configuration. The generated local marketplace stays on
the same execution host as Codex, and must outlive the native registration.
For Codex runtime, plugin requests use the target workspace's existing
read-only Host attachment; only legacy ZCode uses the synthetic local
plugin-management workspace. Otherwise remote installs could target the
wrong machine and bridge identity validation would reject the request.
`workspaceIdentity?.trim() || workspacePath` remains the attachment routing key;
the actual workspace path is passed as the native cwd. Remote workspaces must
materialize on the remote host, never on the desktop machine.

## Compatibility pipeline (materialize + transpile)

Every official plugin install is served from a bridge-materialized local
marketplace. Refresh downloads each catalog entry's published zip artifact
from the official CDN, verifies the catalog-pinned SHA-256, extracts it with
zip-slip protection, and runs a deterministic transpiler before exposing the
plugin to Codex. The published zip is the only trusted artifact; no Git
working-tree content is used. Transpiled output is staged under a temporary
directory and swapped in atomically; a failed refresh never disturbs the last
good materialization.

The transpiler applies data-driven component rules instead of per-plugin
special cases, so new official plugins and new versions flow through the same
pipeline without code changes:

1. Manifest: `.claude-plugin/plugin.json` is used when present; otherwise a
   Claude-compatible manifest is synthesized from `.zcode-plugin/plugin.json`.
   Manifest path fields (`skills`, `commands`, `hooks`, `mcpServers`) are
   normalized to the `./`-prefixed form Codex requires. Manifest fields that
   name components Codex cannot execute (`channels`, `lspServers`,
   `outputStyles`, `settings`) make the entry unavailable with an explicit
   reason. Unknown fields that Codex ignores pass through untouched.
2. MCP servers (`.mcp.json` or inline `mcpServers`): stdio and
   streamable-http transports are supported. `${ZCODE_PLUGIN_ROOT}` and
   `${CLAUDE_PLUGIN_ROOT}` bake to the absolute materialized plugin path
   (Codex copies local installs into its own cache, so baked paths must point
   at the stable materialized directory). A `cwd` of `${ZCODE_PROJECT_DIR}` /
   `${CLAUDE_PROJECT_DIR}` is dropped so the server inherits the per-workspace
   app-server cwd. `${user_config.<key>}` bakes the declared default; a use
   without a declared default drops that server with a warning.
   `${ZCODE_BASE_URL}` resolves to the configured Codez endpoint origin.
   `auth: {type: "zcode_official"}` on an HTTP server becomes
   `bearer_token_env_var: "CODEZ_ZAI_OFFICIAL_MCP_TOKEN"` and marks the plugin
   as requiring z.ai account auth; any other unrecognized `${...}` variable,
   transport, or auth shape drops that server with a warning. When a plugin
   declares MCP servers and every server is dropped, the entry is
   unavailable. Legacy SSE transports are unsupported.
3. Hooks (`hooks/hooks.json` or inline `hooks`): command hooks pass through;
   ZCode `type: "process"` handlers (command + args) are rewritten to
   shell-quoted `type: "command"` strings. `${ZCODE_PLUGIN_ROOT}` rewrites to
   `${CLAUDE_PLUGIN_ROOT}`, which Codex expands for plugin hooks at discovery.
   Events outside the Codex hook model are dropped with a warning.
4. Skills and commands are copied unchanged; Codex resolves matcher aliases
   (`Edit`/`Write` → `apply_patch`, `Agent` → `spawn_agent`) itself.
5. Content scan: plugin text assets are scanned for markers of ZCode-only
   runtime coupling (`node_repl`, `control-browser`, `BrowserRecordingAPI`,
   `browser_use`, `computer_use`). Matches do not block installation but
   surface as per-plugin capability warnings, because instruction-level
   coupling degrades gracefully while tool-level coupling does not.
6. Anything not recognized by these rules never produces a silent partial
   success: the entry is either available with enumerated warnings or
   unavailable with a concrete reason.

The bridge stores transpile outcomes in a sidecar metadata file next to the
generated marketplace.json; Codex only ever reads the Codex-clean
marketplace.json. Available entries carry `AVAILABLE` policy; unavailable
entries keep `NOT_AVAILABLE` so native Codex install is also blocked.
Each plugin version materializes under its own `plugins/<name>/<version>`
directory so an installed older version keeps working until the user updates;
directories for versions that are neither in the catalog nor installed are
pruned after a successful refresh.

## Official auth token delivery

Official HTTP MCP servers authenticate with the desktop's z.ai OAuth access
token (`oauth:zai:access_token`). The services layer reads the credential at
agent-spawn time and exports it to the Codex bridge process as
`CODEZ_ZAI_OFFICIAL_MCP_TOKEN`; the bridge child app-server inherits it and
Codex resolves `bearer_token_env_var` from its own process environment, so the
token never touches disk in materialized files. A missing token never blocks
installation or other components: the affected MCP servers fail authentication
visibly, and the store surfaces a login hint on the plugin. Remote workspace
bridges have no credential store access, so official-auth MCP servers remain
unavailable there until a token relay is designed.

## Plugin hook trust

Codex gates plugin hooks behind per-hook trust persisted in user config. After
a successful official install or update, the bridge enumerates the plugin's
hooks via `hooks/list` and writes each hook's current hash to
`hooks.state."<key>".trusted_hash`, limited to plugins installed from the
generated official marketplace. This mirrors the trust Codex grants
workspace-listed plugins automatically; hooks from any other source are never
trusted by the bridge. Hash changes on update re-enter the same trust flow.

Plugins whose required runtime depends on ZCode-specific auth, missing package
assets or incompatible hooks/MCP must not report a successful Codex install.
Unavailable official entries remain visible in both card and detail views. The
bridge supplies `availablePlugins[].installationUnavailableReason`; the UI
projects that reason to `StorePluginItem`, disables every install entry point
(button and example-prompt fallback), displays localized explanatory copy, and
retains the backend reason as detail tooltip content. Available entries may
carry `officialWarnings` and `officialAuthRequired`; the UI shows them as
capability notes without disabling installation. Entries without these fields
keep the existing Codez store behavior.

## State and failure cases

1. Enter Public store: enumerate official entries and existing native installs;
   no plugin gets installed or enabled. Unavailable official refresh retains
   the last valid snapshot and displays a recoverable error.
2. Install: resolve the exact official entry and version, register the durable
   local marketplace through Codex if needed, call native `plugin/install`,
   then read back native `plugin/installed`. No success is shown without
   that confirmation. Duplicate requests must not create duplicate installs.
3. Enable/disable: write native Codex configuration and verify the effective
   value; a higher-priority override reports failure.
4. Uninstall: use native `plugin/uninstall`, confirm removal, and retain the
   discoverable official catalog for reinstall. Do not delete unrelated
   native plugins, other marketplaces, or user plugin data.
5. Refresh/update: re-run the materialize-transpile pipeline from the CDN
   catalog so new plugins and new versions flow through unchanged rules; make
   new catalog versions visible, preserve an old working install if catalog
   refresh or upgrade fails, and never trust a hook hash that the current
   pipeline did not just verify.
6. Native catalog and ZCode official catalog are separate sources. Personal
   Codex marketplaces remain available in the Personal segment; collisions
   in names use `name@marketplace` identity.
7. Codex-specific unsupported operations (workspace-only plugin writes,
   ZCode userConfig, ZCode-only plugin host helpers) fail explicitly. Never
   translate them into a global write or silently drop a required component.

## Validation

- Unit: official identity alias only for trusted source, schema/manifest
  validation, zip SHA-256 verification, zip-slip rejection, transpiler rules
  (manifest synthesis, path normalization, variable baking, userConfig
  defaults, official-auth rewrite, process-hook conversion, content scan),
  missing or unsupported assets, unavailable CDN, version mismatch, idempotent
  native registration, failure receipt and rollback.
- Bridge: native installed/enabled/catalog and marketplace lifecycle using
  an isolated Codex home and mock RPC; no developer configuration mutated.
- UI: public catalog and personal sources, install/disable/uninstall/error,
  desktop browser broker remains separate, and English/Chinese labels.
- Desktop: launch the actual Electron client with isolated test data, visit
  Plugin Store, install and exercise one compatible official skill plugin,
  verify native Codex can discover it, then restore the test installation.
- Repository: targeted tests, `pnpm typecheck`, `pnpm lint`,
  `pnpm architecture:check --changed`, and relevant desktop smoke checks.

## Verified evidence (codex-cli 0.158/0.159)

- Local marketplace sources (`{"source": "local", "path": "./plugins/x"}`)
  install, enable, and update through `marketplace/add` + `plugin/install`;
  installs are copied into the Codex cache keyed by version.
- Plugin stdio MCP servers spawn with literal args/env; no variable expansion
  exists in legacy plugin MCP configs, so the transpiler bakes absolute paths.
- Plugin HTTP MCP servers accept `bearer_token_env_var`; Codex resolves the
  token from the app-server process environment (`authStatus: bearerToken`).
- Plugin hooks are discoverable via `hooks/list`, execute only when trusted,
  and trust is writable via `hooks.state."<key>".trusted_hash` config edits.
  Codex expands `${CLAUDE_PLUGIN_ROOT}` in plugin hook commands at discovery
  and maps `Edit`/`Write` matchers to `apply_patch`.
- Plugin skills from local sources are listed as `<plugin>:<skill>` and are
  usable immediately after install.
- Codex ignores unknown manifest fields (`userConfig`, `description_i18n`),
  but ignores manifest path fields that lack the `./` prefix, which the
  transpiler normalizes.
