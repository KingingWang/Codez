# Task Title Authority

Task title can come from several places during a session lifecycle. Renderer code must treat them as ordered candidates instead of letting the newest snapshot string always win.

## Title priority

1. User-renamed title with `titleOverridden=true`.
2. Agent-generated title from the session/title update pipeline.
3. First user query title used as the initial optimistic title.
4. The agent default placeholder `New session`.

## Renderer restore rule

- CLI owns persisted titles and title source; `tasks-index.sqlite` contains their read-only Host projection.
- The active header reads the existing workspace-scoped `CodezTaskService.getTaskMeta` and refreshes on Host metadata events. It does not depend on a sidebar/query-cache row or call `readSession` to obtain a title. Historical and archived sessions can have metadata before their CLI runtime is active.
- `readSession` / `resumeSession` returns a raw agent snapshot. Its projected task meta is only a runtime candidate and can be missing app-side `titleOverridden`.
- Restore and remaining task cache sync paths must merge raw snapshot meta with indexed/query-cache meta before writing renderer caches. The active header uses Host metadata directly; existing optimistic metadata is used only before the indexed record arrives.
- A raw snapshot title must not overwrite a title whose existing meta has `titleOverridden=true`.
- `New session` must not overwrite a non-placeholder title, even when the snapshot has a newer `updatedAt`.
- Generated titles may replace the first query title when there is no user override.

## Codex discovery and sidebar visibility

- For Codex CLI history, an injected `<environment_context>` user-role response item is not a user query or a title, and neither is the user-role `# AGENTS.md instructions for <dir>` … `</INSTRUCTIONS>` fragment Codex writes ahead of the first real user message (native sessions carry no `## My request for Codex:` separator). Rollout discovery takes the first real user-message event (including native `item_completed/UserMessage`), falling back to a clearly non-injected legacy user-role response item and then a goal objective. Native `thread/list` previews with either injected-context shape are unusable title candidates until a real preview or native name is available.
- A non-custom empty title or `New session` is provisional and cannot replace an existing non-placeholder title in the Host task-index mirror or a Controller live overlay. A later real first-query or native name can replace it; a user override continues to win. Re-reading an existing rollout after an upgrade repairs an indexed injected-context title without changing task identity or organization.
- Project, recent, pinned, and grouped sidebar views omit a task row while its effective title is blank, `New session`, or a recognized injected-context title. This is a display projection only: the Host task row, first-submit admission, active conversation, archive/search access, and task/group membership remain intact. The row appears under the same task ID as soon as a valid title arrives; no debounce timer decides visibility. The separate “New task” draft action and an explicitly user-renamed task titled “新任务” remain visible.

## Compatibility

- Workspace-scoped title lookup uses `workspaceIdentity?.trim() || workspacePath`, matching remote workspace isolation. The active read also belongs to its scoped service/attachment and task ID; late responses cannot overwrite a newer target or request.
- The rule applies to desktop `desktop-continuous` restore and web remote `web-remote-replayable` restore. Replayable recovery can use snapshots to refill runtime fields, but it must not bypass the same title authority merge.
