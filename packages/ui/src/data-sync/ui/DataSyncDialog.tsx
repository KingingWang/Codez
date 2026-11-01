import { useMemo, useState } from "react";
import { Check, ChevronRight, CloudOff, Package, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  DATA_SYNC_CATEGORIES,
  DATA_SYNC_OVERVIEW_ICON,
  selectDataSyncCategories,
  type DataSyncCategoryAdapter,
} from "@/data-sync/app/categories.js";
import type { DataSyncCategoryId, DataSyncDialogProps } from "@/data-sync/contract.js";
import { createPluginSyncResultReporter } from "@/data-sync/app/marketplacePluginSync.js";
import { useDataSyncRuntimeModes } from "@/data-sync/app/useDataSyncRuntimeModes.js";
import {
  resolveDataSyncCategoryBadge,
  resolveDataSyncCodexAvailability,
  type DataSyncCodexAvailability,
} from "@/data-sync/domain/codexBackend.js";
import {
  DataSyncCodexBanners,
  DataSyncCodexBlockedPanel,
  DataSyncCodexCategoryBadge,
  DataSyncCodexPartialNotice,
} from "@/data-sync/ui/DataSyncCodexNotices.js";
import { resolveDataSyncCheckState } from "@/data-sync/domain/compare.js";
import { useDataSyncProviders } from "@/data-sync/app/useDataSyncProviders.js";
import {
  DataSyncProvidersOverviewRow,
  DataSyncProvidersPanel,
} from "@/data-sync/ui/DataSyncProvidersPanel.js";
import {
  CategoryPanel,
  CategoryPendingPanel,
  readyDependencyKeys,
  type DataSyncFormatMessage,
} from "@/data-sync/ui/DataSyncCategoryPanel.js";
import { useDataSyncDialog, type DataSyncCategoryView } from "@/data-sync/app/useDataSyncDialog.js";

// 模型提供商是只读分类，不是 IDataSyncCategoryService：不参与勾选与「推送全部」，单独渲染。
type ActiveTab = "overview" | "providers" | DataSyncCategoryId;
type FormatMessage = DataSyncFormatMessage;

