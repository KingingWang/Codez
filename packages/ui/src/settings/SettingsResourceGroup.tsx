import type { ReactNode } from "react";

/** 纯展示分栏；不引入 legacy 供应商目录、鉴权或图片资产。 */
export function ModelProviderSplitPanel({
  navigation,
  children,
}: {
  navigation: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-clip rounded-xl border border-border bg-card">
      <div
        className="grid min-h-[36rem] grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]"
        data-model-provider-split-panel="true"
      >
        <div
          className="min-w-0 border-r border-border"
          data-model-provider-navigation-scroll="true"
        >
          {navigation}
        </div>
        <div
          className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
          data-model-provider-detail-scroll="true"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function SettingsResourceGroupHeader({
  actions,
  count,
  title,
}: {
  actions?: ReactNode;
  count: number;
  title: string;
}) {
  const heading = (
    <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
      {title}
      <span className="text-ui-sm font-normal text-foreground-subtle">{count}</span>
    </h3>
  );
  return actions ? (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {heading}
      {actions}
    </div>
  ) : (
    heading
  );
}

export function SettingsResourceList<T>({
  getKey,
  items,
  renderItem,
}: {
  getKey: (item: T) => string;
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl bg-surface">
      {items.map((item, index) => (
        <div key={getKey(item)}>
          {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
          {renderItem(item)}
        </div>
      ))}
    </div>
  );
}
