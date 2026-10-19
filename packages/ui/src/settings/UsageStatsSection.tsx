import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { Badge } from "@/components/ui/badge.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import type { RemoteTarget } from "@codez/shared";
import type { CodingPlanUsageSource } from "@/settings/usage-stats/CodingPlanUsagePanel.js";
import { useSettingsMachineLabel } from "@/settings/SettingsMachine.js";

export type UsageStatsSectionTab = "app" | "codingPlan" | `codingPlan:${string}`;

export function UsageStatsSection({
  activeTab,
  providerSourcesLoading,
  workspaceIdentity,
  workspacePath,
  remoteSessionId,
  remoteTarget,
  selectedCodingPlanSource,
  desktopCodex = false,
}: {
  activeTab?: UsageStatsSectionTab;
  providerSourcesLoading?: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  selectedCodingPlanSource?: CodingPlanUsageSource | null;
  desktopCodex?: boolean;
}) {
  void activeTab;
  void providerSourcesLoading;
  void selectedCodingPlanSource;
  void desktopCodex;
  const targetWorkspacePath = workspacePath ?? null;
  // UsageStatsSection 是机器用量数据的目标解析唯一所有者。这里必须显式传入
  // 最近 active workspace 的 remoteSessionId，否则设置专用 tab 没有 workspace
  // ServiceProvider 时会被误判成本机数据。
  const { services, connectionKind } = useWorkspaceServicesResolution(
    targetWorkspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  return (
    <div className="min-w-0">
      <AppUsagePanel
        key={workspaceIdentity?.trim() || workspacePath || "no-workspace"}
        workspaceIdentity={workspaceIdentity}
        workspacePath={targetWorkspacePath ?? undefined}
        usageStatsService={services.usageStatsService}
      >
        <UsageStatsSourceBadge
          remoteSessionId={remoteSessionId}
          remoteTarget={remoteTarget}
          workspaceIdentity={workspaceIdentity}
          connectionKind={connectionKind}
        />
      </AppUsagePanel>
    </div>
  );
}

function UsageStatsSourceBadge({
  remoteSessionId,
  remoteTarget,
  workspaceIdentity,
  connectionKind,
}: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  workspaceIdentity?: string;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
}) {
  const machine = useSettingsMachineLabel();
  const { intl } = useCodezIntl();
  const { label } = machine(
    {
      workspaceIdentity,
      remoteSessionId: remoteSessionId ?? undefined,
      remoteTarget: remoteTarget ?? undefined,
    },
    undefined,
  );
  // connectionKind 是服务解析权威；机器标签只提供展示名，不反向推断路由。
  void connectionKind;
  return (
    <div className="flex justify-end">
      <Badge
        variant="secondary"
        className="rounded-full border-border bg-surface text-ui-sm"
        data-testid="usage-stats-source"
      >
        {intl.formatMessage({ id: "settings.usage.sourceMachine" }, { label })}
      </Badge>
    </div>
  );
}
