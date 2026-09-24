import type {
  EffectiveModelSelectionResult,
  ModelSelectionModelView,
  ModelSelectionProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@codez/provider";
import type { IDisposable } from "@codez/rpc";
import {
  codexConfigResponseSchema,
  codexModelsResponseSchema,
  type CodexModel,
  type CodexRequest,
  type ModelSelection,
} from "@codez/shared";
import type { IModelSelectionService } from "./providerFacadeServices.js";

/**
 * Codex 原生 Host 的模型选择视图。
 *
 * 背景：codex bridge 模式下账号、配置与模型目录由 Codex 持有（`config/read` +
 * `model/list`），legacy Provider Registry（Z.ai 内建）不启动、无可选模型。
 * 本服务把 Codex 原生目录适配成 `ModelSelectionView`，让 Bot、Automation 与
 * 移动 Web 等既有 `IModelSelectionService` 消费方在 codex 模式下解析同一事实。
 *
 * 边界：执行事实源不变——bridge 以 `providerId/modelId/reasoningLevel` 直传
 * `turn/start`，从不读取本 View 的 config 占位字段；唯一真实数据是
 * `reasoningLevel.values`（来自 `supportedReasoningEfforts`）。
 */

export interface CodexModelSelectionWorkspaceTarget {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

export type CodexModelSelectionRequestSender = (
  params: CodexModelSelectionWorkspaceTarget & { request: CodexRequest },
) => Promise<unknown>;

export interface CodexHostModelCatalog {
  readonly providerId: string;
  readonly models: readonly CodexModel[];
  /** 显式配置但不在发现目录中的模型；只是配置事实，不证明目录能力。 */
  readonly configuredSelection?: ModelSelection;
  readonly preferredSelection: ModelSelection | null;
}

interface CodexCatalogCacheEntry {
  readonly fingerprint: string;
  readonly catalog: CodexHostModelCatalog;
  expiresAt: number;
}

const CATALOG_CACHE_TTL_MS = 5_000;
const MAX_MODEL_LIST_PAGES = 100;
const EMPTY_VIEW: ModelSelectionView = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
});

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function freezeSelection(selection: ModelSelection): ModelSelection {
  return Object.freeze({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: Object.freeze({ ...selection.options }) } : {}),
  });
}

