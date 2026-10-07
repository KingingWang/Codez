# Codex UI interaction verification

These runners use existing repository dependencies. Run from the repository root
with Node 24.14.0 on PATH. Do not run legacy `pre-dev` or rebuild distribution assets
to use them. Never use a real user profile, API key, or Codex home.

## Real desktop

The checked build must already provide `packages/desktop/out/{main,preload,host,renderer}`
and the pinned Linux native binary referenced by `scripts/codex-runtime-manifest.json`.
Start only the renderer dev server for current unbuilt UI edits:

```sh
CODEZ_DESKTOP_RUNTIME=codex CODEZ_ENV=production pnpm --filter @codez/desktop exec vite --host 127.0.0.1 --port 5174 --strictPort
node packages/ui/src/settings/codex/qa/desktop-probe.mjs
node packages/ui/src/settings/codex/qa/desktop-check.mjs
```

To check the General page's accessible control names without reloading Electron
(useful on a host with limited inotify resources), attach only to a fresh
isolated probe's exact renderer/CDP ports:

```sh
CODEX_UI_QA_RENDERER_PORT=5175 CODEX_UI_QA_CDP_PORT=9231 \
  node packages/ui/src/settings/codex/qa/desktop-general-accessibility-check.mjs
```

It reads the actual controls' accessible names, toggles and restores a
notification setting with the keyboard, and retains a screenshot and result
under an isolated temporary evidence directory. It does not change the real
user profile or authenticate a Codex account.

After building the renderer, verify that a failed entry chunk cannot strand a
permanent startup logo:

```sh
CODEX_UI_QA_RENDERER_PORT=5175 node packages/ui/src/settings/codex/qa/bootstrap-watchdog-e2e.mjs
```

Run it against the isolated `vite preview` server on that explicit local port,
not a real user browser. The runner blocks only the built `assets/index-*.js`
entry, checks one bounded self-retry followed by a visible Reload error page,
and retains a screenshot in a fresh temporary directory. The built HTML must
keep the watchdog as a classic inline script; a Vite-bundled module watchdog
cannot observe its own entry-chunk failure.

The probe creates temporary home/config/cache/data/userData/session/CODEX_HOME
directories, uses an allowlisted child environment (no inherited auth variables),
starts a private Xvfb display and uses a no-auth provider pointing to closed localhost
port 9. It launches actual `node scripts/dev.mjs` from `packages/desktop`, which
waits for main/host/preload ready markers and Vite on port 5174, then starts Electron
with the real desktop package. No synthetic package, version override, or updater
replacement is permitted. Main currently forces dev CDP port 9229;
the probe refuses to start when the selected CDP port is already occupied,
before creating a profile or launching Electron. Close only your previous isolated
probe or choose separate QA ports; it never stops the port owner. The desktop check attaches
only to the local QA renderer, verifies the explicitly configured custom model,
types then clears an unsent draft, uploads/removes a fixture image, reads native
account/config/requirements, refreshes and checks legacy MCP routing and the
sidebar Codex account entry (no legacy Connect/login requirement).
No model turn, login/logout, resource install, or native settings mutation is performed.
Stop the probe and Vite processes after inspection. Temporary evidence is retained.
When this isolated probe runs as root on Linux, it disables Chromium's sandbox
only for the temporary QA Electron process; regular development and packaged
launches retain their default sandbox. Verify this boundary with
`node --test packages/ui/src/settings/codex/qa/desktop-probe-env.test.mjs`.

For actual first-input image submission, launch a **fresh** probe with
`CODEX_UI_QA_MOCK=1`. It prints a local
`mockProvider` URL. Run:

```sh
CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-conversation-check.mjs
```

This sends only a generated 1-pixel image and fixture text through the real
Electron/Host/native bridge to an in-process no-auth loopback provider. It holds
the response to verify busy controls and `/plan`, then releases a deterministic
response without tools. A busy plain send enqueues into the visible native queue
card; the test exercises edit (recall into the composer) and delete, re-queues a
fixture image, releases the current turn, and observes automatic native image
dispatch. Busy `Ctrl`+send preempts (interrupt, then immediate start), and a busy
queue item exposes the same preempt through its send-now button; both are
interrupt-then-start, safe because the native queue never auto-dispatches on an
interrupted idle (specs/codex-desktop-adapter.md). The URL must be loopback and
the probe must be fresh.
On failure it writes the UI text, errors, sanitized mock request diagnostics and
a screenshot, and releases the held response. It does not automatically retry
commands or move attachment refs between sessions.

