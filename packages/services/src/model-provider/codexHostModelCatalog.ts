import type {
  EffectiveModelSelectionResult,
  ModelSelectionModelView,
  ModelSelectionProviderView,
} from "@codez/provider";
import type { CodexModel, ModelSelection } from "@codez/shared";

/**
 * Codex 原生 Host 模型目录的纯函数域：config/read + model/list + catalog 文件映射
 * 组装成分组目录与选择解析。无 IO、无缓存——读取/缓存/失效归
 * codexModelSelectionService.ts（app 层）。
 * 多 provider 分组合同见 specs/codex-model-provider-grouping.md。
 */

/** 模型按 catalog provider 的分组（specs/codex-model-provider-grouping.md）。 */
export interface CodexModelProviderGroup {
  readonly providerId: string;
  readonly providerName: string;
  readonly models: readonly CodexModel[];
}

export interface CodexHostModelCatalog {
  readonly providerId: string;
  readonly models: readonly CodexModel[];
  /**
   * 按 catalog provider 分组的模型视图。无映射事实（未配置 model_catalog_json
   * 或目录未声明 provider）时退化为单个激活 provider 组。
   */
  readonly groups: readonly CodexModelProviderGroup[];
  /** 显式配置但不在发现目录中的模型；只是配置事实，不证明目录能力。 */
  readonly configuredSelection?: ModelSelection;
  readonly preferredSelection: ModelSelection | null;
}

export function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}

/** `model_providers.<id>.name` 作为分组展示名；缺省回退 provider id。 */
function readProviderNames(config: Record<string, unknown>): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const providers = config.model_providers;
  if (providers && typeof providers === "object") {
    for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
      const name =
        value && typeof value === "object"
          ? readNonEmptyString((value as Record<string, unknown>).name)
          : undefined;
      if (name) names.set(id, name);
    }
  }
  return names;
}

/** 与 UI `groupCodexModelsByProvider` 同一口径：映射命中归组，未命中归激活 provider。 */
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

/** 与 UI `readCodexModelCatalog` 同一口径：显式配置优先，其次目录默认模型。 */
export function buildCodexHostModelCatalog(
  config: Record<string, unknown>,
  rawModels: readonly CodexModel[],
  providerMap?: ReadonlyMap<string, string>,
): CodexHostModelCatalog {
  const providerId = readNonEmptyString(config.model_provider) ?? "openai";
  const models = rawModels.filter((model) => !model.hidden);
  const configuredModel = readNonEmptyString(config.model);
  const model = configuredModel
    ? models.find((candidate) => candidate.model === configuredModel)
    : models.find((candidate) => candidate.isDefault);
  const effort =
    readNonEmptyString(config.model_reasoning_effort) ??
    readNonEmptyString(model?.defaultReasoningEffort);
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
      providerMap ?? new Map(),
      readProviderNames(config),
    ),
    ...(configuredSelection ? { configuredSelection } : {}),
    preferredSelection:
      configuredSelection ??
      (model
        ? {
            // 根因：配置 provider 不一定拥有默认模型，首选身份必须与目录分组一致。
            providerId: providerMap?.get(model.model) ?? providerId,
            modelId: model.model,
            ...(effort ? { options: { reasoningLevel: effort } } : {}),
          }
        : null),
  };
}

