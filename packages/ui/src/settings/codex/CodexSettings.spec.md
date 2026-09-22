# Desktop Codex settings

Implements the settings slice of `specs/codex-desktop-adapter.md`. This is a
desktop-default surface; Web's existing settings remain unchanged.

## Ownership and transport

```text
local form draft → workspace-resolved zcodeAgentService.codexRequest
                → Host identity/lease route → bridge → native Codex authority
local read projection ← validated RPC response ← same authority
```

Use `useWorkspaceServicesResolution(path, remoteSessionId, identity)`. Preserve
identity even when two workspaces have the same path. A disconnected remote
workspace never falls back to the local Host. An absent workspace shows an
actionable empty state; do not invent a cwd. Service/attachment/identity changes
invalidate reads and pending UI results. UI owns drafts only, never credentials,
effective configuration, resource installation state, or accepted commands.

## Product rules

- Desktop startup is not gated on legacy Z.ai account/provider hydration. Keep
  the workspace, Git, files, terminal, and Settings shell available.
- The desktop sidebar profile entry is labeled Codex account and opens native
  account settings. It does not show legacy Connect/login/logout or legacy plan
  entitlements as if they represented the native account.
- A dedicated Codex section contains native account, model/reasoning,
  configuration/requirements, skills, MCP, and plugin/marketplace controls.
  Legacy provider/skill/MCP/plugin deep links render the Codex surface on desktop.
- Unsupported legacy agent settings show an explicit capability notice. Workflow,
  CUA, cloud and migration parity are not implied by disabled controls.
- Login starts/cancels through native account RPC. Credentials are ephemeral form
  input, cleared on submit, never logged or persisted in UI storage. Opening an
  authorization URL uses IPlatformService. Refresh verifies completion; an OAuth
  URL is not evidence of successful login. Shell access does not require login.
- Independent resources load concurrently with independent error states. Validate
  consumed response fields, paginate models and MCP, retain discovery errors.
- Configuration writes carry the native user-layer file/version when available;
  a missing user layer disables writes until a refresh provides a version. Display
  effective configuration and policy restrictions. Mutations are serialized,
  never automatically retried, and followed by authoritative reads. Conflicts and
  overridden values remain visible, not presented as successful activation.
- Resource enable/install/uninstall controls reflect native returned state. Respect
  plugin availability/install policy and interstitial requirements; do not replace
  required consent with an implicit install. Marketplace actions use native names
  and source fields, not ZCode's legacy official-marketplace vocabulary.

## Conversation integration and interaction QA

Native queue items automatically dispatch when idle (including cold resume). The adapter's `autoDrain=false` is not a paused queue: no resume/auto-drain control or held-queue promise is shown. Native history edit/retry preserves files; file rewind controls are unavailable and edits explicitly carry `workspaceMode: preserve`.

Desktop NewTask and active-session composers read `config/read` and paginated
`model/list` from the workspace-resolved Codex Host. No old provider registry is
queried for Codex model readiness or submission. Catalog/config own defaults;
the renderer owns only the next submission's selection. Unknown capabilities
must not be synthesized into a legacy provider registry. Runtime restart,
workspace/attachment change and explicit refresh invalidate the projection.

An effective `config.model` absent from `model/list` remains selectable as an
explicitly configured native model. It is labeled configured, not synthesized
into a catalog capability record. Its configured reasoning is preserved (including
omission); unknown reasoning capabilities are not restricted to OpenAI's list.
Unconfigured unknown models and different providers remain blocked.

For native busy/prewarming/stopping snapshots, disable model, reasoning, permission
and plan changes (including keyboard/`/plan` paths). Do not disable same-settings
guide/queue sends. Immediately before admission, compare frozen settings against
the current snapshot for busy sends and explicit queue sends, including idle queue:
reject changed intent visibly and preserve the draft, never silently substitute
thread defaults. Idle start/interrupt settings continue through the native command.
Existing thread mode/plan initialize from native snapshot, not new-task defaults.
Native submission must not wait for the legacy `setFollowupMode` CAS: that method
is unsupported. Native snapshots and requested delivery own queue/guide behavior.
Native draft prewarm waits for catalog/config selection readiness. Creation uses
the selected native provider/model and omits unconfigured reasoning, never display
placeholders such as empty provider or empty effort. This also applies after draft
rehydration and must not depend on whether prewarm wins the initial render race.
Desktop runtime preference synchronization (including cross-window broadcasts)
always disables legacy auto-answer and full model-I/O retention. General settings
show an explicit capability notice instead of those unsupported controls. This
does not rewrite stored Web preferences or native account settings.

```text
snapshot control → disabled configuration controls (no duplicate busy store)
frozen draft → catalog refresh → latest snapshot comparison → command admission
native createSession ACK/id → attachment upload+commit with same id
                           → sendText on same prewarm id → accepted promotion
```

Native attachments require owned opaque refs, never raw local paths. Picker,
paste and File drops use the existing byte upload service after native prewarm
creation. Path-only attachments require the existing transfer service to stage
an owned ref; a legacy path-returning service fails visibly, not as ready. Losing
prewarm cannot move committed refs into a freshly created unrelated session.

```text
native config + catalog → scoped read projection → draft model/effort → submit
native pending request → question/approval UI → native IDs → resolveInteraction
```

Native questions require every displayed answer before accept. Answers are arrays
keyed by native question ID (or index fallback), never the legacy nested `answers`
object or question text. Secret answers remain in mounted form state only. Cancel
and rejection remain explicit. Native approval option IDs pass unchanged. A rejected
answer keeps the dialog open with an error, and duplicate clicks cannot resend.

QA uses a dedicated `codex-ui-qa` browser session and isolated app/Codex paths.
Desktop QA launches the repository's actual `packages/desktop/scripts/dev.mjs`
entry with its real package metadata and ready-marker/Vite checks. The isolation
helper must not synthesize a package/version or replace updater behavior to make
startup pass. Existing build artifacts must be stable before launch.
Packaged verification launches only this checkout's `packages/desktop/dist/linux-unpacked/zcode-codex`
from a temporary workspace, without renderer, bridge or native executable overrides.
It uses dedicated CDP 9230 and accepts only the exact packaged
`resources/app.asar/out/renderer/index.html` file URL (bootstrap query/hash allowed).
The real packaged resolver, ASAR main/preload/Host/renderer and bundled native must
carry a fixture text/image turn to completion; source-tree dev fallback is not evidence.
No real account mutation, credential reading or external installation is permitted.
The live no-auth loopback conversation check sends a first-input fixture image to
completion, verifies busy model/permission locks and rejected `/plan`, then queues
a second image while a subsequent turn is held. Native
`sendQueuedNow` availability must gate the queue-row action: the bridge does not
support busy queue promotion or atomic busy `startNow`; do not imply those capabilities.
The check must observe no premature queue dispatch, then automatic native second-image
dispatch and completion once the held turn finishes. Assertions use
real UI actions plus sanitized fixture-provider observations, not injected commands.
If desktop startup is blocked, a browser harness must exercise real UI components,
capture assertions/screenshots and disclose mocked transport boundaries.

## Acceptance and execution evidence

Contract/parser tests cover unknown RPC rejection, malformed responses, OAuth URL
validation, config version selection, model effort validation, native marketplace
selectors and pagination. Executable interaction runners and evidence boundaries
are documented in `qa/README.md`. The remaining broader cases stay in
`CodexSettings.e2e.md`; passing the bounded UI suite does not claim full adapter,
workflow, CUA, remote recovery, or account mutation parity.