For native busy follow-ups, use a different **fresh** mock probe and run
`desktop-followup-check.mjs` with that probe's `mockProvider` URL. It tests the
default queue, explicit per-send Guide, inverse Ctrl modifier, local waiting
hint, queue count/interruption wording, narrow desktop bounds and one-request-
at-a-time model release. It asserts the authoritative guided user row replaces
the local hint **before** the turn finishes, and the queued input does not start
until afterward. The mock never uses account credentials or external models.
On the alternate preview/CDP ports, provide both `CODEX_UI_QA_RENDERER_PORT`
and `CODEX_UI_QA_CDP_PORT` as for the conversation check:

```sh
CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-followup-check.mjs
# For an isolated preview on alternate ports:
CODEX_UI_QA_RENDERER_PORT=5175 CODEX_UI_QA_CDP_PORT=9231 CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-followup-check.mjs
```

To verify native model-retry visibility, start a separate fresh mock probe and run
`desktop-retry-check.mjs` with its printed `mockProvider` URL. The fixture
sets only its isolated provider's `request_max_retries = 0`; production Codex
retains its own request-layer retry policy. The test returns two HTTP 503s (the
first WebSocket reconnect event may be suppressed by Codex), holds the next
request, checks the live status and HTTP code, then verifies recovery and that
the next turn has no stale status. It also checks a compact desktop viewport and records
`retry-visible.png`, `retry-compact-desktop.png`, `retry-recovered.png` and
`results.json` under a fresh temporary directory.
Neither this test nor Codez can surface Codex's request-layer attempts that
have no native `willRetry` notification.

When another worktree already owns ports 5174/9229, use a separate **isolated**
desktop instance without stopping it. Build the renderer, serve it without
file watchers (useful on low-inotify systems), then launch the QA probe with
explicit renderer/CDP ports:

```sh
CODEZ_DESKTOP_RUNTIME=codex CODEZ_ENV=production pnpm --filter @codez/desktop exec vite build --logLevel error
CODEZ_DESKTOP_RUNTIME=codex CODEZ_ENV=production pnpm --filter @codez/desktop exec vite preview --host 127.0.0.1 --port 5175 --strictPort
CODEX_UI_QA_RENDERER_PORT=5175 CODEX_UI_QA_CDP_PORT=9231 CODEX_UI_QA_MOCK=1 node packages/ui/src/settings/codex/qa/desktop-probe.mjs
CODEX_UI_QA_RENDERER_PORT=5175 CODEX_UI_QA_CDP_PORT=9231 node packages/ui/src/settings/codex/qa/desktop-check.mjs
CODEX_UI_QA_RENDERER_PORT=5175 CODEX_UI_QA_CDP_PORT=9231 CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-retry-check.mjs
```

The parallel probe uses the real locally built Electron main/preload/Host,
renderer and pinned native bridge. It does not use `dev.mjs`'s fixed dev ports.
The desktop check accepts only this explicitly selected localhost QA renderer
and checks native settings, the inner Codex navigation/breadcrumb relationship,
and target-specific accessible names for skill/plugin/marketplace controls;
it never installs a plugin or confirms marketplace deletion. Run conversation,
retry and interrupted-turn checks with separate fresh mock probes.
Use the mock port printed by that fresh probe. Run the existing
`desktop-conversation-check.mjs` on another fresh isolated probe for image,
busy-input and native queue regression; do not reuse a mock after a turn.
For the interrupted-turn recovery entry, launch a **fresh** probe with
`CODEX_UI_QA_MOCK=1` and run:

```sh
CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-interrupted-turn-check.mjs
```

For an isolated preview on alternate ports, pass the same
`CODEX_UI_QA_RENDERER_PORT` and `CODEX_UI_QA_CDP_PORT` used for the fresh probe;
the checker rejects a different renderer URL and does not attach to another app.
It sends one text prompt to the held loopback provider, clicks the composer stop
control while the native turn is running, and asserts the interrupted turn end
renders an always-visible `v4-retry-<rowId>` continue entry. Clicking it must dispatch
`sendText` in the same thread (the provider sees a second request), retain the
interrupted turn and its completed tool history, and hide the entry while the
continuation runs and after it completes. The checker verifies that both the
original input and the continuation remain visible. A completed-tool fixture
should be used for manual verification of actual model-context reuse.