function resolveWorkspaceKey(target: CodexModelSelectionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

/** 与 UI `readCodexModelCatalog` 同一口径：显式配置优先，其次目录默认模型。 */
export function buildCodexHostModelCatalog(
  config: Record<string, unknown>,
  rawModels: readonly CodexModel[],
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
    ...(configuredSelection ? { configuredSelection } : {}),
    preferredSelection:
      configuredSelection ??
      (model
        ? {
            providerId,
            modelId: model.model,
            ...(effort ? { options: { reasoningLevel: effort } } : {}),
          }
        : null),
  };
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

function toProviderView(catalog: CodexHostModelCatalog): ModelSelectionProviderView {
  const modelViews = catalog.models.map((model) =>
    toModelView(model.model, readReasoningValues(model)),
  );
  // 显式配置但不在目录中的模型：只有配置提供了档位才进入候选（单档事实），
  // 没有档位时不能伪造 supportedReasoningEfforts，preferredSelection 仍保留配置身份。
  const configured = catalog.configuredSelection;
  const configuredEffort = configured?.options?.reasoningLevel;
  if (
    configured &&
    configuredEffort &&
    !modelViews.some((model) => model.modelId === configured.modelId)
  ) {
    modelViews.push(toModelView(configured.modelId, [configuredEffort]));
  }
  return {
    providerId: catalog.providerId,
    providerName: catalog.providerId,
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
  if (selection.providerId !== catalog.providerId) {
    return Object.freeze({ effectiveSelection: null, selectionIssue: "provider-not-found" });
  }
  const configured = catalog.configuredSelection;
  if (configured && selection.modelId === configured.modelId) {
    // 配置事实足以保留选择，但不能证明目录能力；显式档位优先，否则回退配置档位。
    return Object.freeze({
      effectiveSelection: freezeSelection(
        selection.options?.reasoningLevel ? selection : configured,
      ),
    });
  }
  const model = catalog.models.find((candidate) => candidate.model === selection.modelId);
  if (!model) {
    return Object.freeze({ effectiveSelection: null, selectionIssue: "model-not-found" });
  }
  const values = readReasoningValues(model);
  const reasoningLevel = selection.options?.reasoningLevel;
  if (reasoningLevel === undefined) {
    const fallback = readNonEmptyString(model.defaultReasoningEffort);
    if (!fallback || !values.includes(fallback)) {
      return Object.freeze({
        effectiveSelection: Object.freeze({
          providerId: catalog.providerId,
          modelId: model.model,
        }),
        selectionIssue: "reasoning-level-missing",
      });
    }
    // 与 UI `resolveCodexSelection` 一致：缺档位时补目录默认档，不阻断提交。
    return Object.freeze({
      effectiveSelection: Object.freeze({
        providerId: catalog.providerId,
        modelId: model.model,
        options: Object.freeze({ reasoningLevel: fallback }),
      }),
    });
  }
  if (!values.includes(reasoningLevel)) {
    return Object.freeze({
      effectiveSelection: Object.freeze({
        providerId: catalog.providerId,
        modelId: model.model,
      }),
      selectionIssue: "reasoning-level-not-supported",
    });
  }
  return Object.freeze({ effectiveSelection: freezeSelection(selection) });
}

export interface CodexModelSelectionService extends IModelSelectionService {
  dispose(): void;
}

export interface CodexModelSelectionServiceOptions {
  readonly send: CodexModelSelectionRequestSender;
  readonly now?: () => number;
}

export function createCodexModelSelectionService(
  options: CodexModelSelectionServiceOptions,
): CodexModelSelectionService {
  const now = options.now ?? Date.now;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const revisionsByWorkspace = new Map<string, { revision: number; fingerprint: string }>();
  const cacheByWorkspace = new Map<string, CodexCatalogCacheEntry>();
  // 同一 workspace 的并发刷新合并为一次在途读取；后到者共享结果，
  // 乱序完成时不会让旧配置覆盖新配置再留下更高 revision。
  const inflightByWorkspace = new Map<
    string,
    Promise<{ catalog: CodexHostModelCatalog; fingerprint: string }>
  >();
  let disposed = false;

  async function readCatalog(
    target: CodexModelSelectionWorkspaceTarget,
  ): Promise<CodexHostModelCatalog> {
    const rawConfig = await options.send({
      ...target,
      request: {
        method: "config/read",
        params: { cwd: target.workspacePath, includeLayers: false },
      },
    });
    const { config } = codexConfigResponseSchema.parse(rawConfig);
    const catalog = codexModelsResponseSchema.parse(
      await options.send({
        ...target,
        request: { method: "model/list", params: { includeHidden: false } },
      }),
    );
    const cursors = new Set<string>();
    while (catalog.nextCursor) {
      const cursor = catalog.nextCursor;
      if (cursors.has(cursor) || cursors.size >= MAX_MODEL_LIST_PAGES) {
        throw new Error("Invalid Codex model pagination cursor");
      }
      cursors.add(cursor);
      const page = codexModelsResponseSchema.parse(
        await options.send({
          ...target,
          request: { method: "model/list", params: { includeHidden: false, cursor } },
        }),
      );
      catalog.data.push(...page.data);
      catalog.nextCursor = page.nextCursor;
    }
    return buildCodexHostModelCatalog(config, catalog.data);
  }

  async function readCatalogCoalesced(
    target: CodexModelSelectionWorkspaceTarget,
  ): Promise<{ catalog: CodexHostModelCatalog; fingerprint: string }> {
    const workspaceKey = resolveWorkspaceKey(target);
    const cached = cacheByWorkspace.get(workspaceKey);
    if (cached && cached.expiresAt > now()) {
      return { catalog: cached.catalog, fingerprint: cached.fingerprint };
    }
    let inflight = inflightByWorkspace.get(workspaceKey);
    if (!inflight) {
      inflight = readCatalog(target)
        .then((catalog) => {
          const fingerprint = JSON.stringify(catalog);
          cacheByWorkspace.set(workspaceKey, {
            fingerprint,
            catalog,
            expiresAt: now() + CATALOG_CACHE_TTL_MS,
          });
          return { catalog, fingerprint };
        })
        .finally(() => {
          inflightByWorkspace.delete(workspaceKey);
        });
      inflightByWorkspace.set(workspaceKey, inflight);
    }
    return inflight;
  }

  async function readCatalogCached(target: CodexModelSelectionWorkspaceTarget): Promise<{
    catalog: CodexHostModelCatalog;
    revision: number;
    changed: boolean;
  }> {
    const workspaceKey = resolveWorkspaceKey(target);
    const { catalog, fingerprint } = await readCatalogCoalesced(target);
    const state = revisionsByWorkspace.get(workspaceKey);
    const revision = state
      ? state.fingerprint === fingerprint
        ? state.revision
        : state.revision + 1
      : 1;
    // 首次读取不算变化：订阅者通过初始 getView 获得事实，onDidChange 只表示后续变化。
    const changed = state !== undefined && state.fingerprint !== fingerprint;
    revisionsByWorkspace.set(workspaceKey, { revision, fingerprint });
    return { catalog, revision, changed };
  }

  return {
    onDidChange(listener: (view: ModelSelectionView) => void): IDisposable {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    async getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView> {
      if (disposed) throw new Error("CodexModelSelectionService 已 dispose");
      const workspace = input?.workspace;
      // Codex 模型事实是 per-workspace 的；无目标 workspace 的读取（旧 UI 调用点）
      // 返回空视图，与 codex 模式 legacy 空 Registry 的行为一致。
      if (!workspace) return EMPTY_VIEW;
      const { catalog, revision, changed } = await readCatalogCached(workspace);
      const providers =
        catalog.models.length > 0 || catalog.configuredSelection
          ? Object.freeze([toProviderView(catalog)])
          : Object.freeze([]);
      const view: ModelSelectionView = Object.freeze({
        revision,
        providers,
        // 事件/视图必须携带来源 workspace：revision 是 per-workspace 的，
        // 消费者在比较 revision 之前先按身份过滤跨 workspace 事件。
        workspace: Object.freeze({
          workspacePath: workspace.workspacePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
        }),
        ...(catalog.preferredSelection
          ? { preferredSelection: freezeSelection(catalog.preferredSelection) }
          : {}),
        ...(input?.selection ? resolveCodexEffectiveModelSelection(catalog, input.selection) : {}),
      });
      if (changed) {
        for (const listener of listeners) listener(view);
      }
      return view;
    },
    dispose(): void {
      disposed = true;
      listeners.clear();
      revisionsByWorkspace.clear();
      cacheByWorkspace.clear();
      inflightByWorkspace.clear();
    },
  };
}
