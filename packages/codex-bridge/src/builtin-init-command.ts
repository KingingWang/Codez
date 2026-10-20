import { join } from "node:path";

const INIT_COMMAND_PATTERN = /^\/init(?:\s+([\s\S]*))?$/i;

// 直接对齐 `../codex/codex-rs/tui/assets/prompt_for_init_command.md` 原生模板。
const NATIVE_CODEX_INIT_COMMAND_PROMPT = [
  "Generate a file named AGENTS.md that serves as a contributor guide for this repository.",
  "Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.",
  "Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.",
  "Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.",
  "",
  "Document Requirements",
  "",
  '- Title the document "Repository Guidelines".',
  "- Use Markdown headings (#, ##, etc.) for structure.",
  "- Keep the document concise. 200-400 words is optimal.",
  "- Keep explanations short, direct, and specific to this repository.",
  "- Provide examples where helpful (commands, directory paths, naming patterns).",
  "- Maintain a professional, instructional tone.",
  "",
  "Recommended Sections",
  "",
  "Project Structure & Module Organization",
  "",
  "- Outline the project structure, including where the source code, tests, and assets are located.",
  "",
  "Build, Test, and Development Commands",
  "",
  "- List key commands for building, testing, and running locally (e.g., npm test, make build).",
  "- Briefly explain what each command does.",
  "",
  "Coding Style & Naming Conventions",
  "",
  "- Specify indentation rules, language-specific style preferences, and naming patterns.",
  "- Include any formatting or linting tools used.",
  "",
  "Testing Guidelines",
  "",
  "- Identify testing frameworks and coverage requirements.",
  "- State test naming conventions and how to run tests.",
  "",
  "Commit & Pull Request Guidelines",
  "",
  "- Summarize commit message conventions found in the project’s Git history.",
  "- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).",
  "",
  "(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.",
].join("\n");

/**
 * 解析并展开 Codex 桌面端 `/init [notes]` 内建斜杠命令，使用原生 Codex `prompt_for_init_command.md` 提示词。
 * 仅当整条输入以 `/init` 开头时命中；普通正文原样返回 undefined。
 */
export function resolveCodexInitSlashCommandPrompt(
  input: string,
  workingDirectory: string,
): string | undefined {
  const match = INIT_COMMAND_PATTERN.exec(input.trim());
  if (!match) return undefined;
  const args = match[1]?.trim() ?? "";
  const targetPath = join(workingDirectory, "AGENTS.md");
  if (!args) return NATIVE_CODEX_INIT_COMMAND_PROMPT;
  return [
    NATIVE_CODEX_INIT_COMMAND_PROMPT,
    "",
    `- Instruction file: ${targetPath}`,
    "Additional user instructions supplied with /init:",
    "```text",
    args,
    "```",
  ].join("\n");
}
