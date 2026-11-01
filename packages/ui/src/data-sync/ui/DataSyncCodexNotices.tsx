import { Info, TriangleAlertIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { useCodezIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import type {
  DataSyncCodexAvailability,
  DataSyncCodexCategoryBadge,
} from "@/data-sync/domain/codexBackend.js";

type FormatMessage = ReturnType<typeof useCodezIntl>["intl"]["formatMessage"];

// 标记沿用 DESIGN.md 的 *-surface 语义对：整类不同步用 warning，部分生效用中性 chip（严重度更低）。
const BADGE_CLASS: Record<DataSyncCodexCategoryBadge, string> = {
  blocked: "bg-warning-surface text-warning-surface-foreground",
  partial: "bg-surface text-foreground-subtle",
};

/** 导航与概览行上的分类标记：只在设备跑 Codex 原生后端时出现。 */
export function DataSyncCodexCategoryBadge(props: {
  badge: DataSyncCodexCategoryBadge;
  category: DataSyncCategoryId;
  formatMessage: FormatMessage;
  className?: string;
  /** 同一分类的标记会同时出现在导航与概览行，用位置区分 testid，保证 E2E 选择器唯一。 */
  scope: "nav" | "overview";
}) {
  return (
    <span
      data-testid={`remote-sync-codex-badge-${props.scope}-${props.category}`}
      data-codex-badge={props.badge}
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
        BADGE_CLASS[props.badge],
        props.className,
      )}
    >
      {props.formatMessage({ id: `remoteSync.codex.badge.${props.badge}` })}
    </span>
  );
}

/**
 * 弹窗顶部的两条说明（specs/data-sync-codex-backend.md「产品规则」）：
 * target 跑 Codex → 数据落地端读的是 Codex 自己的配置，说明哪些分类不会生效；
 * source 跑 Codex → 列表里的「本机」条目只来自 Codez 自有存储，不含 Codex 面板里的配置。
 * 两条互相独立：只有本机是 Codex 时不禁用推送（legacy 设备仍然生效）。
 */
export function DataSyncCodexBanners(props: {
  availability: DataSyncCodexAvailability;
  formatMessage: FormatMessage;
}) {
  const { availability, formatMessage } = props;
  if (!availability.targetNotice && !availability.sourceNotice) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2">
      {availability.targetNotice ? (
        <div
          data-testid="remote-sync-codex-target-banner"
          className="flex items-start gap-2 rounded-xl bg-warning-surface px-3 py-2 text-ui-sm text-warning-surface-foreground"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{formatMessage({ id: "remoteSync.codex.targetBanner" })}</span>
        </div>
      ) : null}
      {availability.sourceNotice ? (
        <div
          data-testid="remote-sync-codex-source-banner"
          className="flex items-start gap-2 rounded-xl border border-border px-3 py-2 text-ui-sm text-foreground-subtle"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{formatMessage({ id: "remoteSync.codex.sourceBanner" })}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 被屏蔽分类的替代内容：不显示条目表，只解释为什么不生效、Codex 读哪套存储、应该去哪里改。
 * 文案必须给出原因与去处，不能只说「不支持」（specs/data-sync-codex-backend.md「产品规则」第 5 条）。
 */
export function DataSyncCodexBlockedPanel(props: {
  category: DataSyncCategoryId;
  formatMessage: FormatMessage;
}) {
  const { category, formatMessage } = props;
  return (
    <div
      data-testid={`remote-sync-codex-blocked-${category}`}
      className="flex h-full min-h-0 flex-col overflow-y-auto rounded-xl border border-border bg-background/50 p-5"
    >
      <div className="flex items-start gap-2">
        <TriangleAlertIcon
          className="mt-0.5 size-4 shrink-0 text-warning-surface-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-2">
          <div className="text-ui-base font-medium text-foreground">
            {formatMessage({ id: "remoteSync.codex.blocked.title" })}
          </div>
          <p className="text-ui-sm text-foreground-subtle">
            {formatMessage({ id: "remoteSync.codex.blocked.body" })}
          </p>
          <p
            data-testid={`remote-sync-codex-reason-${category}`}
            className="text-ui-sm text-foreground"
          >
            {formatMessage({ id: `remoteSync.codex.category.${category}` })}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 部分生效分类（插件）的说明：marketplace 行会生效，inline 行已从列表排除。 */
export function DataSyncCodexPartialNotice(props: {
  category: DataSyncCategoryId;
  formatMessage: FormatMessage;
}) {
  return (
    <div
      data-testid={`remote-sync-codex-partial-${props.category}`}
      className="flex shrink-0 items-start gap-2 rounded-xl border border-border px-3 py-2 text-ui-sm text-foreground-subtle"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {props.formatMessage({ id: `remoteSync.codex.category.${props.category}` })}
      </span>
    </div>
  );
}

/** 设置页「数据同步」分区的口径提示：本机跑 Codex 时，这里的本机数据只来自 Codez 自有存储。 */
export function DataSyncCodexSectionNotice(props: { formatMessage: FormatMessage }) {
  return (
    <div
      data-testid="remote-sync-codex-section-notice"
      className="flex items-start gap-2 rounded-xl bg-warning-surface px-3 py-2 text-ui-sm text-warning-surface-foreground"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {props.formatMessage({ id: "remoteSync.codex.sectionNotice" })}
      </span>
    </div>
  );
}
