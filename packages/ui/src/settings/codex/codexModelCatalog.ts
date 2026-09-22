import type { CodexModel, ModelSelection } from "@zcode/shared";
import { readCodexResource, type CodexRequestSender } from "./codexSettingsData.js";

export interface CodexModelCatalog {
  providerId: string;
  models: CodexModel[];
  /** Explicit native config absent from discovery; not a fabricated capability record. */
  configuredSelection?: ModelSelection;
  preferredSelection: ModelSelection | null;
}

export async function readCodexModelCatalog(
  cwd: string,
  send: CodexRequestSender,
): Promise<CodexModelCatalog> {
  const [config, catalog] = await Promise.all([
    readCodexResource("config", cwd, send),
    readCodexResource("models", cwd, send),
  ]);
  const providerId =
    typeof config.config.model_provider === "string" ? config.config.model_provider : "openai";
  const models = catalog.data.filter((model) => !model.hidden);
  const configuredModel =
    typeof config.config.model === "string" && config.config.model.trim()
      ? config.config.model
      : undefined;
  const model =
    typeof config.config.model === "string"
      ? models.find((candidate) => candidate.model === config.config.model)
      : models.find((candidate) => candidate.isDefault);
  const effort =
    typeof config.config.model_reasoning_effort === "string"
      ? config.config.model_reasoning_effort
      : model?.defaultReasoningEffort;
  // 原生 custom provider 的 model/list 可能仍是 OpenAI 列表；显式有效配置才是此模型的权威。
  // 只保留配置事实，不补造 reasoning 档位、默认值或其他模型能力。
  const configuredSelection =
    configuredModel && !models.some((entry) => entry.model === configuredModel)
      ? {
          providerId,
          modelId: configuredModel,
          ...(effort ? { options: { reasoningLevel: effort } } : {}),
        }
      : undefined;
  return {
    providerId,
    models,
    configuredSelection,
    preferredSelection:
      configuredSelection ??
      (model && effort
        ? {
            providerId,
            modelId: model.model,
            options: { reasoningLevel: effort },
          }
        : null),
  };
}

export function resolveCodexSelection(
  catalog: CodexModelCatalog,
  selection?: ModelSelection | null,
): ModelSelection | null {
  // 旧 Z.ai Recent 不属于 native workspace provider，不能继续阻断新的 Codex 草稿。
  if (!selection || selection.providerId !== catalog.providerId) return catalog.preferredSelection;
  if (selection.modelId === catalog.configuredSelection?.modelId)
    return selection.options?.reasoningLevel ? selection : catalog.configuredSelection;
  const model = catalog.models.find((candidate) => candidate.model === selection.modelId);
  if (!model) return null;
  return selection.options?.reasoningLevel
    ? selection
    : {
        ...selection,
        options: { reasoningLevel: model.defaultReasoningEffort },
      };
}

export function isCodexSelectionReady(
  catalog: CodexModelCatalog | undefined,
  selection?: ModelSelection | null,
): boolean {
  if (!catalog || !selection || selection.providerId !== catalog.providerId) return false;
  if (selection.modelId === catalog.configuredSelection?.modelId) return true;
  const model = catalog.models.find((candidate) => candidate.model === selection.modelId);
  return Boolean(
    model?.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === selection.options?.reasoningLevel,
    ),
  );
}
