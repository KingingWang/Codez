import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { CodexOnlyUsagePanel } from "@/settings/usage-stats/CodexOnlyUsagePanel.js";
import {
  CodingPlanUsagePanel,
  type CodingPlanUsageSource,
} from "@/settings/usage-stats/CodingPlanUsagePanel.js";

export type UsageStatsSectionTab = "app" | "codingPlan" | `codingPlan:${string}`;

export function UsageStatsSection({
  activeTab,
  providerSourcesLoading,
  workspaceIdentity,
  workspacePath,
  selectedCodingPlanSource,
  desktopCodex = false,
}: {
  activeTab: UsageStatsSectionTab;
  providerSourcesLoading: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
  selectedCodingPlanSource?: CodingPlanUsageSource | null;
  desktopCodex?: boolean;
}) {
  if (activeTab === "app") {
    if (desktopCodex) {
      return (
        <CodexOnlyUsagePanel
          key={workspaceIdentity?.trim() || workspacePath || "no-workspace"}
          workspaceIdentity={workspaceIdentity}
          workspacePath={workspacePath}
        />
      );
    }
    return (
      <AppUsagePanel
        key={workspaceIdentity?.trim() || workspacePath || "no-workspace"}
        workspaceIdentity={workspaceIdentity}
        workspacePath={workspacePath}
      />
    );
  }

  return (
    <CodingPlanUsagePanel
      loadingSources={providerSourcesLoading}
      workspaceIdentity={workspaceIdentity}
      workspacePath={workspacePath}
      selectedSource={selectedCodingPlanSource}
    />
  );
}
