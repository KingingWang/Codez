import { z } from "zod";
import {
  formatModelPickerValue,
  codezSessionSettingsStateSchema,
  codezWorkspacePresentationSchema,
  codezSkillsReferenceCatalogResultSchema,
  type CodezSessionSettingsState,
  type CodezWorkspaceRef,
} from "@codez/shared";
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

/**
 * 线程级已生效的模型选择。legacy 会话回包（session/setModel、session/resume 等）的
 * current 必须来自线程状态而不是全局 config.toml；仅目录（available）与缺省档
 * 仍由全局视图提供。无线程模型时不传 override，行为与原全局视图一致。
 */
export interface ControlModelThreadOverride {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
}

export async function readControlModelSettings(
  context: BridgeControlContext,
  threadOverride?: ControlModelThreadOverride,
): Promise<CodezSessionSettingsState> {
  const [config, models] = await Promise.all([
    readConfig(context),
    readPages(context, "model/list", modelSchema, { includeHidden: false }),
  ]);
  // 线程级显式选择优先于全局 config.toml：session/setModel 经 thread/settings/update
  // 生效后，回包若改用全局视图会把会话当前模型打回旧值（Bot 切模型"不生效"根因）。
  // 全局 config 只提供目录与缺省档；线程已生效的模型/档位以 override 为准。
  const providerId = threadOverride?.modelProvider || config.model_provider || "openai";
  const requestedModel = threadOverride?.model || config.model || undefined;
  const selected =
    models.find((model) => model.model === requestedModel) ??
    (!requestedModel ? models.find((model) => model.isDefault) : undefined);
  const modelId = requestedModel || selected?.model;
  // 档位必须与 current 描述同一模型：线程档缺省时回落到线程模型的目录默认档，
  // 不借用全局 config 里另一个模型的档位。
  const reasoningLevel = threadOverride
    ? threadOverride.reasoningEffort || selected?.defaultReasoningEffort
    : config.model_reasoning_effort || selected?.defaultReasoningEffort;
  const levels = (selected?.supportedReasoningEfforts ?? []).map((effort) => ({
    value: effort.reasoningEffort,
    label: effort.reasoningEffort,
    description: effort.description,
  }));
  // 全局 config 不是线程级档位：Codex 会话"跟随 config.toml"的语义即 custom 档
  // （specs/codex-permission-modes.md）；线程级投影由 projectThreadMode 负责。
  const mode = "custom" as const;
  const current = modelId
    ? { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) }
    : undefined;
  return codezSessionSettingsStateSchema.parse({
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
  return codezSkillsReferenceCatalogResultSchema.parse({
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
  workspace: CodezWorkspaceRef,
  context: BridgeControlContext,
) {
  const settings = await readControlModelSettings(context);
  // 修复原因：`SlashCommandPlugin` 有独立的「技能」分组（通过 `skills/referenceCatalog` 拉取并展示为 `$skill`）。
  // 之前把 `catalog.skills` 混入 `slashCommands` 会导致所有技能跑到「命令」分组底下变成 `/skill`，
  // 既放错分组又产生错误的 `/skill` mention。因此 `slashCommands` 只返回真正的内置斜杠命令。
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
      inputHint: "plan | build | edit | yolo | custom",
      source: "builtin" as const,
    },
    {
      name: "plan",
      description: "Turn on plan mode",
      inputHint: "/plan [task]",
      source: "builtin" as const,
    },
    {
      name: "init",
      description: "Create an AGENTS.md file with instructions for Codex",
      inputHint: "/init [notes]",
      source: "builtin" as const,
    },
    {
      name: "compact",
      description: "Compact the current Codex thread",
      source: "builtin" as const,
    },
    {
      name: "goal",
      description: "Set a goal to keep pursuing",
      inputHint: "/goal <objective>",
      source: "builtin" as const,
    },
  ];
  return codezWorkspacePresentationSchema.parse({
    workspace,
    mode: settings.mode.current,
    slashCommands: builtins,
  });
}
