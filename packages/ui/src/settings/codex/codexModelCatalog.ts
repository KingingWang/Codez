import type { CodexModel, ModelSelection } from "@codez/shared";
import { readCodexResource, type CodexRequestSender } from "./codexSettingsData.js";

/** 模型按 catalog provider 的分组（specs/codex-model-provider-grouping.md）。 */
export interface CodexModelProviderGroup {
  providerId: string;
  providerName: string;
  models: CodexModel[];
}

export interface CodexModelCatalog {
  providerId: string;
  models: CodexModel[];
  /**
   * 按 catalog provider 分组的模型。无映射事实（未配置 model_catalog_json 或
   * 目录未声明 provider）时退化为单个激活 provider 组。
   */
  groups: CodexModelProviderGroup[];
  /** Explicit native config absent from discovery; not a fabricated capability record. */
  configuredSelection?: ModelSelection;
  preferredSelection: ModelSelection | null;
}

/** 读取 catalog 文件的 slug→provider 映射（bridge 控制面 catalog/read）。 */
export type CodexCatalogProviderMapReader = (
  cwd: string,
) => Promise<{ models: { slug: string; provider?: string }[] }>;

/** 与 services `groupCodexModelsByProvider` 同一口径：映射命中归组，未命中归激活 provider。 */
export function groupCodexModelsByProvider(
  providerId: string,
  models: readonly CodexModel[],
  providerMap: ReadonlyMap<string, string>,
  providerNames: ReadonlyMap<string, string>,
): CodexModelProviderGroup[] {
  const modelsByProvider = new Map<string, CodexModel[]>();
  for (const model of models) {
    const owner = providerMap.get(model.model) ?? providerId;
    const bucket = modelsByProvider.get(owner);
    if (bucket) bucket.push(model);
    else modelsByProvider.set(owner, [model]);
  }
  const orderedIds = [
    ...(modelsByProvider.has(providerId) ? [providerId] : []),
    ...[...modelsByProvider.keys()].filter((id) => id !== providerId),
  ];
  return orderedIds.map((id) => ({
    providerId: id,
    providerName: providerNames.get(id) ?? id,
    models: modelsByProvider.get(id)!,
  }));
}

function readProviderNames(config: Record<string, unknown>): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const providers = config.model_providers;
  if (providers && typeof providers === "object") {
    for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
      const nameValue =
        value && typeof value === "object" ? (value as Record<string, unknown>).name : undefined;
      if (typeof nameValue === "string" && nameValue.trim()) names.set(id, nameValue.trim());
    }
  }
  return names;
}

export async function readCodexModelCatalog(
  cwd: string,
  send: CodexRequestSender,
  readProviderMap?: CodexCatalogProviderMapReader,
): Promise<CodexModelCatalog> {
  const [config, catalog, providerMapResult] = await Promise.all([
    readCodexResource("config", cwd, send),
    readCodexResource("models", cwd, send),
    // 目录映射是可选增强：读取失败降级为单激活 provider 组，不阻断模型列表。
    readProviderMap ? readProviderMap(cwd).catch(() => null) : Promise.resolve(null),
  ]);
  const providerId =
    typeof config.config.model_provider === "string" ? config.config.model_provider : "openai";
  const models = catalog.data.filter((model) => !model.hidden);
  const providerMap = new Map<string, string>(
    (providerMapResult?.models ?? [])
      .filter((entry): entry is { slug: string; provider: string } => Boolean(entry.provider))
      .map((entry) => [entry.slug, entry.provider]),
  );
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
    groups: groupCodexModelsByProvider(
      providerId,
      models,
      providerMap,
      readProviderNames(config.config),
    ),
    configuredSelection,
    preferredSelection:
      configuredSelection ??
      (model && effort
        ? {
            // 根因：配置 provider 不一定拥有默认模型，沿用它会让新任务显示正常却无法发送。
            providerId: providerMap.get(model.model) ?? providerId,
            modelId: model.model,
            options: { reasoningLevel: effort },
          }
        : null),
  };
}

/** 目录内按 (providerId, modelId) 定位；已知 provider 未命中时跨组唯一命中则治愈。 */
export function findCodexCatalogModel(
  catalog: Pick<CodexModelCatalog, "providerId" | "groups">,
  selection: { providerId: string; modelId: string },
): { group: CodexModelProviderGroup; model: CodexModel } | null {
  const group = catalog.groups.find((entry) => entry.providerId === selection.providerId);
  // 配置 provider 的全部模型可能已归到别组；它仍是本工作区已知身份，允许旧草稿唯一匹配修正。
  // 其他未知 provider（legacy/其他 Host 残留）不猜归属，由调用方按既有口径处理。
  if (!group && selection.providerId !== catalog.providerId) return null;
  const inGroup = group?.models.find((candidate) => candidate.model === selection.modelId);
  if (group && inGroup) return { group, model: inGroup };
  // 组内未命中：兼容分组引入前存储的「激活 provider + 其他组模型」旧值，
  // 跨组唯一命中（按组去重）则治愈为模型实际归属组；同名多组共存时不猜归属。
  const matches = catalog.groups
    .filter((entry) => entry.providerId !== selection.providerId)
    .flatMap((entry) =>
      entry.models
        .filter((candidate) => candidate.model === selection.modelId)
        .map((model) => ({ group: entry, model })),
    );
  const distinctGroups = new Set(matches.map((match) => match.group.providerId));
  return distinctGroups.size === 1 ? (matches[0] ?? null) : null;
}

export function resolveCodexSelection(
  catalog: CodexModelCatalog,
  selection?: ModelSelection | null,
): ModelSelection | null {
  // 旧 Z.ai Recent 不属于 native workspace provider，不能继续阻断新的 Codex 草稿。
  if (!selection) return catalog.preferredSelection;
  const configured = catalog.configuredSelection;
  if (configured && selection.modelId === configured.modelId) {
    // 配置模型挂在激活 provider 组；provider 不匹配时按目录归属解析（若有）。
    if (
      selection.providerId === configured.providerId ||
      !findCodexCatalogModel(catalog, selection)
    ) {
      return selection.options?.reasoningLevel
        ? selection.providerId === configured.providerId
          ? selection
          : { ...selection, providerId: configured.providerId }
        : configured;
    }
  }
  const located = findCodexCatalogModel(catalog, selection);
  if (located) {
    const { group, model } = located;
    // 无需治愈时保持引用不变：调用方以引用相等判断选择是否变化。
    if (selection.options?.reasoningLevel)
      return group.providerId === selection.providerId
        ? selection
        : { ...selection, providerId: group.providerId };
    return {
      ...selection,
      providerId: group.providerId,
      options: { reasoningLevel: model.defaultReasoningEffort },
    };
  }
  // 已知 provider 的模型被移除或归属有歧义 = 明确无效（阻断）；完全陌生的 provider
  // （legacy/其他 Host 残留）= 迁移到首选，不阻断草稿。
  if (
    selection.providerId === catalog.providerId ||
    catalog.groups.some((group) => group.providerId === selection.providerId)
  )
    return null;
  return catalog.preferredSelection;
}

export function isCodexSelectionReady(
  catalog: CodexModelCatalog | undefined,
  selection?: ModelSelection | null,
): boolean {
  if (!catalog || !selection) return false;
  if (!catalog.groups.some((group) => group.providerId === selection.providerId)) return false;
  if (selection.modelId === catalog.configuredSelection?.modelId) return true;
  const model = catalog.models.find((candidate) => candidate.model === selection.modelId);
  return Boolean(
    model?.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === selection.options?.reasoningLevel,
    ),
  );
}
