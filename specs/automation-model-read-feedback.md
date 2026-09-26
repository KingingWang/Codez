# Automation model read feedback

## Scope and owner

Automation creation/editing reuses the existing workspace-scoped `useModelSelectionView` state. This change adds feedback only: no new state, service, cache, retry policy, persistence, native command or submission rule. The current target Host remains the authority for the effective model; both Desktop and Web consume the same hook state.

```text
workspace selection → existing Host model-view hook → loading / ready / error
  → existing model picker pending indicator + localized feedback
  → existing retry action → same hook reload → existing submission validation
```

## Behavior

- While loading, the model picker uses its existing pending indicator and localized loading label. Create/save and the picker keep their existing disabled rules.
- If reading the model view fails, show a localized, visible model-load failure explanation with the existing retry action. Do not expose raw backend errors or use a tooltip as the only explanation.
- Retry stays read-only and uses `reload`; success removes failure/loading feedback and lets the existing validation decide whether submission is allowed. It never submits an automation automatically.
- Missing workspace/remote target is not falsely described as a load error. Workspace changes retain the existing stale-response protection.
- Use current design tokens and translations; preserve narrow-window wrapping, light/dark themes and keyboard-accessible retry.

## Acceptance

1. With a delayed model-view response, loading feedback is visible and submission stays disabled.
2. With a rejected response, visible failure text and Retry appear while submission remains disabled.
3. Clicking Retry performs a fresh read; a successful result removes failure feedback without submitting or modifying the prompt.
4. Valid native defaults (including models absent from discovery or without reasoning effort) retain the existing ready/submission behavior.
5. A local isolated browser test exercises loading → error → retry → ready using the real automation form and injected services, without user credentials or real automation writes.

## Reproduction

Run `node packages/ui/src/settings/codex/qa/automation-model-read-e2e.mjs` from the repository root. It uses the existing Vite/Playwright dependencies and a local Chrome executable (`CHROME_PATH`, default `/opt/google/chrome/chrome`), with an isolated profile and loopback-only browser requests. Screenshots and results are retained in the printed temporary evidence directory. This covers browser form behavior, including keyboard retry and narrow light/dark layouts, not native Host integration.
