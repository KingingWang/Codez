# Desktop Codex settings

Implements the settings slice of `specs/codex-desktop-adapter.md`. This is a
desktop-default surface; Web's existing settings remain unchanged.

## Ownership and transport

```text
local form draft → workspace-resolved codezAgentService.codexRequest
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
- The section's internal panel tabs are the same navigation as the Settings
  sidebar entries: switching a tab that has a sidebar counterpart also moves
  the outer active section, so the page title and sidebar highlight always
  follow the visible panel. Panels without a sidebar counterpart (models,
  config, history) activate the outer Codex section while retaining the chosen
  inner panel. They must not leave a previously selected MCP/Plugins/etc. title
  or sidebar highlight behind. An explicit sidebar/deep-link navigation to
  Codex opens Account; switching among inner-only panels keeps the Codex
  heading and does not persist a misleading legacy section preference.
- The Codex skills and plugin marketplace lists expose a unique accessible
  action name per target. Keep the short visible button label, but include the
  skill name/scope/path, or plugin name/marketplace (and native ID when needed),
  in its accessible name. Both the first click and the confirmation/cancel
  controls must identify the same marketplace or plugin. This changes no native
  command, installation policy, or ownership of resources.

```text
outer section click ───────────────→ SettingsPage activeSection → title/sidebar
       └─ explicit Codex click ────→ Account (clear inner-only selection)
inner Codex panel click → SettingsPage activeSection + inner-only selection
       ├─ mapped panel ────────────→ matching sidebar section
       └─ models/config/history ───→ Codex sidebar; retain clicked inner panel
Codex list item → target-labeled UI control → existing native resource command
```

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
- If the native requirements response does not supply an approval-policy
  allowlist, present only current supported user-selectable policies. Retired
  `untrusted` must not be offered as a user configuration value; project trust
  level remains a separate native fact and is not reinterpreted as that choice.
- Single-value and batch JSON are parsed and validated as local drafts before
  entering the mutation path. Invalid input sends no RPC and shows a form-local
  error; it must not show the generic "operation may have failed; refresh before
  retrying" notice reserved for an attempted remote mutation. Editing the input
  or switching settings panels clears its local validation error. A remote
  mutation failure remains visible until explicit refresh or a new mutation.
- The current conversation selection is owned by the workspace-keyed renderer
  session store. When settings opens over a selected conversation, pass its
  native session ID and workspace identity to the read-only history projection.
  A draft workspace has no selected ID and shows the empty-state prompt. A
  remote workspace with the same path but a different identity must never read
  the previously selected local/remote thread. The bridge owns history facts;
  settings holds no duplicate thread cache.
- Resource enable/install/uninstall controls reflect native returned state. Respect
  plugin availability/install policy and interstitial requirements; do not replace
  required consent with an implicit install. Marketplace actions use native names
  and source fields, not Codez's legacy official-marketplace vocabulary.

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

The mode dropdown's tooltip remains interactive while the menu is closed, but
must be suppressed while the menu is open. Its Radix `open` ownership must not
change between controlled and uncontrolled over the component lifetime.
The model selector's forced guide tooltip follows the same invariant. Menu
open/close and guide dismissal must not produce React/Radix ownership warnings.

```text
selected workspace identity + renderer selected session → history read request
form draft → local JSON/schema validation → Host native mutation → refresh
                                    └─ invalid: form error only, no Host request
```

Acceptance: completed Codex conversation → Settings → Thread history shows
its native turns; navigating to another same-path identity does not reuse them;
draft → explicit no-session state. Invalid JSON/schema → local error and zero
mutation requests; navigation clears it; rejected native write retains its
remote-failure warning. Opening/closing mode picker repeatedly and dismissing
model guide leaves tooltip warning count unchanged.
From the MCP subpage, switching to Configuration and then Thread history must
keep those panels visible while the title/sidebar point to Codex, not MCP; the
outer Codex entry returns to Account. A list with two native skills, two
marketplaces, and two plugins with the same display name must offer distinct
accessible names and confirmation/cancel names; visual labels remain localized.

QA uses a dedicated `codex-ui-qa` browser session and isolated app/Codex paths.
Desktop QA launches the repository's actual `packages/desktop/scripts/dev.mjs`
entry with its real package metadata and ready-marker/Vite checks. The isolation
helper must not synthesize a package/version or replace updater behavior to make
startup pass. Existing build artifacts must be stable before launch.
When running an isolated preview on alternate local renderer/CDP ports, each
real-desktop QA checker must honor those explicit ports and refuse a CDP page
from any other origin/port; no fallback to another app's renderer is allowed.
Browser fixture RPC-log assertions must wait for the inspection result produced
by that click; an earlier `result` payload is not evidence of the current
native interaction count.
When the GUI target itself crashes, an optional failure screenshot may be
unavailable; the QA checker must report its original assertion/crash error
instead of replacing that error with the screenshot-capture failure.
Packaged verification launches only this checkout's `packages/desktop/dist/linux-unpacked/codez-codex`
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