Fresh full-turn **actual dev.mjs** verification passed on 2026-09-22:
`/tmp/codex-ui-desktop-conversation-gqtR57/results.json` (six checks, three completed
native turns, zero page errors). Screenshots include `first-image-ready.png`,
`native-image-response.png`, `native-auto-queue-waiting.png`,
`native-queued-image-auto-drained.png`, and `agent-browser-final.png` in that directory.
This run uses the repaired bridge with nullish native `localImage.detail`, real
desktop package metadata, and a new isolated profile with frozen UI source.
Live QA also caught and fixed a draft-prewarm race: display placeholders had sent
empty provider/effort to native. Prewarm now waits for catalog selection and omits
unconfigured effort. No fake metadata, model capability, or raw attachment path
was substituted to make this pass.

For manual inspection use `agent-browser --session codex-ui-qa --cdp 9229 snapshot -i`.
Never auto-connect to an unrelated browser or use its existing profile.

## Real packaged Linux application

Wait for distribution to confirm `packages/desktop/dist/linux-unpacked` is stable.
No Vite server, installation, build, or executable-path override is needed:

```sh
CODEX_UI_QA_PACKAGED=1 CODEX_UI_QA_MOCK=1 node packages/ui/src/settings/codex/qa/desktop-probe.mjs
# Substitute only the loopback port printed by that fresh probe:
CODEX_UI_QA_PACKAGED=1 CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-conversation-check.mjs
```

This launches the actual `linux-unpacked/codez-codex` from an isolated temporary
cwd. The allowlisted environment contains no `ELECTRON_RENDERER_URL`,
`ELECTRON_RUN_AS_NODE`, `CODEZ_CODEX_BRIDGE_PATH`, or `CODEZ_CODEX_COMMAND`. Packaged
resolution must find its own ASAR and `resources/codex` binaries. Dedicated CDP
9230 accepts only this checkout's exact
`resources/app.asar/out/renderer/index.html` file URL, allowing bootstrap query/hash;
it does not accept arbitrary file or CDP pages. Manual inspection uses
`agent-browser --session codex-ui-qa --cdp 9230 snapshot -i`.

Actual packaged verification passed **6/6** on September 22, 2026:
`/tmp/codex-ui-desktop-conversation-7BM4eI/results.json`. It includes the exact
packaged renderer URL, three completed native/loopback turns and zero page errors.
`packaged-paths.json` in that directory records live `/proc` executable/argv/cwd,
ASAR Host launch logs and SHA-256 hashes; `agent-browser-packaged.png` records the UI.
The packaged ASAR hash is `7638f87d60fa943844084afbea660ee97863bba6c90692a01f0ffd4c2007c1b3`.
No credentials were read, no account changed, and no system installation performed.
Stop the probe after verification; retain temporary evidence only.

## Deterministic browser interactions

```sh
node packages/ui/src/settings/codex/qa/interaction-e2e.mjs
```

The separate Help-menu product-identity runner mounts the real shared Help
button under Codex, production and Preview Vite defines. For each flavor it
opens the desktop and Web menus, checks update-entry visibility and captures
screenshots; visible entries must dispatch the existing `checkForUpdates`
platform command to a fixture (never to the real updater):

```sh
CHOKIDAR_USEPOLLING=1 node packages/ui/src/settings/codex/qa/help-menu-flavors-e2e.mjs
```

It uses an isolated browser profile, localhost port 5190 and temporary evidence
directory. The broader interaction runner additionally verifies the Codex model
catalog visibility switch's target-specific accessible name and checked state.
It verifies distinct accessible User/Project scope names for the two "New role"
actions, and checks all six Memory numeric defaults in both English and Chinese
without changing native configuration.
Neither browser fixture is a packaged update installation or a real account test.

On a shared Linux host that has already exhausted the per-user inotify
instance quota, run this isolated Vite fixture with
`CHOKIDAR_USEPOLLING=1 node packages/ui/src/settings/codex/qa/interaction-e2e.mjs`.
This changes only file watching; it does not increase assertions' timeouts or
override application behavior. A real Electron reload may still fail in this
environment and is tracked separately.

