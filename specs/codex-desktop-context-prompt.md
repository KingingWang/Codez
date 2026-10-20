# Codex desktop context prompt

## Outcome

The desktop context prompt teaches the agent which Codez desktop rendering and interaction features exist, so assistant output uses the syntax the renderer actually supports. The legacy Codez CLI owns its system section in `apps/codez-cli/packages/core/src/context/sections/desktop.ts`. The default native Codex runtime owns its developer section in `packages/codex-bridge/src/desktop-context.ts`; changing the legacy section alone does not affect Codex.

Both paths are gated by the Host's assembled desktop presentation surface (desktop Local Host or desktop-attached remote Host with the server rollout enabled). Plain CLI/terminal runs never receive the section.

The prompt documents capabilities, not aspirations. Every claim in the section must be backed by an end-to-end implemented path in this repository: a renderer, a tool, or a protocol command the agent can actually reach. A capability that exists only as UI without an agent-reachable trigger is described from the user's perspective (what the user can click), never as an agent action.

## Covered capabilities

| Prompt section       | Claim                                                                                                                                                                                                         | Backing implementation                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Images               | Inline Markdown images render, including local files referenced by absolute path                                                                                                                              | `packages/ui/src/components/ai-elements/markdown-image.tsx`                                                    |
| Diagrams             | ` ```mermaid ` fenced blocks render as diagrams                                                                                                                                                               | `@streamdown/mermaid` plugin in `packages/ui/src/components/ai-elements/message.tsx`                           |
| Links                | Web URLs and local file references render as clickable Markdown links; file links open the preview pane                                                                                                       | `packages/ui/src/lib/markdownFileLink.ts`, `packages/ui/src/PreviewPane.tsx`                                   |
| Media                | Audio/video files referenced as Markdown file links open the app's media preview when clicked; they do not render inline                                                                                      | `packages/shared/src/media-preview.ts`, `packages/ui/src/previewPaneMediaContent.tsx`                          |
| Automations          | Recurring automations, reminders, monitors, and follow-ups are created/listed/updated/deleted through the `CronCreate`/`CronList`/`CronUpdate`/`CronDelete` tools                                             | `apps/codez-cli/packages/core/src/tool/handlers/cron.ts`                                                       |
| Tasks                | "task", "thread", "chat", and "conversation" are synonyms; the UI calls each conversation a task. Subtasks of the current request go through the `Agent`/`SendMessage`/`TaskOutput`/`TaskStop` subagent tools | `apps/codez-cli/packages/core/src/tool/handlers/agent.ts`, `send-message.ts`, `task-output.ts`, `task-stop.ts` |
| Inline code comments | The `::code-comment{...}` directive attaches feedback to specific file lines                                                                                                                                  | `packages/ui/src/lib/assistantCodeComment.ts`                                                                  |

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

- The legacy section has a single owner: `buildDesktopContextSection()` in `apps/codez-cli/packages/core/src/context/sections/desktop.ts`. No other legacy layer may splice capability claims into the system prompt.
- Workflow subagents (`workflowActor`) and sessions with a custom system prompt never receive the section; the builder already skips it on both paths.
- Editing the section must keep every claim aligned with the table above; a renderer or tool change that removes a capability must remove the claim in the same change.

## Native Codex ownership and injection

```text
Main rollout → local / desktop-attached remote Host presentationSurface
  → resolveCodexBridgeCommand: existing CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED=1/0
  → bridge main: CodexProcessOptions.desktopContextPromptEnabled
  → native RPC boundary: thread/start | thread/resume | thread/fork
       → config/read(cwd, includeLayers=false), when no explicit developer override
       → preserve effective user developer instructions + one desktop section
       → original lifecycle RPC with developerInstructions
       → native Codex owns session context, persistence and execution

desktop-continuous ───────────────┐
web-remote-replayable + reconnect ┴─ same native resume boundary; no UI-owned context
```

- `desktop-context.ts` is the sole native desktop text/composition owner. The existing transport boundary applies it to all user-facing creation, resume and fork calls, including auxiliary side chats. Do not duplicate it in individual command handlers.
- `resolveCodexBridgeCommand` derives the existing environment flag from its trusted `presentationSurface`; an inherited flag must not grant desktop capability to a non-desktop Host. No new environment variable or user setting is introduced.
- Merge via the supported `developerInstructions` lifecycle parameter; never replace `baseInstructions`, collaboration-mode instructions or the model prompt.
- Preserve explicit `developerInstructions` first, then a request-local `config.developer_instructions`, then native `config/read`'s effective user/project instructions. Null means inherit; an explicit empty string remains an empty user instruction prefix.
- Read configuration for each lifecycle admission; do not keep a second configuration cache or write `config.toml`. Configuration read/validation failure rejects admission before any lifecycle mutation, rather than silently dropping user instructions. Native lifecycle mutations are not retried.
- The reserved `<codez-desktop-context>` block is replaced when composing an already-decorated instruction string, so the supplied developer parameter contains exactly one current section. Native Codex remains responsible for history and context compaction; do not rewrite history to remove old items.
- `ephemeral: true` or `threadSource: "system"` threads (title and commit-subject generation) retain their existing isolated instructions. Ordinary reads, turns, queue admission and subscriptions are not decorated.
- Existing loaded threads adopt the section on their next native resume after a bridge restart; do not restart or interrupt a running turn solely to update its prompt. Native writer-conflict and already-loaded resume behavior remain unchanged.
- Native instructions describe only shared renderer features and registered native tools. They must not advertise legacy `CronCreate`/`Agent` tools, missing thread-management tools, Git directives or inline audio/video rendering.
- Inline mathematics uses `$...$`; display mathematics uses `$$...$$`, with delimiter lines and blank lines around the block. Do not use `\(...\)` or `\[...\]` for rendered mathematics. Keep complex/multiline equations outside Markdown table cells. This is output guidance, not a promise that every model output is valid.

## Acceptance scenarios

1. A desktop-hosted agent's assembled instructions contain the desktop context section exactly once (legacy system section / native developer section); a terminal-surface agent's prompt never contains it.
2. The prompt mentions no tool or directive that is absent from the tool registry or the renderer directive parsers (`::code-comment` only).
3. Every local-media, image, link, mermaid, and automation instruction in the prompt resolves to a backing implementation listed in the table.
4. Native user-facing create/resume/fork receives exactly one desktop section before any first model request; user developer instructions and model/base/collaboration instructions survive unchanged.
5. Disabled/non-desktop Hosts, independent Codex CLI and ephemeral/system threads do not receive the section or extra configuration reads.
6. Request-local and explicit developer overrides retain native precedence; repeat composition is idempotent, and configuration failure prevents lifecycle admission.
7. Local and desktop-attached remote command resolution produce the same enabled marker; plain remote app-server/CLI produces `0`, even with an inherited `1`.
8. Real pinned native + bundled bridge with an isolated loopback provider proves that new, forked and resumed turns contain the desktop math guidance plus synthetic user instructions. Both desktop-continuous and web-remote-replayable subscriptions use the same native context.
9. The actual isolated Electron conversation check confirms one desktop section and math guidance on every native model request, including queued and preempted turns. QA diagnostics expose only section counts and booleans, never system/developer text or user input.
