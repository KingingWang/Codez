import type { ReactNode } from "react";
import type { useCodezIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";

/**
 * 重试态详情只绑定当前 live snapshot，不写入 transcript。
 * 有详情时让状态本身成为触发器，避免用户还要在另一处寻找同一次失败。
 *
 * 拆分原因：本组件原先定义在 chat-input-toolbar/display.tsx 里，而 display.tsx 还转出
 * contextUsage → CodingPlanUsageRemainingPanel → oauthProviderIcon（含 .svg 资源）。
 * 纯 Node/tsx 回归（src/v4/codexRetryStatus.test.tsx）经 CodexRetryStatus → display.tsx
 * 拉进这条链时会因 ERR_UNKNOWN_FILE_EXTENSION ".svg" 直接起不来。这里把它独立成只依赖
 * cn + Popover 的窄模块，display.tsx 继续原样转出，既有调用方不受影响。
 */
export function RetryErrorDetailsPopover({
  detail,
  intl,
  retryLabel,
  children,
  className,
  testId,
}: {
  detail?: string | null;
  intl: ReturnType<typeof useCodezIntl>["intl"];
  retryLabel: string;
  children: ReactNode;
  className?: string;
  testId: string;
}) {
  const normalizedDetail = detail?.trim();
  const detailsLabel = intl.formatMessage({ id: "chat.apiRetryDetails.open" });
  const statusProps = {
    role: "status" as const,
    "aria-live": "polite" as const,
    "data-testid": testId,
  };

  if (!normalizedDetail) {
    return (
      <span
        {...statusProps}
        className={cn("inline-flex min-h-7 max-w-full min-w-0 items-center", className)}
        title={retryLabel}
      >
        {children}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...statusProps}
          aria-label={detailsLabel}
          title={detailsLabel}
          className={cn(
            "inline-flex min-h-7 max-w-full min-w-0 cursor-pointer items-center rounded-md text-left",
            "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        data-testid={`${testId}-details`}
        className="w-96 max-w-[calc(100vw-1.5rem)] gap-2 p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <PopoverTitle className="text-ui-base font-medium">
          {intl.formatMessage({ id: "chat.apiRetryDetails.title" })}
        </PopoverTitle>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground-subtle select-text">
          {normalizedDetail}
        </pre>
      </PopoverContent>
    </Popover>
  );
}