Optional `AGENT_BROWSER_BIN=/absolute/path/to/agent-browser.js` captures an additional
agent-browser snapshot using session `codex-ui-qa`. The runner launches system Chrome
with a temporary home, starts Vite on localhost:5188, blocks non-local HTTP requests,
and always closes its browser/server. Output prints the temporary evidence directory
containing screenshots, JSON assertions and the optional accessibility snapshot.

The harness mounts real `useCodexModelCatalog`, draft config/readiness hooks,
`CodexComposerModelControls`, `V4InteractionDialogs`, `PermissionDialog`, queue panel,
and `CodexSettingsSection` with injected mock Host/native responses. The legacy model
service throws on access; the suite asserts zero accesses. Native pending-interaction
and queue fixtures are validated by shared schemas.

Assertions cover NewTask and active-session native selection, reasoning preservation,
catalog failure/recovery, native queue labeling/no resume, required question answers,
password rendering and no persisted secrets, ID-keyed string arrays in actual V4
commands, rejected answer recovery/cancel, double-click admission, all four native
approval option IDs, versioned configuration writes followed by refresh, a
form-local invalid JSON path without mutation RPC, stable mode-tooltip ownership,
single-model catalog deletion disabled, restart interruption confirmation/cancel,
and old-Host observation successes/failures arriving after a same-workspace
reconnect. Actual Electron smoke independently confirms selected-thread history,
native streamed/image/queued turns, and Codex-only usage; it does not cover
credentialed models or every desktop and mobile operation.
The browser fixture additionally mounts the shared General settings component
to test desktop/Windows accessible names and mouse/keyboard switch parity, and
mounts Root's provider snapshot/OAuth hooks against fake Host services to assert
zero legacy account/provider reads on Codex versus active legacy subscriptions
and refreshes. Native mode still installs a transport-only OAuth callback before
renderer-ready to acknowledge a pending obsolete Codez link; the fixture confirms
it sends no legacy account mutation or duplicate ready after changing a callback
dependency. The separate Root migration test controls
settings-read completion and verifies an obsolete Host never starts a Provider
refresh after a mode switch. The cached OAuth restore test separately holds the
restored provider-family refresh and verifies the old Host does not start a
Provider refresh when the Codex Host takes ownership.
The deeper restored-selection and migration helper tests hold settings,
OAuth, model and entitlement reads to prove late results cannot initiate a
Provider RPC or legacy setting write after takeover.
The Root fixture also holds interactive deep-link/poll results and legacy
workflow availability until native Host takeover: deep-link receipt still
completes, without an old account write, Provider refresh or enabled workflow
entry. It separately completes a login while the legacy Host remains current.
The polling fixture can also pause inside the provider-family settings read,
then proves that a late result cannot initiate a Provider RPC. An expired
legacy account prompt closes on native takeover without completing old
reauthentication; a separately owned prompt remains untouched in the store test.
Provider View disposal and workflow generation have controlled unit tests.
The fixture is not a real account or external service.

## Recorded verification — September 22, 2026

- Real desktop runner passed against the pinned binary SHA-256 beginning `b34e6f77`.
  Actual repository `scripts/dev.mjs` startup (no synthetic package/version) and
  seven desktop checks passed: `/tmp/codex-ui-desktop-check-caNQc5/`.
- Browser suite passed with zero uncaught page errors; initial complete evidence:
  `/tmp/codex-ui-interaction-e2e-38zQN6/`. Subsequent runs print fresh paths.
- Live native config reads revealed omitted `layers[].disabledReason`; the shared
  projection now accepts that omission, with a parser regression test.
- Unit/parser/render tests: run `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/src/settings/codex/*.test.ts packages/ui/src/settings/codex/*.test.tsx`.
  Final run: 24 passed, including native queue availability and empty prewarm field regressions.

Not validated here: real authentication mutations, external installs/OAuth, native
external model inference, remote attachment switching, recovery across a Host restart, or
workflow/CUA parity. Native approval/question transport is mocked in the browser suite;
the live desktop suite proves native read integration and real first-image/queued-image
full turns through Electron, Host and pinned Codex to the no-auth loopback fixture.
