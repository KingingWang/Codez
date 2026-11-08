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

/**
 * 拒绝未引用的控制替换/多命令语法。Codex 最终以 shell 执行 command hook，
 * 而项目路径在转译期不可知；不能让占位符后的裸操作符进入运行期展开。
 */
function hasUnquotedShellSyntax(command: string, substitutionOnly = false): boolean {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    // 双引号内 $() 和反引号仍会执行；process 参数只放行会被转义的反引号。
    if (char === "$" && command[index + 1] === "(") return true;
    if (!substitutionOnly && char === "`") return true;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (!substitutionOnly && "<>&;|".includes(char)) {
      return true;
    }
  }
  return quote !== undefined;
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
    if (hasUnquotedShellSyntax(handler.command)) {
      warnings.add("A command hook uses unquoted shell syntax Codex cannot adapt safely");
      return null;
    }
    const command = rewriteKnownArgument(handler.command);
    if (command === null) {
      warnings.add(
        replaceProjectArgument(handler.command) === null
          ? "A command hook uses a project directory as a non-independent argument"
          : `A hook command uses variable \`${unknownVariableName(handler.command)}\` Codex cannot expand`,
      );
      return null;
    }
    return { ...handler, command };
  }
  if (handler.type === "process" && typeof handler.command === "string") {
    // ZCode process 钩子（command+args）→ Codex shell command 字符串。
    const parts = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])];
    const rewritten: Array<string | null> = [];
    let unsafeProjectArgument = false;
    let unsafeShellArgument = false;
    for (const part of parts) {
      if (typeof part !== "string") {
        rewritten.push(null);
        continue;
      }
      const projectFree = replaceProjectArgument(part);
      if (projectFree === null) unsafeProjectArgument = true;
      // process 参数随后会整体双引号化，操作符成为字面量；只有 $() 仍会执行。
      else if (hasUnquotedShellSyntax(part, true)) unsafeShellArgument = true;
      const adapted = projectFree === null ? null : rewriteHookCommand(projectFree);
      rewritten.push(adapted);
    }
    if (unsafeShellArgument || rewritten.some((part) => part === null)) {
      warnings.add(
        unsafeProjectArgument
          ? "A process hook uses a project directory as a non-independent argument"
          : unsafeShellArgument
            ? "A process hook uses unquoted shell syntax Codex cannot adapt safely"
            : "A process hook uses variables Codex cannot expand",
      );
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

/** rewriteHookCommand 的项目目录安全形态由调用方先移除，避免误判拼接形态。 */
function rewriteHookCommand(command: string): string | null {
  let unknownVariable: string | undefined;
  const rewritten = command.replace(VARIABLE_PATTERN, (_, name: string) => {
    if (name === "ZCODE_PLUGIN_ROOT") return "${CLAUDE_PLUGIN_ROOT}";
    if (name === "ZCODE_PLUGIN_DATA") return "${CLAUDE_PLUGIN_DATA}";
    if (HOOK_KNOWN_VARIABLES.has(name)) return `\${${name}}`;
    unknownVariable = name;
    return "";
  });
  return unknownVariable === undefined ? rewritten : null;
}

function unknownVariableName(command: string): string | undefined {
  return [...command.matchAll(VARIABLE_PATTERN)]
    .map(([, name]) => name!)
    .find(
      (name) =>
        name !== "ZCODE_PLUGIN_ROOT" &&
        name !== "ZCODE_PLUGIN_DATA" &&
        !HOOK_KNOWN_VARIABLES.has(name),
    );
}

function rewriteKnownArgument(argument: string): string | null {
  const projectFree = replaceProjectArgument(argument);
  const rewritten = projectFree === null ? null : rewriteHookCommand(projectFree);
  return rewritten === null ? null : quoteDataVariables(rewritten);
}

function quoteDataVariables(command: string): string {
  return command.replace(
    /(?:^|\s)([^\s]*\$\{(?:PLUGIN_DATA|CLAUDE_PLUGIN_DATA)\}[^\s]*)/gu,
    (match, argument: string) => match.replace(argument, quoteShellPart(argument)),
  );
}

/** 项目目录占位只能替换成独立参数或安全相对前缀；其他形态不允许 shell 展开。 */
function replaceProjectArgument(argument: string): string | null {
  const match = /\$\{(ZCODE_PROJECT_DIR|CLAUDE_PROJECT_DIR)(?::[^}]*)?\}/gu.exec(argument);
  if (!match) return argument;
  const end = (match.index ?? 0) + match[0].length;
  const rest = argument.slice(end);
  const prefix = argument.slice(0, match.index);
  // 项目变量前后只能有空白参数边界：安全相对前缀必须是参数末尾，且前缀仍是
  // 独立 shell argument；其他拼接、URL 或赋值形态无法证明安全。
  const standalonePrefix = /^(?:$|[^\s`;&|"'=]+\s$)/u;
  if (!standalonePrefix.test(prefix)) return null;
  // 精确占位符外的 `${` 表示默认值/嵌套引用；正则捕获组存在时也是非精确形态。
  if (match[0].includes(":") || rest.includes("${")) return null;
  if (rest !== "" && rest !== "/" && !rest.startsWith("/") && !rest.startsWith("\\")) {
    return null;
  }
  const replacement = rest === "" ? "." : rest === "/" ? "./" : `.${rest}`;
  return `${prefix}${replacement}`;
}
