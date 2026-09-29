/**
 * 官方插件转译管线共享的 JSON/变量原语。
 * 独立成模块避免 transpile ↔ hooks 之间的循环依赖。
 */

/** 官方插件配置里的 `${VAR}` 变量引用。 */
export const VARIABLE_PATTERN = /\$\{([^}]+)\}/gu;

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
