# Git tools in the conversation status panel

## Behavior and owner

The workspace Git summary remains the source of truth for repository availability, dirty state, branch and ahead/behind counts. The conversation status panel only projects those facts; it does not own Git state or introduce a second refresh path. The existing Git action menu performs commit, push and branch actions.

- In an existing non-Office conversation, display the Git tools section whenever the workspace summary reports a Git repository and Git is available. Do not require line-level additions or deletions: clean repositories, binary changes, empty untracked files, and commits ahead of upstream must not hide the menu.
- Keep non-repositories and unavailable Git hidden. Draft conversations and Office mode retain their existing panel visibility rules.
- The collapsed status capsule must retain a visible "Git tools" summary when the repository has no line-level changes and no higher-priority summary. Expanded Git tools continue to show changes, branch switching and commit/push actions; the action menu owns whether commit or push is currently possible.
- A repository whose summary is temporarily unavailable may show the Git section after the next existing Git refresh; no new renderer-side polling or fallback Git commands are added.

## Acceptance / interaction scenarios

1. In an existing conversation for a clean Git repository, the collapsed capsule shows "Git tools"; expanding it reveals the "Commit or push" row and branch controls.
2. With uncommitted text changes, the capsule retains the `+/-` changes summary and the same menu; with binary or empty-file changes it remains accessible even when `+/-` is zero.
3. After committing but before pushing (`ahead > 0`), the menu remains available and the push action is reachable without making another file change.
4. Non-repositories, unavailable Git, Office mode and draft conversations keep their existing behavior.
