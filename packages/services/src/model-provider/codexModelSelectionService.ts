import type { ModelSelectionView, ModelSelectionViewInput } from "@codez/provider";
import type { IDisposable } from "@codez/rpc";
import {
  codexConfigResponseSchema,
  codexModelsResponseSchema,
  type CodezCatalogReadResult,
  type CodexRequest,
} from "@codez/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  buildCodexHostModelCatalog,
  freezeSelection,
  resolveCodexEffectiveModelSelection,
  toProviderView,
  type CodexHostModelCatalog,
} from "./codexHostModelCatalog.js";
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


interface CodexCatalogCacheEntry {
  readonly fingerprint: string;
  readonly catalog: CodexHostModelCatalog;
  expiresAt: number;
}

const logger = createServiceLogger("codex-model-selection");

const CATALOG_CACHE_TTL_MS = 5_000;
const MAX_MODEL_LIST_PAGES = 100;
const EMPTY_VIEW: ModelSelectionView = Object.freeze({
  revision: 0,
  providers: Object.freeze([]),
});


function resolveWorkspaceKey(target: CodexModelSelectionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}




export interface CodexModelSelectionService extends IModelSelectionService {
  dispose(): void;
}

export interface CodexModelSelectionServiceOptions {
  readonly send: CodexModelSelectionRequestSender;
  /**
   * 读取 catalog 文件的 slug→provider 映射（bridge 控制面 catalog/read）。
   * 缺省或读取失败时退化为单激活 provider 组（与分组引入前一致）。
   */
  readonly readCatalogProviderMap?: (
    target: CodexModelSelectionWorkspaceTarget,
  ) => Promise<CodezCatalogReadResult>;
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

  async function readCatalogProviderMapSafe(
    target: CodexModelSelectionWorkspaceTarget,
  ): Promise<ReadonlyMap<string, string>> {
    if (!options.readCatalogProviderMap) return new Map();
    try {
      const result = await options.readCatalogProviderMap(target);
      return new Map(
        result.models
          .filter((model) => model.provider)
          .map((model) => [model.slug, model.provider as string]),
      );
    } catch (error) {
      // 目录映射是可选增强：读取失败降级为单激活 provider 组，不阻断模型列表。
      logger.warn(
        undefined,
        `read catalog provider map failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Map();
    }
  }

  async function readCatalog(
    target: CodexModelSelectionWorkspaceTarget,
  ): Promise<CodexHostModelCatalog> {
    const [rawConfig, providerMap] = await Promise.all([
      options.send({
        ...target,
        request: {
          method: "config/read",
          params: { cwd: target.workspacePath, includeLayers: false },
        },
      }),
      readCatalogProviderMapSafe(target),
    ]);
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
    return buildCodexHostModelCatalog(config, catalog.data, providerMap);
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
        catalog.groups.length > 0 || catalog.configuredSelection
          ? Object.freeze(catalog.groups.map((group) => toProviderView(group, catalog)))
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
