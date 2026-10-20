import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import type { CodingPlanUsageSource } from "@/settings/usage-stats/CodingPlanUsagePanel.js";

export type UsageStatsSectionTab = "app" | "codingPlan" | `codingPlan:${string}`;

export function UsageStatsSection({
  activeTab,
  providerSourcesLoading,
  workspaceIdentity,
  workspacePath,
  selectedCodingPlanSource,
  desktopCodex = false,
}: {
  activeTab?: UsageStatsSectionTab;
  providerSourcesLoading?: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
  selectedCodingPlanSource?: CodingPlanUsageSource | null;
  desktopCodex?: boolean;
}) {
  void activeTab;
  void providerSourcesLoading;
  void selectedCodingPlanSource;
  void desktopCodex;
  return (
    <AppUsagePanel
      key={workspaceIdentity?.trim() || workspacePath || "no-workspace"}
      workspaceIdentity={workspaceIdentity}
      workspacePath={workspacePath}
    />
  );
}
