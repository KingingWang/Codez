import { ArrowRight, Check, CircleStop, Info } from "lucide-react";
import type { DataSyncBlockedReason } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { useCodezIntl } from "@/i18n/IntlProvider.js";
import { DATA_SYNC_STOPPED_ERROR } from "@/data-sync/app/marketplacePluginSync.js";
import {
  DATA_SYNC_OFFLINE_ERROR,
  DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR,
  type DataSyncCategoryView,
  type DataSyncItemError,
} from "@/data-sync/app/useDataSyncDialog.js";
import {
  findMissingDataSyncDependencies,
  resolveDataSyncCheckState,
  type DataSyncDependencyKeys,
  type DataSyncMissingDependencies,
  type DataSyncRow,
  type DataSyncRowStatus,
} from "@/data-sync/domain/compare.js";

/**
 * 分类条目表（弹窗右栏）：全选、逐行勾选、行内状态与错误、可「停止」的 marketplace 插件行。
 * 从 DataSyncDialog 拆出，弹窗壳只保留导航、概览与底栏（oxlint max-lines）。
 */
export type DataSyncFormatMessage = ReturnType<typeof useCodezIntl>["intl"]["formatMessage"];

const BLOCKED_REASON_MESSAGE_ID: Record<DataSyncBlockedReason, string> = {
  "size-limit": "remoteSync.blocked.sizeLimit",
  "contains-symlink": "remoteSync.blocked.containsSymlink",
  "target-symlink": "remoteSync.blocked.targetSymlink",
  "compat-directory": "remoteSync.blocked.compatDirectory",
  "external-directory": "remoteSync.blocked.externalDirectory",
  "target-compat-config": "remoteSync.blocked.targetCompatConfig",
  "source-removed": "remoteSync.blocked.sourceRemoved",
  "remote-latest-mismatch": "remoteSync.blocked.remoteLatestMismatch",
  "cross-marketplace-dependency": "remoteSync.blocked.crossMarketplaceDependency",
  "unsupported-source": "remoteSync.blocked.unsupportedSource",
};

// 标签颜色遵循 DESIGN.md 的 *-surface 语义对；「更新」用蓝色的 progress surface，
// 它在四套主题下都保证 4.5:1 对比度（设计稿的 blue-500/15 依赖系统深色媒体查询，切换应用主题时不跟随）。
const BADGE_CLASS: Record<Exclude<DataSyncRowStatus, "blocked">, string> = {
  push: "bg-success-surface text-success-surface-foreground",
  update: "bg-progress-surface text-progress-surface-foreground",
  difference: "bg-warning-surface text-warning-surface-foreground",
  synced: "bg-surface text-foreground-subtle",
};

function formatPushError(formatMessage: DataSyncFormatMessage, error: string): string {
  if (error === DATA_SYNC_OFFLINE_ERROR) {
    return formatMessage({ id: "remoteSync.error.offline" });
  }
  if (error === DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR) {
    return formatMessage({ id: "remoteSync.error.preflightTimeout" });
  }
  return formatMessage({ id: "remoteSync.error.pushFailed" }, { error });
}

function formatItemError(formatMessage: DataSyncFormatMessage, error: DataSyncItemError): string {
  if (error.message === DATA_SYNC_STOPPED_ERROR) {
    return formatMessage({ id: "remoteSync.item.stopped" });
  }
  return error.status === "conflict"
    ? formatMessage({ id: "remoteSync.item.conflict" })
    : formatMessage(
        { id: "remoteSync.item.failed" },
        { error: error.message ?? formatMessage({ id: "remoteSync.item.unknownError" }) },
      );
}

