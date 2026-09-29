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

The official catalog's distributed plugin packages must not be silently
replaced by unverified Git working-tree content. Any native Git source used
by the compatibility layer must be pinned to a resolved commit and checked
against the published plugin name/version; failures are visible diagnostics.
Plugins whose required runtime depends on ZCode-specific auth, missing package
assets or incompatible hooks/MCP must not report a successful Codex install.
The first supported class is portable skills-based official packages with
an existing Codex/Claude-compatible manifest; unsupported entries are
reported as unavailable, not silently omitted as successfully installed.
Unavailable official entries remain visible in both card and detail views. The
bridge supplies `availablePlugins[].installationUnavailableReason`; the UI
projects that reason to `StorePluginItem`, disables every install entry point
(button and example-prompt fallback), displays localized explanatory copy, and
retains the backend reason as detail tooltip content. Entries without the field
keep the existing Codez store behavior and remain installable.

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
5. Refresh/update: make new catalog versions visible, never reinterpret a
   remote Git HEAD as a published version, and preserve an old working install
   if catalog refresh or upgrade fails.
6. Native catalog and ZCode official catalog are separate sources. Personal
   Codex marketplaces remain available in the Personal segment; collisions
   in names use `name@marketplace` identity.
7. Codex-specific unsupported operations (workspace-only plugin writes,
   ZCode userConfig, ZCode-only plugin host helpers) fail explicitly. Never
   translate them into a global write or silently drop a required component.

## Validation

- Unit: official identity alias only for trusted source, schema/manifest
  validation, missing or unsupported assets, unavailable CDN/Git, version
  mismatch, idempotent native registration, failure receipt and rollback.
- Bridge: native installed/enabled/catalog and marketplace lifecycle using
  an isolated Codex home and mock RPC; no developer configuration mutated.
- UI: public catalog and personal sources, install/disable/uninstall/error,
  desktop browser broker remains separate, and English/Chinese labels.
- Desktop: launch the actual Electron client with isolated test data, visit
  Plugin Store, install and exercise one compatible official skill plugin,
  verify native Codex can discover it, then restore the test installation.
- Repository: targeted tests, `pnpm typecheck`, `pnpm lint`,
  `pnpm architecture:check --changed`, and relevant desktop smoke checks.

## Open evidence

The online catalog currently lists 26 items. Its finance-only MCP plugins
(`finance-search`, `hexin`, `wind`, `tianyancha`) use ZCode-specific authentication
and have no portable skill manifest. They must remain explicitly unavailable
until an authenticated Codex MCP integration is designed. Other entries still
need manifest and runtime verification before being labelled compatible.