export function DataSyncDialog(props: DataSyncDialogProps) {
  const { intl } = useCodezIntl();
  const [activeTab, setActiveTab] = useState<ActiveTab>(props.initialCategory ?? "overview");
  const platform = useOptionalPlatform();
  const remoteKind = props.device.remoteKind;
  const reportPluginSyncResult = useMemo(
    () => (platform ? createPluginSyncResultReporter(platform, remoteKind) : undefined),
    [platform, remoteKind],
  );
  // Codex 原生后端下的诚实标注（specs/data-sync-codex-backend.md）：两端各读一次自己的
  // systemService.info().agentRuntimeMode，判定只有 useDataSyncRuntimeModes 一个 owner。
  const runtimeModes = useDataSyncRuntimeModes({
    sourceServices: props.sourceServices,
    targetServices: props.targetServices,
    online: props.online,
  });
  const codex = useMemo(
    () =>
      resolveDataSyncCodexAvailability({
        sourceMode: runtimeModes.source,
        targetMode: runtimeModes.target,
      }),
    [runtimeModes],
  );
  /**
   * 后端事实落定前不加载任何分类：设备跑 Codex 时，子智能体 / MCP / 技能 / 命令 / 钩子整类不生效，
   * 提前加载既浪费两端 list / 哈希 RPC，也会让子智能体 list 顺带触发一次 Codez 存储迁移写入。
   * 事实读不到（离线、旧 Host、查询失败）时按 legacy 处理，全部分类照常同步。
   */
  const categories = useMemo(
    () => (runtimeModes.target === "pending" ? [] : selectDataSyncCategories(codex)),
    [codex, runtimeModes.target],
  );
  const state = useDataSyncDialog({
    categories,
    sourceServerId: props.device.sourceServerId,
    sourceServices: props.sourceServices,
    targetServices: props.targetServices,
    online: props.online,
    workspaceHistory: props.workspaceHistory,
    workspaceTabs: props.workspaceTabs,
    workspace: props.workspace,
    onPushFinished: props.onPushFinished,
    reportPluginSyncResult,
  });
  const providers = useDataSyncProviders({
    sourceServices: props.sourceServices,
    sourceServerId: props.device.sourceServerId,
    online: props.online,
  });
  const activeCategory = DATA_SYNC_CATEGORIES.find((category) => category.id === activeTab);
  const activeView = activeCategory ? state.views[activeCategory.id] : undefined;
  const activeBadge = activeCategory
    ? resolveDataSyncCategoryBadge(codex, activeCategory.id)
    : null;
  const disabled = !state.connected || state.pushing;
  const offline = !props.online;
  // 推送中禁止关闭弹窗；没有全局取消，结果完整返回后才能关闭。
  const blockClose = (event: Event) => {
    if (state.pushing) event.preventDefault();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && state.pushing) return;
        props.onOpenChange(open);
      }}
    >
      <DialogContent
        data-testid="remote-sync-dialog"
        className="h-[calc(100vh-6rem)] max-h-168 max-w-4xl overflow-hidden rounded-2xl p-0 max-md:h-[calc(100dvh-2rem)] max-md:max-h-[calc(100dvh-2rem)]"
        showCloseButton={!state.pushing}
        onEscapeKeyDown={blockClose}
        onInteractOutside={blockClose}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{intl.formatMessage({ id: "remoteSync.dialog.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "remoteSync.overview.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
          <aside className="flex shrink-0 flex-col gap-2 p-1 md:w-56">
            <div
              data-testid="remote-sync-sidebar-frame"
              className="flex flex-col gap-3 border-border bg-surface p-3 max-md:border-b md:h-full md:gap-4 md:rounded-xl md:border md:p-4"
            >
              <div className="hidden text-ui-base font-medium uppercase tracking-wide text-foreground-subtle md:block">
                {intl.formatMessage({ id: "remoteSync.dialog.categories" })}
              </div>
              {/* 窄窗口下分类变为顶部横向滚动标签。 */}
              <nav
                className="flex gap-2 overflow-x-auto md:flex-col"
                aria-label={intl.formatMessage({ id: "remoteSync.dialog.categories" })}
              >
                {[
                  { id: "overview" as const, icon: DATA_SYNC_OVERVIEW_ICON },
                  { id: "providers" as const, icon: Package },
                  ...DATA_SYNC_CATEGORIES,
                ].map((item) => {
                  const Icon = item.icon;
                  // 导航始终列出全部分类：被屏蔽的分类点进去是解释，不是静默消失。
                  const categoryId =
                    item.id === "overview" || item.id === "providers" ? null : item.id;
                  const badge = categoryId ? resolveDataSyncCategoryBadge(codex, categoryId) : null;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`remote-sync-tab-${item.id}`}
                      aria-current={activeTab === item.id ? "page" : undefined}
                      onClick={() => setActiveTab(item.id)}
                      className={cn(
                        "flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-ui-base font-medium transition-colors md:w-full",
                        activeTab === item.id
                          ? "bg-card text-foreground"
                          : "text-foreground-subtle hover:bg-background-alt hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      {intl.formatMessage({ id: `remoteSync.category.${item.id}` })}
                      {badge && categoryId ? (
                        <DataSyncCodexCategoryBadge
                          badge={badge}
                          category={categoryId}
                          scope="nav"
                          formatMessage={intl.formatMessage}
                          className="md:ml-auto"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </nav>
            </div>
          </aside>
          <section
            data-testid="remote-sync-dialog-main"
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden p-4 md:p-6"
          >
            <div className="shrink-0 pr-8">
              <h3 className="text-ui-lg font-medium text-foreground">
                {intl.formatMessage({ id: `remoteSync.category.${activeTab}` })}
              </h3>
              <div
                data-testid="remote-sync-dialog-device"
                className="mt-2 flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    offline ? "border border-foreground-subtlest" : "bg-success",
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">{props.device.name}</span>
                <span className="text-foreground-subtlest">·</span>
                <span className="truncate">{props.device.description}</span>
              </div>
            </div>
            {offline ? (
              <div
                data-testid="remote-sync-offline"
                className="flex shrink-0 items-start gap-2 rounded-xl border border-border px-3 py-2 text-ui-sm text-foreground-subtle"
              >
                <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {intl.formatMessage({ id: "remoteSync.dialog.offline" })}
              </div>
            ) : null}
            <DataSyncCodexBanners availability={codex} formatMessage={intl.formatMessage} />
            {activeCategory && activeBadge === "partial" ? (
              <DataSyncCodexPartialNotice
                category={activeCategory.id}
                formatMessage={intl.formatMessage}
              />
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">
              {activeTab === "providers" ? (
                <DataSyncProvidersPanel state={providers} disabled={offline} />
              ) : activeCategory && activeBadge === "blocked" ? (
                <DataSyncCodexBlockedPanel
                  category={activeCategory.id}
                  formatMessage={intl.formatMessage}
                />
              ) : activeCategory && activeView ? (
                <CategoryPanel
                  key={activeCategory.id}
                  view={activeView}
                  dependencyTargets={{
                    mcp: readyDependencyKeys(state.views.mcp),
                    skills: readyDependencyKeys(state.views.skills),
                  }}
                  disabled={disabled}
                  formatMessage={intl.formatMessage}
                  onSelectionChange={(keys) => state.setSelection(activeCategory.id, keys)}
                  onStop={(key) => state.stopItem(activeCategory.id, key)}
                />
              ) : activeCategory ? (
                // 后端事实还没落定（或设备离线）时分类没有视图：显示加载态，不回落到概览，
                // 否则导航高亮的分类与右侧内容会不一致。
                <CategoryPendingPanel formatMessage={intl.formatMessage} />
              ) : (
                <OverviewPanel
                  providers={providers}
                  views={state.views}
                  codex={codex}
                  disabled={disabled}
                  formatMessage={intl.formatMessage}
                  onNavigate={setActiveTab}
                  onSelectionChange={state.setSelection}
                />
              )}
            </div>
            <DialogFooterBar
              // 模型提供商只读；被屏蔽的分类没有可推送内容，两者都只留「关闭」。
              readOnlyTab={activeTab === "providers" || activeBadge === "blocked"}
              activeCategory={activeCategory}
              activeView={activeView}
              offline={!state.connected}
              pushing={state.pushing}
              pushAllState={state.pushAllState}
              // 只看当前真正可同步的分类：被屏蔽分类的残留视图不该让「推送全部」显得可点。
              hasOverviewSelection={categories.some(
                (category) => (state.views[category.id]?.selected.size ?? 0) > 0,
              )}
              formatMessage={intl.formatMessage}
              onClose={() => props.onOpenChange(false)}
              onClear={(id) => state.setSelection(id, [])}
              onPushCategory={state.pushCategory}
              onPushAll={state.pushAll}
            />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OverviewPanel(props: {
  providers: ReturnType<typeof useDataSyncProviders>;
  views: Readonly<Record<string, DataSyncCategoryView>>;
  codex: DataSyncCodexAvailability;
  disabled: boolean;
  formatMessage: FormatMessage;
  onNavigate(id: "providers" | DataSyncCategoryId): void;
  onSelectionChange(id: DataSyncCategoryId, keys: Iterable<string>): void;
}) {
  const { formatMessage } = props;
  return (
    <div
      data-testid="remote-sync-overview-table"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background/50"
    >
      <div className="min-h-0 overflow-y-auto p-2">
        <div className="sticky top-0 z-10 grid grid-cols-[32px_minmax(0,1fr)_64px_64px_minmax(120px,220px)] gap-4 border-b border-border bg-surface px-4 py-3 text-ui-base font-medium text-foreground-subtle">
          <span aria-hidden="true" />
          <span>{formatMessage({ id: "remoteSync.overview.column.category" })}</span>
          <span className="text-center">
            {formatMessage({ id: "remoteSync.overview.column.local" })}
          </span>
          <span className="text-center">
            {formatMessage({ id: "remoteSync.overview.column.remote" })}
          </span>
          <span aria-hidden="true" />
        </div>
        <div className="mt-1 flex flex-col gap-1">
          <DataSyncProvidersOverviewRow
            state={props.providers}
            label={formatMessage({ id: "remoteSync.category.providers" })}
            onNavigate={() => props.onNavigate("providers")}
          />
          {DATA_SYNC_CATEGORIES.map((category) => {
            const badge = resolveDataSyncCategoryBadge(props.codex, category.id);
            // 被屏蔽的分类不加载，因此可能没有视图；后端事实未落定（或设备离线）时同样没有视图。
            // 两种情况都保留行本身：用户要能看到「这一类为什么不在同步范围里」，而不是行直接消失。
            const blocked = badge === "blocked";
            const view = blocked ? undefined : props.views[category.id];
            const selectableKeys = view
              ? view.rows.filter((row) => row.selectable).map((row) => row.key)
              : [];
            const label = formatMessage({ id: `remoteSync.category.${category.id}` });
            return (
              <div
                key={category.id}
                className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-4 rounded-lg bg-background px-4 transition-colors hover:bg-surface-hover/50"
              >
                {/* 勾选框与整行跳转分开：点勾选框不进入分类页。 */}
                <Checkbox
                  data-testid={`remote-sync-overview-checkbox-${category.id}`}
                  aria-label={label}
                  checked={view ? resolveDataSyncCheckState(view.rows, view.selected) : false}
                  // 被屏蔽的分类不可勾选：目标端 Codex 读的是另一套存储，勾了也只会得到「成功但不生效」。
                  disabled={props.disabled || blocked || selectableKeys.length === 0}
                  onCheckedChange={(checked) =>
                    props.onSelectionChange(category.id, checked === true ? selectableKeys : [])
                  }
                />
                <button
                  type="button"
                  data-testid={`remote-sync-overview-${category.id}`}
                  onClick={() => props.onNavigate(category.id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_64px_64px_minmax(120px,220px)] items-center gap-4 py-3 text-left text-ui-base"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-foreground">{label}</span>
                    {badge ? (
                      <DataSyncCodexCategoryBadge
                        badge={badge}
                        category={category.id}
                        scope="overview"
                        formatMessage={formatMessage}
                      />
                    ) : null}
                  </span>
                  <span
                    data-testid={`remote-sync-overview-local-${category.id}`}
                    className="text-center tabular-nums text-foreground-subtle"
                  >
                    {view?.phase === "ready" ? view.localCount : "–"}
                  </span>
                  <span
                    data-testid={`remote-sync-overview-remote-${category.id}`}
                    className="text-center tabular-nums text-foreground-subtle"
                  >
                    {view?.phase === "ready" ? view.remoteCount : "–"}
                  </span>
                  <span className="flex min-w-0 items-center justify-end gap-2 text-foreground-subtle">
                    <span className="truncate text-right">
                      {/* 被屏蔽的分类不算差异：状态列留空，标记已经说明原因。 */}
                      {blocked
                        ? null
                        : !view || view.phase === "loading"
                          ? formatMessage({ id: "remoteSync.overview.loading" })
                          : view.phase === "error"
                            ? formatMessage({ id: "remoteSync.overview.loadFailed" })
                            : selectableKeys.length === 0 && view.localCount === view.remoteCount
                              ? formatMessage({ id: "remoteSync.difference.matching" })
                              : formatMessage(
                                  { id: "remoteSync.difference.changes" },
                                  { count: selectableKeys.length },
                                )}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DialogFooterBar(props: {
  /** 只读标签页（模型提供商）与整类不同步的分类：没有推送按钮，也不参与「推送全部」。 */
  readOnlyTab: boolean;
  activeCategory: DataSyncCategoryAdapter | undefined;
  activeView: DataSyncCategoryView | undefined;
  offline: boolean;
  pushing: boolean;
  pushAllState: "idle" | "pushing" | "done";
  hasOverviewSelection: boolean;
  formatMessage: FormatMessage;
  onClose(): void;
  onClear(id: DataSyncCategoryId): void;
  onPushCategory(id: DataSyncCategoryId): void;
  onPushAll(): void;
}) {
  const { activeCategory, activeView, formatMessage } = props;
  if (props.readOnlyTab) {
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {!props.pushing ? (
          <Button
            type="button"
            data-testid="remote-sync-close"
            variant="secondary"
            size="lg"
            onClick={props.onClose}
          >
            {formatMessage({ id: "remoteSync.action.close" })}
          </Button>
        ) : null}
      </div>
    );
  }
  if (activeCategory && activeView) {
    const selectedCount = activeView.selected.size;
    const categoryPushing = activeView.push === "pushing";
    const pushDisabled = props.offline || props.pushing || selectedCount === 0;
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-ui-base text-foreground-subtle">
          <span data-testid="remote-sync-selection-summary">
            {selectedCount === 0
              ? formatMessage({ id: "remoteSync.selection.empty" })
              : formatMessage({ id: "remoteSync.selection.summary" }, { count: selectedCount })}
          </span>
          {activeView.failedCount > 0 && !categoryPushing ? (
            <span data-testid="remote-sync-failure-summary" className="text-destructive">
              {formatMessage(
                { id: "remoteSync.selection.failed" },
                { count: activeView.failedCount },
              )}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="remote-sync-clear"
            variant="secondary"
            size="lg"
            disabled={selectedCount === 0 || props.offline || props.pushing}
            onClick={() => props.onClear(activeCategory.id)}
          >
            {formatMessage({ id: "remoteSync.action.clear" })}
          </Button>
          <Button
            type="button"
            data-testid="remote-sync-push"
            size="lg"
            disabled={pushDisabled}
            onClick={() => props.onPushCategory(activeCategory.id)}
          >
            {categoryPushing ? (
              <>
                <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                {formatMessage({ id: "remoteSync.action.transferring" })}
              </>
            ) : activeView.push !== "idle" ? (
              <>
                <Check className="size-3.5" aria-hidden="true" />
                {formatMessage({ id: "remoteSync.action.transferAgain" })}
              </>
            ) : (
              formatMessage(
                { id: "remoteSync.action.pushCategory" },
                {
                  category: formatMessage({ id: `remoteSync.category.${activeCategory.id}` }),
                },
              )
            )}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {!props.pushing ? (
        <Button
          type="button"
          data-testid="remote-sync-close"
          variant="secondary"
          size="lg"
          onClick={props.onClose}
        >
          {formatMessage({ id: "remoteSync.action.close" })}
        </Button>
      ) : null}
      <Button
        type="button"
        data-testid="remote-sync-push-all"
        size="lg"
        disabled={props.offline || props.pushing || !props.hasOverviewSelection}
        onClick={props.onPushAll}
      >
        {props.pushAllState === "pushing" ? (
          <>
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
            {formatMessage({ id: "remoteSync.action.transferringAll" })}
          </>
        ) : props.pushAllState === "done" ? (
          <>
            <Check className="size-3.5" aria-hidden="true" />
            {formatMessage({ id: "remoteSync.action.transferredAll" })}
          </>
        ) : (
          <>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {formatMessage({ id: "remoteSync.action.pushAll" })}
          </>
        )}
      </Button>
    </div>
  );
}
