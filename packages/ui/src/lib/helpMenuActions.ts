import type { IPlatformService } from "@codez/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { FeedbackEntryContext } from "@/feedback/feedbackEntryPlan.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { CODEZ_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

export interface HelpMenuActionHandlers {
  openIssueReport: () => Promise<void>;
  openProductRequest: () => Promise<void>;
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
  runFeedbackEntry,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
  runFeedbackEntry: (context: FeedbackEntryContext) => unknown;
}): HelpMenuActionHandlers {
  return {
    openIssueReport: async () => {
      runFeedbackEntry({ kind: "bug" });
    },
    openProductRequest: async () => {
      runFeedbackEntry({ kind: "feature" });
    },
    openProductDocs: () => {
      platform.openExternal(CODEZ_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
