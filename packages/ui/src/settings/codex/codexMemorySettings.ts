import { type CodexConfigResponse } from "@codez/shared";

/**
 * 原生 Codex 记忆配置视图（spec: specs/codez-memory-settings.md「Codex 适配器路径」）。
 * 布尔/数值字段 undefined = 未在 config.toml 显式配置（原生默认值生效）；
 * featureEnabled 例外：config/read 总会返回 features.memories 的解析值。
 */
export interface CodexMemoryConfigView {
  featureEnabled: boolean;
  useMemories?: boolean;
  generateMemories?: boolean;
  dedicatedTools?: boolean;
  disableOnExternalContext?: boolean;
  extractModel?: string;
  consolidationModel?: string;
  maxRolloutsPerStartup?: number;
  maxRolloutAgeDays?: number;
  minRolloutIdleHours?: number;
  maxRawMemoriesForConsolidation?: number;
  maxUnusedDays?: number;
  minRateLimitRemainingPercent?: number;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function codexMemoryConfigView(
  config: CodexConfigResponse | undefined,
): CodexMemoryConfigView {
  const root = (config?.config ?? {}) as Record<string, unknown>;
  const features =
    typeof root.features === "object" && root.features !== null
      ? (root.features as Record<string, unknown>)
      : {};
  const memories =
    typeof root.memories === "object" && root.memories !== null
      ? (root.memories as Record<string, unknown>)
      : {};
  return {
    featureEnabled: features.memories === true,
    useMemories: optionalBoolean(memories.use_memories),
    generateMemories: optionalBoolean(memories.generate_memories),
    dedicatedTools: optionalBoolean(memories.dedicated_tools),
    disableOnExternalContext: optionalBoolean(memories.disable_on_external_context),
    extractModel: optionalString(memories.extract_model),
    consolidationModel: optionalString(memories.consolidation_model),
    maxRolloutsPerStartup: optionalFiniteNumber(memories.max_rollouts_per_startup),
    maxRolloutAgeDays: optionalFiniteNumber(memories.max_rollout_age_days),
    minRolloutIdleHours: optionalFiniteNumber(memories.min_rollout_idle_hours),
    maxRawMemoriesForConsolidation: optionalFiniteNumber(
      memories.max_raw_memories_for_consolidation,
    ),
    maxUnusedDays: optionalFiniteNumber(memories.max_unused_days),
    minRateLimitRemainingPercent: optionalFiniteNumber(memories.min_rate_limit_remaining_percent),
  };
}

/** value 传 null 时删除该键，恢复原生默认（与 config/batchWrite 的 replace 语义一致）。 */
export function codexMemoryEdit(
  keyPath: string,
  value: boolean | number | string | null,
): { keyPath: string; value: boolean | number | string | null; mergeStrategy: "replace" } {
  return { keyPath, value, mergeStrategy: "replace" };
}

/** 原生数值范围与默认值（codex-rs config/src/types.rs 的 clamp/常量）。labelKey 对应 messages.ts 的文案键。 */
export const CODEX_MEMORY_NUMBER_FIELDS = [
  {
    key: "maxRolloutsPerStartup",
    keyPath: "memories.max_rollouts_per_startup",
    min: 1,
    max: 128,
    defaultValue: 2,
    labelKey: "memoryMaxRolloutsPerStartup",
  },
  {
    key: "maxRolloutAgeDays",
    keyPath: "memories.max_rollout_age_days",
    min: 0,
    max: 90,
    defaultValue: 10,
    labelKey: "memoryMaxRolloutAgeDays",
  },
  {
    key: "minRolloutIdleHours",
    keyPath: "memories.min_rollout_idle_hours",
    min: 1,
    max: 48,
    defaultValue: 6,
    labelKey: "memoryMinRolloutIdleHours",
  },
  {
    key: "maxRawMemoriesForConsolidation",
    keyPath: "memories.max_raw_memories_for_consolidation",
    min: 1,
    max: 4096,
    defaultValue: 256,
    labelKey: "memoryMaxRawMemories",
  },
  {
    key: "maxUnusedDays",
    keyPath: "memories.max_unused_days",
    min: 0,
    max: 365,
    defaultValue: 30,
    labelKey: "memoryMaxUnusedDays",
  },
  {
    key: "minRateLimitRemainingPercent",
    keyPath: "memories.min_rate_limit_remaining_percent",
    min: 0,
    max: 100,
    defaultValue: 25,
    labelKey: "memoryMinRateLimitPercent",
  },
] as const;
export type CodexMemoryNumberField = (typeof CODEX_MEMORY_NUMBER_FIELDS)[number];

/** 空串 = 清除该键（恢复默认）；否则校验整数范围，越界返回 null 由调用方提示。 */
export function codexMemoryNumberEdit(
  field: CodexMemoryNumberField,
  raw: string,
): { keyPath: string; value: number | null; mergeStrategy: "replace" } | null {
  const trimmed = raw.trim();
  if (trimmed === "") return { keyPath: field.keyPath, value: null, mergeStrategy: "replace" };
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (value < field.min || value > field.max) return null;
  return { keyPath: field.keyPath, value, mergeStrategy: "replace" };
}
