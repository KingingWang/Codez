# Codex desktop automatic session titles

## Product rules

- A new top-level interactive Codex session may receive one generated title after its first
  completed, substantive user input. Sending and the main turn never wait for generation. The
  native preview remains visible until a title is committed. Existing history is not backfilled,
  later turns do not rename the session, and a first input shorter than ten Unicode characters
  keeps its preview.
- The default title model is OpenAI `gpt-5.6-luna` at low reasoning. Codez settings expose one
  editable global default and an optional override per workspace identity. No override means
  inherit, without requiring a choice in every project. The override key is
  `workspaceIdentity?.trim() || workspacePath`; `workspacePath` remains the execution cwd.
- The Codex Models settings panel obtains candidates from the target workspace's native catalog,
  including its explicitly configured native model. Store the provider/model pair, not a model
  label or a second copy of the catalog. Selecting a title model never changes the conversation
  model or native `config.toml`. A missing or unavailable selected model does not silently fall
  back to a different model: generation is skipped and the current preview remains. Availability
  follows the native catalog or an explicit native configuration, including API-key sign-in;
  the account type alone must not exclude a listed model. A missing setting read also cannot
  reject the user's input.
- Global changes affect inheriting workspaces; explicit overrides remain unchanged. Resetting an
  override restores inheritance. A submitted first input freezes the effective model for that
  attempt; changing settings while generation is pending affects future sessions only.

## Ownership and ordering

```text
SettingService (global default + workspace override)
  → workspace service read → first-input command carries effective model
  → bridge observes first native user item → restricted ephemeral Codex turn
  → validate result + current native name/input → thread/name/set
  → native notification → V4 conversation / sessions-index → task index + UI
                                  desktop continuous / mobile replayable
```

- `SettingService` is the sole durable preference writer. The bridge has only an in-flight
  attempt keyed by workspace attachment, thread and first user item. Native Codex owns the
  durable thread name; the existing task-index manual-title override remains a shell projection.
  No generated assistant message is inserted into the user's transcript.
- Arm the bridge attempt before the first native turn can emit its user-item notification. Native
  duplicate notifications and repeated command acknowledgements do not create another model
  request. The auxiliary generator retains its existing isolated, read-only, tool-free,
  cancellable 30-second operation and cleanup.
- Manual rename in this bridge cancels an in-flight automatic attempt and is serialized with
  the automatic name write. An externally observed native name, first-query edit/revert, deletion,
  or bridge shutdown also invalidates the result. Immediately before applying it, re-read the
  native name and first-user-item identity. A failed generation or write is non-fatal, is not
  automatically retried, and does not alter the preview. A bridge restart reads the native name
  but does not backfill an unfinished attempt.
- `thread/name/set` has no native compare-and-set. Another independent Codex client may rename
  between the final read and automatic write; cross-process absolute priority is not promised
  without upgrading the pinned native executable. In-app manual titles remain authoritative.

## Acceptance

1. Default settings and no workspace override: a new main session's first substantive input
   starts exactly one background request with `gpt-5.6-luna`; its final validated title replaces
   the preview in header, sidebar and restored mobile snapshot, without an extra chat row.
2. Change the global default from one workspace: an inheriting workspace uses the new model;
   an explicit override does not. Reset the override and it inherits again. Same-path remote
   identities have independent overrides. The conversation model is unchanged.
3. A selected model unavailable in the target catalog, failed account/model request, timeout,
   malformed output or short input leaves the preview and never tries another model.
4. Manual rename, external name update, first-query edit and deletion while a request is pending
   discard its late result. Duplicate native events cannot launch another request. Disconnect
   and restart never replay an uncertain title mutation.
5. The settings controls remain accessible with keyboard and translated labels, including on a
   narrow viewport. Desktop continuous updates and mobile replayable recovery show the same
   native name and preserve a manual shell override.
