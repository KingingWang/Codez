import { z } from "zod";
import type { CodexProcessOptions } from "./contract.js";
import { object } from "./json.js";

const lifecycleMethods = new Set(["thread/start", "thread/resume", "thread/fork"]);
const developerInstructionsSchema = z.string().nullable().optional();
const configSchema = z.object({
  config: z.object({ developer_instructions: developerInstructionsSchema }),
});
const desktopSectionPattern = /<codez-desktop-context>[\s\S]*?<\/codez-desktop-context>\s*/g;

export const CODEZ_DESKTOP_CONTEXT_PROMPT = [
  "<codez-desktop-context>",
  "# Codez Desktop Context",
  "You are running inside the Codez desktop app. Use output syntax supported by its Markdown renderer.",
  "",
  "## Mathematics",
  "- Use $...$ for inline mathematics.",
  "- Use $$...$$ for display mathematics, with each delimiter on its own line and blank lines around the block.",
  String.raw`- Do not use \(...\) or \[...\] as math delimiters; they do not render as mathematics here.`,
  "- Keep complex or multiline equations outside Markdown table cells; use a separate display-math block.",
  "",
  "## Images, diagrams and files",
  "- Display images with standard Markdown image syntax: ![alt](/absolute/path/image.png). Use absolute filesystem paths for local images.",
  "- Use ```mermaid fenced blocks for diagrams. Quote node labels containing punctuation or parentheses.",
  "- Use Markdown links for web URLs and local files, such as [name.md](/absolute/path/name.md). Local file links open the preview pane.",
  "- Reference audio and video as Markdown file links; clicking opens the media preview. Do not use image syntax for audio or video.",
  "",
  "## Tasks and tools",
  '- "Task", "thread", "chat" and "conversation" refer to a conversation; prefer "task" in user-facing text.',
  "- Use only tools actually registered in this Codex session. Use native subagent tools for subtasks when available; do not invent desktop tools or output directives.",
  "- User-level task management and recurring automation management are app UI actions unless this session has an explicitly registered tool for them.",
  "",
  "## Inline code comments",
  "- Use ::code-comment{...} for actionable feedback on specific code lines.",
  "- Required attributes: title, body, file. Optional: start, end (1-based lines), priority (0-3). Use an absolute file path and a tight line range.",
  "</codez-desktop-context>",
].join("\n");

/** One native admission boundary; no configuration writes, history rewrites or second cache. */
export async function prepareCodexDesktopContext(
  method: string,
  params: unknown,
  options: Pick<CodexProcessOptions, "cwd" | "desktopContextPromptEnabled">,
  request: (method: string, params?: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (!options.desktopContextPromptEnabled || !lifecycleMethods.has(method)) return params;
  const input = object(params ?? {});
  if (input.ephemeral === true || input.threadSource === "system") return params;
  const overrides = input.config == null ? {} : object(input.config);
  let instructions =
    developerInstructionsSchema.parse(input.developerInstructions) ??
    developerInstructionsSchema.parse(overrides.developer_instructions);
  if (instructions == null) {
    const response = configSchema.parse(
      await request("config/read", {
        cwd: typeof input.cwd === "string" ? input.cwd : options.cwd,
        includeLayers: false,
      }),
    );
    instructions = response.config.developer_instructions ?? "";
  }
  // Bug 原因：legacy ContextBuilder 不在原生 Codex 路径上。统一在 lifecycle RPC 注入，
  // 保留用户 developer 配置；只替换本模块的保留段，避免恢复/分叉重复追加桌面规则。
  const prefix = instructions.replace(desktopSectionPattern, "").trimEnd();
  return {
    ...input,
    developerInstructions: prefix
      ? `${prefix}\n\n${CODEZ_DESKTOP_CONTEXT_PROMPT}`
      : CODEZ_DESKTOP_CONTEXT_PROMPT,
  };
}
