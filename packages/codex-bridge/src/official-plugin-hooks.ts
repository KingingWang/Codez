/**
 * 官方插件钩子（hooks.json / manifest.hooks）→ Codex 钩子格式的适配。
 * 规则数据驱动：事件白名单 + handler 类型映射 + 变量改写，不按插件名特判。
 */
import { isObject, VARIABLE_PATTERN } from "./official-plugin-utils.js";
import type { JsonObject } from "./official-plugin-utils.js";

/** Codex 钩子发现期会展开的变量；钩子命令里保留变量形式。 */
const HOOK_KNOWN_VARIABLES = new Set([
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "PLUGIN_DATA",
]);

/** Codex 钩子事件白名单（codex-rs hooks schema）。 */
const CODEX_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
]);

/** shell 参数转义：裸标识符保持原样；含变量/空格/路径分隔符的参数用双引号包裹，
 * 保留 `$` 供 `${CLAUDE_PLUGIN_ROOT}` 展开，转义反斜杠/引号/反引号。 */
function quoteShellPart(value: string): string {
  if (/^[a-zA-Z0-9._-]+$/u.test(value)) return value;
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/`/gu, "\\`")}"`;
}

/** 适配 hooks 容器（原地修改）。返回是否仍有可用钩子。 */
export function adaptHooks(hooks: JsonObject, warnings: Set<string>): boolean {
  let surviving = false;
  for (const [event, groupsValue] of Object.entries(hooks)) {
    if (!CODEX_HOOK_EVENTS.has(event)) {
      warnings.add(`Hook event \`${event}\` is not supported by Codex`);
      delete hooks[event];
      continue;
    }
    if (!Array.isArray(groupsValue)) {
      delete hooks[event];
      continue;
    }
    const groups = groupsValue.filter(isObject);
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) {
        group.hooks = [];
        continue;
      }
      const handlers = group.hooks as unknown[];
      const adaptedHandlers = handlers.flatMap((handler) => {
        const adapted = adaptHookHandler(handler, warnings);
        return adapted ? [adapted] : [];
      });
      group.hooks = adaptedHandlers;
      if (adaptedHandlers.length > 0) surviving = true;
    }
    hooks[event] = groups.filter((group) => Array.isArray(group.hooks) && group.hooks.length > 0);
    if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
  }
  return surviving;
}

function adaptHookHandler(handler: unknown, warnings: Set<string>): JsonObject | null {
  if (!isObject(handler)) return null;
  if (handler.type === "command" && typeof handler.command === "string") {
    const command = rewriteHookCommand(handler.command);
    if (command === null) {
      warnings.add("A hook command uses variables Codex cannot expand");
      return null;
    }
    return { ...handler, command };
  }
  if (handler.type === "process" && typeof handler.command === "string") {
    // ZCode process 钩子（command+args）→ Codex shell command 字符串。
    const parts = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])];
    const rewritten = parts.map((part) =>
      typeof part === "string" ? rewriteHookCommand(part) : null,
    );
    if (rewritten.some((part) => part === null)) {
      warnings.add("A process hook uses variables Codex cannot expand");
      return null;
    }
    const command = (rewritten as string[]).map(quoteShellPart).join(" ");
    const result: JsonObject = { type: "command", command };
    if (typeof handler.timeoutMs === "number") {
      result.timeout = Math.max(1, Math.ceil(handler.timeoutMs / 1000));
    }
    if (typeof handler.statusMessage === "string") result.statusMessage = handler.statusMessage;
    return result;
  }
  warnings.add(`A hook handler of type \`${String(handler.type)}\` is not supported by Codex`);
  return null;
}

/** 钩子命令变量改写：ZCODE_* → CLAUDE_* 变量形式（Codex 发现期展开），其余拒绝。 */
function rewriteHookCommand(command: string): string | null {
  let failed = false;
  const rewritten = command.replace(VARIABLE_PATTERN, (_, name: string) => {
    if (name === "ZCODE_PLUGIN_ROOT") return "${CLAUDE_PLUGIN_ROOT}";
    if (name === "ZCODE_PROJECT_DIR") return "${CLAUDE_PROJECT_DIR}";
    if (HOOK_KNOWN_VARIABLES.has(name)) return `\${${name}}`;
    failed = true;
    return "";
  });
  return failed ? null : rewritten;
}
