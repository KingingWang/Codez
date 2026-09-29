// ── 旧协议兼容面（过渡期）──────────────────────────────
// 剩余 5 个导出：旧 configOptions 投影函数（formatModelPickerValue/normalizeAvailableCodezMode/
// getCodezAgentModeSelectOptions/getCodezAgentAvailableModes/
// codezSessionSettingsToCodezConfigOptions；B 类，死期=波次3）。
// 消费者：services codezConfigOptions/botsService、UI codezSessionProjection 等旧栈。
// 2026-09 Guarded 收尾后，CODEZ_AGENT_MODE_OPTIONS 成为 Desktop/手机 Composer、Automation/OffPeak
// 表单共用的唯一模式目录（UI codezSessionProjection / automationAgentConfigOptions 直接消费
// getCodezAgentAvailableModes / getCodezAgentModeSelectOptions / normalizeAvailableCodezMode）。
// 波次3 删除这些导出前必须先把模式目录迁到非 legacy 位置，不能连带删掉目录本身。
import { formatModelPickerValue } from "./model-selection.js";
import type { CodezSessionMode, CodezSessionSettingsState } from "./codez-protocol/index.js";
import type { CodezConfigOption, CodezTaskModeInfo } from "./codez-task-types-core.js";
const MODEL_CONFIG_ID = "model";
const MODEL_CONFIG_CATEGORY = "model";
const MODE_CONFIG_ID = "mode";
const MODE_CONFIG_CATEGORY = "mode";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const THOUGHT_LEVEL_CONFIG_CATEGORY = "thought_level";
const CODEZ_AGENT_MODE_OPTIONS = [
  {
    id: "build",
    name: "Ask before changes",
    description: "Ask before each file changes.",
  },
  {
    id: "guarded",
    name: "Autonomous mode",
    description: "Ask when there’s risk",
  },
  {
    id: "plan",
    name: "Plan mode",
    description: "Inspect the code and present a plan before editing.",
  },
  {
    id: "yolo",
    name: "Full access",
    description: "Edit and run commands with fewer confirmations.",
  },
] as const satisfies readonly CodezTaskModeInfo[];
// 菜单隐藏 Edit 不等于删除历史值；恢复/投影不能因候选变化把旧 edit 降为 build。
const CODEZ_AGENT_MODE_ID_SET = new Set<string>([
  ...CODEZ_AGENT_MODE_OPTIONS.map((mode) => mode.id),
  "edit",
]);

// Codex 会话专用权限档位，与 Codex 原生权限菜单一一对应（specs/codex-permission-modes.md）。
// Plan 是独立勾选维度（collaborationMode），不进该列表；UI 展示文案走 mode.codex.* i18n 键，
// 这里的 name/description 仅供非 i18n 消费方（bridge configOptions 等）兜底。
const CODEX_PERMISSION_MODE_OPTIONS = [
  {
    id: "build",
    name: "Ask for approval",
    description:
      "Read, edit, and run commands in this workspace. Approval is required to access the internet or edit other files.",
  },
  {
    id: "edit",
    name: "Approve for me",
    description: "Only ask for actions detected as potentially unsafe.",
  },
  {
    id: "yolo",
    name: "Full access",
    description:
      "Edit files outside this workspace and access the internet without asking for approval.",
  },
  {
    id: "custom",
    name: "Custom",
    description: "Use the permissions defined in config.toml.",
  },
] as const satisfies readonly CodezTaskModeInfo[];

// OpenRouter 会把 `:free` 作为模型 ID 的一部分。UI/configOptions 的展示态
// 不能再用冒号分隔 thought level，否则草稿选择会静默截断真实 modelId。
export function normalizeAvailableCodezMode(mode: CodezSessionMode): string {
  return CODEZ_AGENT_MODE_ID_SET.has(mode) ? mode : "build";
}

export function getCodezAgentModeSelectOptions(): NonNullable<CodezConfigOption["options"]> {
  return CODEZ_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

export function getCodezAgentAvailableModes(): CodezTaskModeInfo[] {
  return CODEZ_AGENT_MODE_OPTIONS.map((mode) => ({ ...mode }));
}

/** Codex 会话的权限档位目录；edit（Approve for me）可用性由 autoReviewApprovals 能力门控，调用方负责过滤。 */
export function getCodexPermissionModes(): CodezTaskModeInfo[] {
  return CODEX_PERMISSION_MODE_OPTIONS.map((mode) => ({ ...mode }));
}

export function codezSessionSettingsToCodezConfigOptions(
  settings: CodezSessionSettingsState,
): CodezConfigOption[] {
  const configOptions: CodezConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: MODEL_CONFIG_CATEGORY,
      type: "select",
      currentValue: formatModelPickerValue(settings.model.current),
      options: settings.model.available.map((model) => {
        const modelThoughtLevels = model.reasoning?.levels.map((level) => level.value);
        const modelDefaultThoughtLevel =
          model.reasoning?.defaultLevel &&
          modelThoughtLevels?.includes(model.reasoning.defaultLevel)
            ? model.reasoning.defaultLevel
            : undefined;
        return {
          value: formatModelPickerValue(model.ref),
          name: model.label,
          description: model.description,
          modelProviderId: model.ref.providerId,
          modelProviderName: model.providerLabel ?? model.ref.providerId,
          ...(modelThoughtLevels ? { modelThoughtLevels } : {}),
          ...(modelDefaultThoughtLevel ? { modelDefaultThoughtLevel } : {}),
        };
      }),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: MODE_CONFIG_CATEGORY,
      type: "select",
      currentValue: normalizeAvailableCodezMode(settings.mode.current),
      options: getCodezAgentModeSelectOptions(),
    },
  ];
  if (settings.thoughtLevel.enabled) {
    const thoughtLevelValues = new Set(settings.thoughtLevel.available.map((level) => level.value));
    const defaultThoughtLevel =
      settings.thoughtLevel.defaultLevel &&
      thoughtLevelValues.has(settings.thoughtLevel.defaultLevel)
        ? settings.thoughtLevel.defaultLevel
        : undefined;
    configOptions.push({
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought Level",
      category: THOUGHT_LEVEL_CONFIG_CATEGORY,
      type: "select",
      currentValue:
        settings.thoughtLevel.current ??
        defaultThoughtLevel ??
        settings.thoughtLevel.available[0]?.value ??
        "",
      options: settings.thoughtLevel.available.map((level) => ({
        value: level.value,
        name: level.label,
        description: level.description,
      })),
    });
  }
  return configOptions;
}
