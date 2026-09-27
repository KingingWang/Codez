# Codex desktop context prompt

## Outcome

The desktop context prompt is the single system-prompt section that teaches the agent which Codez desktop rendering and interaction features exist, so assistant output uses the syntax the renderer actually supports. It lives in `apps/codez-cli/packages/core/src/context/sections/desktop.ts` and is injected only when the assembled presentation surface is `codez_desktop` (desktop Local Host or desktop-attached remote Host with the server rollout enabled); plain CLI/terminal runs never receive it.

The prompt documents capabilities, not aspirations. Every claim in the section must be backed by an end-to-end implemented path in this repository: a renderer, a tool, or a protocol command the agent can actually reach. A capability that exists only as UI without an agent-reachable trigger is described from the user's perspective (what the user can click), never as an agent action.

## Covered capabilities

| Prompt section | Claim | Backing implementation |
| --- | --- | --- |
| Images | Inline Markdown images render, including local files referenced by absolute path | `packages/ui/src/components/ai-elements/markdown-image.tsx` |
| Diagrams | ```` ```mermaid ```` fenced blocks render as diagrams | `@streamdown/mermaid` plugin in `packages/ui/src/components/ai-elements/message.tsx` |
| Links | Web URLs and local file references render as clickable Markdown links; file links open the preview pane | `packages/ui/src/lib/markdownFileLink.ts`, `packages/ui/src/PreviewPane.tsx` |
| Media | Audio/video files referenced as Markdown file links open the app's media preview when clicked; they do not render inline | `packages/shared/src/media-preview.ts`, `packages/ui/src/previewPaneMediaContent.tsx` |
| Automations | Recurring automations, reminders, monitors, and follow-ups are created/listed/updated/deleted through the `CronCreate`/`CronList`/`CronUpdate`/`CronDelete` tools | `apps/codez-cli/packages/core/src/tool/handlers/cron.ts` |
| Tasks | "task", "thread", "chat", and "conversation" are synonyms; the UI calls each conversation a task. Subtasks of the current request go through the `Agent`/`SendMessage`/`TaskOutput`/`TaskStop` subagent tools | `apps/codez-cli/packages/core/src/tool/handlers/agent.ts`, `send-message.ts`, `task-output.ts`, `task-stop.ts` |
| Inline code comments | The `::code-comment{...}` directive attaches feedback to specific file lines | `packages/ui/src/lib/assistantCodeComment.ts` |

## Non-goals

The prompt must not claim capabilities that are not implemented end-to-end:

- No `::git-stage` / `::git-commit` / `::git-push` / `::git-create-branch` / `::git-create-pr` output directives. Git actions are user-driven through the UI (`packages/ui/src/GitActionMenu.tsx`); assistant output has no directive parser for them.
- No `::created-thread` receipt directive. Task creation/fork is a UI and protocol feature, not an assistant-emitted directive.
- No agent tools for pinning, archiving, or renaming user-level tasks, and no cross-session `wait_threads`/`handoff_thread`. The subagent tools coordinate only agents inside the current runtime.
- No `load_workspace_dependencies` tool.
- No inline audio/video rendering via Markdown image syntax; only images render inline.

## Ownership and gating

```text
Server rollout (desktopContextPrompt.enabled)
  → Main resolveDesktopContextPromptEnabledForHost → Host process env
  → services resolveCodezAgentPresentationSurface → CLI presentationSurface=codez_desktop
  → ContextBuilder injects the desktop_context section (system, cacheHint=stable)
```

- The section is a single owner: `buildDesktopContextSection()` in `apps/codez-cli/packages/core/src/context/sections/desktop.ts`. No other layer may splice capability claims into the system prompt.
- Workflow subagents (`workflowActor`) and sessions with a custom system prompt never receive the section; the builder already skips it on both paths.
- Editing the section must keep every claim aligned with the table above; a renderer or tool change that removes a capability must remove the claim in the same change.

## Acceptance scenarios

1. A desktop-hosted agent's assembled system prompt contains the desktop context section exactly once; a terminal-surface agent's prompt never contains it.
2. The prompt mentions no tool or directive that is absent from the tool registry or the renderer directive parsers (`::code-comment` only).
3. Every local-media, image, link, mermaid, and automation instruction in the prompt resolves to a backing implementation listed in the table.