/** 多个缺失项合并为一行：同类名称之间、MCP 与技能两组之间各用本地化分隔符。 */
function formatMissingDependencies(
  formatMessage: DataSyncFormatMessage,
  missing: DataSyncMissingDependencies,
): string {
  const nameSeparator = formatMessage({ id: "remoteSync.dependency.nameSeparator" });
  const groups: string[] = [];
  if (missing.mcpServers.length > 0) {
    groups.push(
      formatMessage(
        { id: "remoteSync.dependency.missingMcp" },
        { names: missing.mcpServers.join(nameSeparator) },
      ),
    );
  }
  if (missing.skills.length > 0) {
    groups.push(
      formatMessage(
        { id: "remoteSync.dependency.missingSkills" },
        { names: missing.skills.join(nameSeparator) },
      ),
    );
  }
  return groups.join(formatMessage({ id: "remoteSync.dependency.groupSeparator" }));
}

/** 依赖提示的两端列表：只用已就绪分类的最近一次加载结果，推送后刷新完成即随之更新。 */
export function readyDependencyKeys(
  view: DataSyncCategoryView | undefined,
): DataSyncDependencyKeys | undefined {
  return view?.phase === "ready" ? { source: view.sourceKeys, target: view.targetKeys } : undefined;
}

function SelectionBox(props: { checked: boolean; disabled?: boolean }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border",
          props.checked
            ? "border-primary bg-primary text-primary-foreground"
            : props.disabled
              ? "border-border/50 bg-surface text-transparent"
              : "border-border bg-background text-transparent",
        )}
      >
        <Check className="size-3.5" aria-hidden="true" />
      </span>
    </span>
  );
}

/** 分类还没有视图（后端事实未落定、设备离线或刚换代）时的占位，保持与列表加载态同样的口径。 */
export function CategoryPendingPanel(props: { formatMessage: DataSyncFormatMessage }) {
  return (
    <div
      data-testid="remote-sync-resource-panel"
      className="flex h-full min-h-0 items-center justify-center rounded-xl border border-border bg-background/50"
    >
      <p className="text-ui-sm text-foreground-subtle">
        {props.formatMessage({ id: "remoteSync.overview.loading" })}
      </p>
    </div>
  );
}

function RowNote(props: { row: DataSyncRow; formatMessage: DataSyncFormatMessage }) {
  const { note } = props.row;
  if (note.kind === "version") {
    return (
      <span className="flex items-center gap-1 font-mono text-ui-xs text-foreground">
        <span>{note.from}</span>
        <ArrowRight className="size-3 text-foreground-subtle" aria-hidden="true" />
        <span>{note.to}</span>
      </span>
    );
  }
  if (note.kind === "sourceOlder" || note.kind === "contentDiffers") {
    return (
      <span className="text-ui-xs text-foreground">
        {props.formatMessage({
          id:
            note.kind === "sourceOlder"
              ? "remoteSync.version.pushSourceOlder"
              : "remoteSync.version.contentDiffers",
        })}
      </span>
    );
  }
  return null;
}