/** 目录内按 (providerId, modelId) 定位；已知 provider 未命中时跨组唯一命中则治愈。 */
export function findCodexCatalogModel(
  catalog: Pick<CodexHostModelCatalog, "providerId" | "groups">,
  selection: { providerId: string; modelId: string },
): { group: CodexModelProviderGroup; model: CodexModel } | null {
  const group = catalog.groups.find((entry) => entry.providerId === selection.providerId);
  // 配置 provider 的全部模型可能已归到别组；它仍是本工作区已知身份，允许旧选择唯一匹配修正。
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

function readReasoningValues(model: CodexModel): readonly string[] {
  const values: string[] = [];
  for (const effort of model.supportedReasoningEfforts) {
    const value = effort.reasoningEffort.trim();
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * 把 Codex 模型适配成 View 候选。Codex 目录不发布 contextWindow、模态与 token 上限；
 * 这些字段只是 `ModelSelectionView` 跨进程合同的惰性占位，没有执行消费者，
 * 与 bridge `readControlModelSettings` 对未发布能力的处理一致（不宣告支持）。
 */
function toModelView(modelId: string, reasoningValues: readonly string[]): ModelSelectionModelView {
  return {
    modelId,
    config: {
      enabled: true,
      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 1,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs: {
        reasoningLevel: {
          values: reasoningValues,
          // 惰性表达式；codex 执行不编译 option map，档位由 bridge 直传 turn/start。
          map: "{}",
        },
        maxOutputTokens: { max: 1, map: "{}" },
      },
    },
  };
}

export function toProviderView(
  group: CodexModelProviderGroup,
  catalog: CodexHostModelCatalog,
): ModelSelectionProviderView {
  const modelViews = group.models.map((model) =>
    toModelView(model.model, readReasoningValues(model)),
  );
  // 显式配置但不在目录中的模型：只有配置提供了档位才进入候选（单档事实），
  // 没有档位时不能伪造 supportedReasoningEfforts，preferredSelection 仍保留配置身份。
  // 配置事实挂在激活 provider 组（configuredSelection.providerId 即配置 provider）。
  const configured = catalog.configuredSelection;
  const configuredEffort = configured?.options?.reasoningLevel;
  if (
    configured &&
    configured.providerId === group.providerId &&
    configuredEffort &&
    !modelViews.some((model) => model.modelId === configured.modelId)
  ) {
    modelViews.push(toModelView(configured.modelId, [configuredEffort]));
  }
  return {
    providerId: group.providerId,
    providerName: group.providerName,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "" },
      // 占位 endpoint：codex 执行不经过 Provider API 配置，该字段没有消费者。
      api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1/codex-native" },
    },
    models: modelViews,
  };
}

/** 与 legacy `resolveEffectiveModelSelection` 同族的 codex 解析；不 remap 账号身份。 */
export function resolveCodexEffectiveModelSelection(
  catalog: CodexHostModelCatalog,
  selection: ModelSelection,
): EffectiveModelSelectionResult {
  const configured = catalog.configuredSelection;
  if (configured && selection.modelId === configured.modelId) {
    // 配置事实足以保留选择，但不能证明目录能力；显式档位优先，否则回退配置档位。
    // 配置模型挂在激活 provider 组；provider 不匹配时按目录归属解析（若有）。
    if (
      selection.providerId === configured.providerId ||
      !findCodexCatalogModel(catalog, selection)
    ) {
      return Object.freeze({
        effectiveSelection: freezeSelection(
          selection.options?.reasoningLevel
            ? { ...selection, providerId: configured.providerId }
            : configured,
        ),
      });
    }
  }
  const located = findCodexCatalogModel(catalog, selection);
  if (!located) {
    return Object.freeze({
      effectiveSelection: null,
      selectionIssue:
        selection.providerId === catalog.providerId ||
        catalog.groups.some((group) => group.providerId === selection.providerId)
          ? "model-not-found"
          : "provider-not-found",
    });
  }
  const { group, model } = located;
  const values = readReasoningValues(model);
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel === undefined) {
    const fallback = readNonEmptyString(model.defaultReasoningEffort);
    if (!fallback || !values.includes(fallback)) {
      return Object.freeze({
        effectiveSelection: Object.freeze({
          providerId: group.providerId,
          modelId: model.model,
        }),
        selectionIssue: "reasoning-level-missing",
      });
    }
    // 与 UI `resolveCodexSelection` 一致：缺档位时补目录默认档，不阻断提交。
    return Object.freeze({
      effectiveSelection: Object.freeze({
        providerId: group.providerId,
        modelId: model.model,
        options: Object.freeze({ reasoningLevel: fallback }),
      }),
    });
  }
  if (!values.includes(reasoningLevel)) {
    return Object.freeze({
      effectiveSelection: Object.freeze({
        providerId: group.providerId,
        modelId: model.model,
      }),
      selectionIssue: "reasoning-level-not-supported",
    });
  }
  return Object.freeze({
    effectiveSelection: freezeSelection(
      group.providerId === selection.providerId
        ? selection
        : { ...selection, providerId: group.providerId },
    ),
  });
}
