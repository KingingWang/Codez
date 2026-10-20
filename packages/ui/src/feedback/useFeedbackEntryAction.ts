import { useCallback, useEffect, useState } from "react";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import * as platformModule from "@/hooks/usePlatform.js";
import * as servicesModule from "@/hooks/useServices.js";
import type { IPlatformService } from "@codez/shared";
import type { IServiceAccessor } from "@codez/services";
import type { FeedbackDiagnosticRuntime } from "@/feedback/feedbackDiagnostics.js";
import { buildFeedbackEntryUrl, type FeedbackEntryContext } from "@/feedback/feedbackEntryPlan.js";
import { logger } from "@/logger.js";

export type FeedbackEntryOutcome = "opened" | "unavailable";

export interface FeedbackEntryAction {
  runFeedbackEntry: (context: FeedbackEntryContext) => FeedbackEntryOutcome;
}

function useSafeOptionalPlatform(): IPlatformService | null {
  try {
    if (typeof platformModule.useOptionalPlatform === "function") {
      return platformModule.useOptionalPlatform();
    }
  } catch {
    // 单测中若只 mock 了 usePlatform，访问 useOptionalPlatform getter 会抛错，降级走 usePlatform。
  }
  try {
    if (typeof platformModule.usePlatform === "function") {
      return platformModule.usePlatform();
    }
  } catch {
    return null;
  }
  return null;
}

function useSafeOptionalServices(): IServiceAccessor | null {
  try {
    if (typeof servicesModule.useOptionalServices === "function") {
      return servicesModule.useOptionalServices();
    }
  } catch {
    // 单测中若只 mock 了 useServices，访问 useOptionalServices getter 会抛错，降级走 useServices。
  }
  try {
    if (typeof servicesModule.useServices === "function") {
      return servicesModule.useServices();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 反馈入口的统一动作：所有反馈与产品建议入口都通过本 hook 打开本项目 GitHub Issues 预填页面。
 * 使用 useOptionalPlatform / useOptionalServices 避免在无 Provider 的分享页或单测宿主中渲染崩溃。
 */
export function useFeedbackEntryAction(): FeedbackEntryAction {
  const platform = useSafeOptionalPlatform();
  const services = useSafeOptionalServices();
  const feedbackService = services?.feedbackService;
  const { intl, locale } = useCodezIntl();
  const [diagnosticRuntime, setDiagnosticRuntime] = useState<FeedbackDiagnosticRuntime>({});

  useEffect(() => {
    if (!feedbackService?.getDeviceSnapshot) {
      return;
    }
    let canceled = false;
    void feedbackService
      .getDeviceSnapshot()
      .then((device) => {
        if (!canceled && device) {
          setDiagnosticRuntime({ device });
        }
      })
      .catch((error: unknown) => {
        logger.warn("[feedback] 读取本地设备快照失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      canceled = true;
    };
  }, [feedbackService]);

  const runFeedbackEntry = useCallback(
    (context: FeedbackEntryContext): FeedbackEntryOutcome => {
      const url = buildFeedbackEntryUrl({
        context,
        locale,
        formatMessage: (id, values) => intl.formatMessage({ id }, values),
        runtime: diagnosticRuntime,
      });
      if (!url || !platform) {
        return "unavailable";
      }
      platform.openExternal(url);
      return "opened";
    },
    [diagnosticRuntime, intl, locale, platform],
  );

  return { runFeedbackEntry };
}
