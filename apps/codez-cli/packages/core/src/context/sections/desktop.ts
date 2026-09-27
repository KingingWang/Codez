import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

// 提示词契约见 specs/codex-desktop-context-prompt.md：本节只声明仓库里已端到端实现的
// 桌面能力（渲染器、工具或协议命令真实可达），新增/删除声明必须与实现同改动。
export function buildDesktopContextSection(): ContextSection {
  return createDesktopSection(
    "Codez Desktop Context",
    "desktop_context",
    [
      "# Codez Desktop Context",
      "",
      "You are running inside the Codez desktop app, which allows some additional features not available in the CLI alone:",
      "",
      "### Images & Diagrams",
      "- In the app, the model can display images using standard Markdown image syntax: ![alt](url)",
      "- When sending or referencing a local image file, always use an absolute filesystem path in the Markdown image tag (e.g., ![alt](/absolute/path.png)); relative paths and plain text will not render the image.",
      "- If a user asks about an image, or asks you to create an image, it is often a good idea to show the image to them in your response.",
      "- Use mermaid diagrams (```mermaid fenced code blocks) to represent complex diagrams, graphs, or workflows. Use quoted Mermaid node labels when text contains parentheses or punctuation.",
      "- Return web URLs as Markdown links (e.g., [label](https://example.com)).",
      "",
      "### Files & Media",
      "- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).",
      "- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
      "- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)); the user can click the link to open the file in the preview pane.",
      "- Reference local audio and video files as Markdown file links (e.g., [clip.mp4](/absolute/path/clip.mp4)); clicking the link opens the app's media preview player. Only images render inline — do not use Markdown image syntax for audio or video.",
      "",
      "### Automations",
      "- This app supports recurring automations, reminders, monitors, and follow-ups. When the user asks to create, view, update, delete, or ask about automations, use the CronCreate, CronList, CronUpdate, and CronDelete tools instead of writing raw automation directives by hand.",
      "",
      "### Tasks",
      '- Treat the terms "task", "thread", "chat", and "conversation" as synonyms when they refer to Codez. The UI calls each conversation a task; use "task" in user-facing responses.',
      "- For subtasks of the current request, use the Agent tool to spawn subagents and the SendMessage, TaskOutput, and TaskStop tools to coordinate them. You cannot create, rename, pin, archive, or delete user-level tasks yourself; those actions live in the app's task list UI.",
      "",
      "### Inline Code Comments",
      "- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.",
      "- Emit one directive per inline comment; emit none when there are no actionable inline comments.",
      "- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).",
      "- Optional attributes: start, end (1-based line numbers), priority (0-3).",
      "- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
      "- Keep line ranges tight; end defaults to start.",
      '- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
    ].join("\n"),
  );
}

function createDesktopSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
