# Codex UI interaction verification

These runners use existing repository dependencies. Run from the repository root
with Node 24.14.0 on PATH. Do not run legacy `pre-dev` or rebuild distribution assets
to use them. Never use a real user profile, API key, or Codex home.

## Real desktop

The checked build must already provide `packages/desktop/out/{main,preload,host,renderer}`
and the pinned Linux native binary referenced by `scripts/codex-runtime-manifest.json`.
Start only the renderer dev server for current unbuilt UI edits:

```sh
ZCODE_DESKTOP_RUNTIME=codex ZCODE_ENV=production pnpm --filter @zcode/desktop exec vite --host 127.0.0.1 --port 5174 --strictPort
node packages/ui/src/settings/codex/qa/desktop-probe.mjs
node packages/ui/src/settings/codex/qa/desktop-check.mjs
```

The probe creates temporary home/config/cache/data/userData/session/CODEX_HOME
directories, uses an allowlisted child environment (no inherited auth variables),
starts a private Xvfb display and uses a no-auth provider pointing to closed localhost
port 9. It launches actual `node scripts/dev.mjs` from `packages/desktop`, which
waits for main/host/preload ready markers and Vite on port 5174, then starts Electron
with the real desktop package. No synthetic package, version override, or updater
replacement is permitted. Main currently forces dev CDP port 9229;
do not run this probe if another app already owns that port. The desktop check attaches
only to the local QA renderer, verifies the explicitly configured custom model,
types then clears an unsent draft, uploads/removes a fixture image, reads native
account/config/requirements, refreshes and checks legacy MCP routing and the
sidebar Codex account entry (no legacy Connect/login requirement).
No model turn, login/logout, resource install, or native settings mutation is performed.
Stop the probe and Vite processes after inspection. Temporary evidence is retained.

For actual first-input image submission, launch a **fresh** probe with
`CODEX_UI_QA_MOCK=1`. It prints a local
`mockProvider` URL. Run:

```sh
CODEX_UI_QA_MOCK_URL=http://127.0.0.1:PORT node packages/ui/src/settings/codex/qa/desktop-conversation-check.mjs
```

This sends only a generated 1-pixel image and fixture text through the real
Electron/Host/native bridge to an in-process no-auth loopback provider. It holds
the response to verify busy controls and `/plan`, then releases a deterministic
response without tools. The URL must be loopback and the probe must be fresh.
On failure it writes the UI text, errors, sanitized mock request diagnostics and
a screenshot, and releases the held response. It does not automatically retry
commands or move attachment refs between sessions.

Full-turn blocker reproduced with **actual dev.mjs** on 2026-09-22:
`/tmp/codex-ui-desktop-conversation-j76tnR/failure.json`. Startup succeeded with
real desktop package metadata; no semver workaround was used. The bridge then
rejected native history at `turns[0].items[0].type` (`Invalid input`). A direct
read-only native `thread/read` confirmed the first `userMessage` contains
`{type: "localImage", detail: null}`; the current bridge validator allowed null for
`image.detail`, but not `localImage.detail`. No mock provider request arrived.
This is **not** a passing first-input image/stream E2E, and not an attachment
owner mismatch. The bridge owner has the minimal reproduction for a fix/retest.

For manual inspection use `agent-browser --session codex-ui-qa --cdp 9229 snapshot -i`.
Never auto-connect to an unrelated browser or use its existing profile.

## Deterministic browser interactions

```sh
node packages/ui/src/settings/codex/qa/interaction-e2e.mjs
```

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
approval option IDs, and versioned configuration writes followed by refresh.

## Recorded verification — September 22, 2026

- Real desktop runner passed against the pinned binary SHA-256 beginning `b34e6f77`.
  Actual repository `scripts/dev.mjs` startup (no synthetic package/version) and
  seven desktop checks passed: `/tmp/codex-ui-desktop-check-caNQc5/`.
- Browser suite passed with zero uncaught page errors; initial complete evidence:
  `/tmp/codex-ui-interaction-e2e-38zQN6/`. Subsequent runs print fresh paths.
- Live native config reads revealed omitted `layers[].disabledReason`; the shared
  projection now accepts that omission, with a parser regression test.
- Unit/parser/render tests: run `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/src/settings/codex/*.test.ts packages/ui/src/settings/codex/*.test.tsx`.

Not validated here: real authentication mutations, external installs/OAuth, native
model inference, remote attachment switching, recovery across a Host restart, or
workflow/CUA parity. Native approval/question transport is mocked in the browser suite;
the live desktop suite proves native read integration and composer usability only.
