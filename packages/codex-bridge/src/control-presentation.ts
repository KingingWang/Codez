import { z } from "zod";
import {
  formatModelPickerValue,
  zcodeSessionSettingsStateSchema,
  zcodeWorkspacePresentationSchema,
  zcodeSkillsReferenceCatalogResultSchema,
  type ZCodeSessionSettingsState,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import type { BridgeControlContext } from "./contract.js";
import { readConfig, readPages } from "./control-common.js";

const modelSchema = z.object({
  id: z.string(),
  model: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  inputModalities: z.array(z.enum(["text", "image", "audio"])),
  defaultReasoningEffort: z.string(),
  supportedReasoningEfforts: z.array(
    z.object({ reasoningEffort: z.string(), description: z.string() }),
  ),
});
const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1),
  scope: z.enum(["repo", "user", "system", "admin"]),
  enabled: z.boolean(),
  pluginId: z.string().nullable(),
});
const skillsResponseSchema = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(skillSchema),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ),
});

export async function readControlModelSettings(
  context: BridgeControlContext,
): Promise<ZCodeSessionSettingsState> {
  const [config, models] = await Promise.all([
    readConfig(context),
    readPages(context, "model/list", modelSchema, { includeHidden: false }),
  ]);
  const providerId = config.model_provider || "openai";
  const selected =
    models.find((model) => model.model === config.model) ??
    (!config.model ? models.find((model) => model.isDefault) : undefined);
  const modelId = config.model || selected?.model;
  const reasoningLevel = config.model_reasoning_effort || selected?.defaultReasoningEffort;
  const levels = (selected?.supportedReasoningEfforts ?? []).map((effort) => ({
    value: effort.reasoningEffort,
    label: effort.reasoningEffort,
    description: effort.description,
  }));
  // Codex sandbox 不是独立计划状态；只有明确完全放权才展示 yolo。
  const mode =
    config.sandbox_mode === "danger-full-access" && config.approval_policy === "never"
      ? "yolo"
      : "build";
  const current = modelId
    ? { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) }
    : undefined;
  return zcodeSessionSettingsStateSchema.parse({
    model: {
      ...(current ? { current } : {}),
      available: [
        ...models
          .filter((model) => !model.hidden)
          .map((model) => ({
            ref: {
              providerId,
              modelId: model.model,
              ...(model.defaultReasoningEffort
                ? { options: { reasoningLevel: model.defaultReasoningEffort } }
                : {}),
            },
            label: model.displayName,
            providerLabel: providerId,
            description: model.description,
            reasoning: {
              levels: model.supportedReasoningEfforts.map((effort) => ({
                value: effort.reasoningEffort,
                label: effort.reasoningEffort,
                description: effort.description,
              })),
              ...(model.defaultReasoningEffort
                ? { defaultLevel: model.defaultReasoningEffort }
                : {}),
            },
            properties: {
              inputFormat: {
                supportsText: model.inputModalities.includes("text"),
                supportsImage: model.inputModalities.includes("image"),
                supportsVideo: false,
                supportsAudio: model.inputModalities.includes("audio"),
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
            },
          })),
        // 配置事实足以保留选择，但不是目录能力证明；必填布尔值保守不宣告支持。
        ...(current && !models.some((model) => !model.hidden && model.model === current.modelId)
          ? [
              {
                ref: current,
                label: `${current.modelId} (configured)`,
                providerLabel: providerId,
                description:
                  "Configured native model; format and reasoning capabilities are not advertised by the catalog.",
                properties: {
                  inputFormat: {
                    supportsText: false,
                    supportsImage: false,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: false },
                },
              },
            ]
          : []),
      ],
    },
    thoughtLevel: {
      enabled: levels.length > 0,
      available: levels,
      ...(reasoningLevel ? { current: reasoningLevel } : {}),
      ...(selected?.defaultReasoningEffort
        ? { defaultLevel: selected.defaultReasoningEffort }
        : {}),
    },
    mode: { current: mode },
    permission: { mode },
  });
}

export async function readControlSkills(context: BridgeControlContext) {
  const response = skillsResponseSchema.parse(
    await context.rpc.request("skills/list", { cwds: [context.cwd] }),
  );
  const entry = response.data.find((row) => row.cwd === context.cwd);
  if (!entry) throw new Error("Codex skills/list omitted the requested workspace");
  // 发现失败不能投影成权威空目录，否则旧对话会悄悄丢失可引用能力。
  if (entry.errors.length)
    throw new Error(
      `Codex skill discovery failed: ${entry.errors.map((error) => error.message).join("; ")}`,
    );
  return zcodeSkillsReferenceCatalogResultSchema.parse({
    authority: "workspace",
    skills: entry.skills
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        id: skill.path,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        scope: skill.pluginId ? "plugin" : skill.scope === "repo" ? "workspace" : "user",
        enabled: true,
      })),
  });
}

export async function readControlPresentation(
  workspace: ZCodeWorkspaceRef,
  context: BridgeControlContext,
) {
  const [settings, catalog] = await Promise.all([
    readControlModelSettings(context),
    readControlSkills(context),
  ]);
  const builtins = [
    {
      name: "model",
      description: "Select Codex model",
      inputHint: settings.model.available
        .map((model) => formatModelPickerValue(model.ref))
        .join(" | "),
      source: "builtin" as const,
    },
    {
      name: "mode",
      description: "Select permission mode",
      inputHint: "plan | build | yolo",
      source: "builtin" as const,
    },
    {
      name: "compact",
      description: "Compact the current Codex thread",
      source: "builtin" as const,
    },
  ];
  const names = new Set(builtins.map((command) => command.name));
  return zcodeWorkspacePresentationSchema.parse({
    workspace,
    mode: settings.mode.current,
    slashCommands: [
      ...builtins,
      ...catalog.skills
        .filter((skill) => {
          if (names.has(skill.name)) return false;
          names.add(skill.name);
          return true;
        })
        .map((skill) => ({ name: skill.name, description: skill.description, source: "custom" })),
    ],
  });
}