export function CategoryPanel(props: {
  view: DataSyncCategoryView;
  dependencyTargets: Parameters<typeof findMissingDataSyncDependencies>[1];
  disabled: boolean;
  formatMessage: DataSyncFormatMessage;
  onSelectionChange(keys: Iterable<string>): void;
  onStop(key: string): void;
}) {
  const { view, formatMessage } = props;
  const selectableKeys = view.rows.filter((row) => row.selectable).map((row) => row.key);
  const allSelected = resolveDataSyncCheckState(view.rows, view.selected) === true;
  return (
    <div
      data-testid="remote-sync-resource-panel"
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
    >
      {view.pushError ? (
        <div
          data-testid="remote-sync-push-error"
          className="flex shrink-0 items-start gap-2 rounded-xl bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {formatPushError(formatMessage, view.pushError)}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background/50">
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface/50 px-5 py-3">
          <button
            data-testid="remote-sync-select-all"
            type="button"
            role="checkbox"
            aria-checked={allSelected}
            disabled={props.disabled || selectableKeys.length === 0}
            onClick={() => props.onSelectionChange(allSelected ? [] : selectableKeys)}
            className="flex items-center gap-3 text-ui-base text-foreground-subtle hover:text-foreground disabled:opacity-60"
          >
            <SelectionBox checked={allSelected} />
            {formatMessage({ id: "remoteSync.selection.selectAll" })}
          </button>
        </div>
        <div
          data-testid="remote-sync-resource-list"
          className="flex min-h-0 flex-col gap-1 overflow-y-auto p-2"
        >
          {view.phase === "loading" ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {formatMessage({ id: "remoteSync.overview.loading" })}
            </p>
          ) : view.phase === "error" ? (
            <p className="px-3 py-6 text-center text-ui-sm text-destructive">
              {formatMessage({ id: "remoteSync.category.loadFailed" }, { error: view.error ?? "" })}
            </p>
          ) : view.rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {formatMessage({ id: "remoteSync.category.empty" })}
            </p>
          ) : (
            view.rows.map((row) => {
              const checked = view.selected.has(row.key);
              const rowDisabled = props.disabled || !row.selectable;
              const itemError = view.itemErrors[row.key];
              const missingDependencies = findMissingDataSyncDependencies(
                row.dependencies,
                props.dependencyTargets,
              );
              const stoppable = view.push === "pushing" && view.stoppable.has(row.key);
              const rowButton = (
                <button
                  key={row.key}
                  type="button"
                  role="checkbox"
                  data-testid={`remote-sync-row-${row.key}`}
                  data-sync-key={row.key}
                  data-sync-status={row.status}
                  aria-label={row.name}
                  aria-checked={checked}
                  disabled={rowDisabled}
                  onClick={() => {
                    const next = new Set(view.selected);
                    if (checked) next.delete(row.key);
                    else next.add(row.key);
                    props.onSelectionChange(next);
                  }}
                  className="flex w-full cursor-pointer gap-3 rounded-lg bg-background p-3 text-left transition-colors hover:bg-surface-hover/50 disabled:cursor-default disabled:hover:bg-background"
                >
                  <SelectionBox checked={checked} disabled={!row.selectable} />
                  <span className={cn("min-w-0 flex-1", !row.selectable && "opacity-60")}>
                    <span className="block truncate text-ui-base font-medium text-foreground">
                      {row.name}
                    </span>
                    {/* 说明行不截断：钩子在这里显示完整命令，长路径需要折行。 */}
                    <span className="mt-0.5 block break-words text-ui-sm text-foreground-subtle">
                      {row.note.kind === "blocked"
                        ? formatMessage({ id: BLOCKED_REASON_MESSAGE_ID[row.note.reason] })
                        : (row.description ?? "")}
                    </span>
                    {missingDependencies ? (
                      <span
                        data-testid={`remote-sync-row-hint-${row.key}`}
                        className="mt-0.5 block text-ui-sm text-warning-surface-foreground"
                      >
                        {formatMissingDependencies(formatMessage, missingDependencies)}
                      </span>
                    ) : null}
                    {itemError ? (
                      <span
                        data-testid={`remote-sync-row-error-${row.key}`}
                        className="mt-0.5 block text-ui-sm text-destructive"
                      >
                        {formatItemError(formatMessage, itemError)}
                      </span>
                    ) : null}
                  </span>
                  <span
                    data-testid={`remote-sync-difference-${row.key}`}
                    className="mt-0.5 flex shrink-0 items-center gap-2 self-start"
                  >
                    <RowNote row={row} formatMessage={formatMessage} />
                    {row.status !== "blocked" ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
                          BADGE_CLASS[row.status],
                        )}
                      >
                        {formatMessage({ id: `remoteSync.operation.${row.status}` })}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
              if (!stoppable) return rowButton;
              // 远端 add / install 期间该行可单独「停止」；按钮放在行外，避免嵌套在行按钮里。
              return (
                <div key={row.key} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">{rowButton}</div>
                  <Button
                    type="button"
                    data-testid={`remote-sync-row-stop-${row.key}`}
                    variant="secondary"
                    size="sm"
                    className="mr-2 shrink-0"
                    onClick={() => props.onStop(row.key)}
                  >
                    <CircleStop aria-hidden="true" />
                    {formatMessage({ id: "remoteSync.action.stop" })}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
