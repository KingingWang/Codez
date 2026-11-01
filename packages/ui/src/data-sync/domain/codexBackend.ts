import type { DataSyncCategoryId } from "@/data-sync/contract.js";

/**
 * 一端 Host 的 Agent 运行时事实，来自该端 `systemService.info().agentRuntimeMode`。
 * `pending` 表示还没读到（attachment 未就绪、查询中）；按规则它与 legacy 一样不产生任何标注，
 * 见 specs/data-sync-codex-backend.md「产品规则」第 4 条。
 */
export type DataSyncRuntimeMode = "codex" | "legacy" | "pending";

/**
 * 分类在 Codex 后端下的生效面。逐类别的路径核对结论（证据行号见
 * specs/data-sync-codex-backend.md「逐类别核对结论」）：
 *
 * - `none`：该分类只写 Codez 自有存储（`~/.codez/**`），Codex 读的是另一套
 *   （`$CODEX_HOME/config.toml`、`$CODEX_HOME/agents`、`$CODEX_HOME/hooks.json`、
 *   `$CODEX_HOME/skills`）。推送会返回成功，但对 Codex 会话完全无效。
 * - `partial`：插件分类由 inline（文件型，写 `~/.codez/plugins` + `plugins.dirs`，Codex 不读）
 *   与 marketplace（经 `IPluginManagementService` → Agent → bridge `plugins/install`，
 *   落到 Codex 原生插件状态）组合而成，只有 marketplace 行真正生效。
 */
export type DataSyncCodexCategoryEffect = "none" | "partial";

export const DATA_SYNC_CODEX_CATEGORY_EFFECT: Readonly<
  Record<DataSyncCategoryId, DataSyncCodexCategoryEffect>
> = {
  subagents: "none",
  mcp: "none",
  skills: "none",
  commands: "none",
  hooks: "none",
  plugins: "partial",
};

/** 导航与概览行上的分类标记；null 表示不显示（两端都不是 Codex）。 */
export type DataSyncCodexCategoryBadge = "blocked" | "partial";

export interface DataSyncCodexAvailability {
  /** 本机跑 Codex：列表里的「本机」条目只来自 Codez 自有存储，需要口径提示，但不禁用推送。 */
  sourceNotice: boolean;
  /** 设备跑 Codex：数据落地端读的是 Codex 自己的配置，需要说明哪些分类不会生效。 */
  targetNotice: boolean;
  /** 设备跑 Codex 时整类不可同步的分类（不加载、不可勾选、不进推送）。 */
  blocked: ReadonlySet<DataSyncCategoryId>;
  /** 设备跑 Codex 时只有一部分行生效的分类。 */
  partial: ReadonlySet<DataSyncCategoryId>;
  /** 插件分类是否包含 inline（本地目录）插件行；设备跑 Codex 时排除。 */
  inlinePlugins: boolean;
}

const EMPTY_IDS: ReadonlySet<DataSyncCategoryId> = new Set();

/**
 * 两端运行时事实 → 分类可用性。纯函数：不读服务、不缓存，判定事实的唯一来源是
 * `app/useDataSyncRuntimeModes.ts`（它复用 UI 既有的 `resolveRootProviderStartupMode`）。
 */
export function resolveDataSyncCodexAvailability(params: {
  sourceMode: DataSyncRuntimeMode;
  targetMode: DataSyncRuntimeMode;
}): DataSyncCodexAvailability {
  const sourceNotice = params.sourceMode === "codex";
  const targetCodex = params.targetMode === "codex";
  if (!targetCodex) {
    return {
      sourceNotice,
      targetNotice: false,
      blocked: EMPTY_IDS,
      partial: EMPTY_IDS,
      inlinePlugins: true,
    };
  }
  const blocked = new Set<DataSyncCategoryId>();
  const partial = new Set<DataSyncCategoryId>();
  for (const [id, effect] of Object.entries(DATA_SYNC_CODEX_CATEGORY_EFFECT) as Array<
    [DataSyncCategoryId, DataSyncCodexCategoryEffect]
  >) {
    if (effect === "none") blocked.add(id);
    else partial.add(id);
  }
  return { sourceNotice, targetNotice: true, blocked, partial, inlinePlugins: false };
}

export function resolveDataSyncCategoryBadge(
  availability: DataSyncCodexAvailability,
  id: DataSyncCategoryId,
): DataSyncCodexCategoryBadge | null {
  if (availability.blocked.has(id)) return "blocked";
  if (availability.partial.has(id)) return "partial";
  return null;
}
