import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { Badge } from "@/components/ui/badge.js";
import { useCodezIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { parseRemoteWorkspaceIdentity, type RemoteTarget } from "@codez/shared";
import type { CodingPlanUsageSource } from "@/settings/usage-stats/CodingPlanUsagePanel.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";
import { formatRemoteDeviceName } from "@/lib/remoteConnectionPresentation.js";

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
          remoteTarget={remoteTarget}
          workspaceIdentity={workspaceIdentity}
          connectionKind={connectionKind}
        />
      </AppUsagePanel>
    </div>
  );
}

function UsageStatsSourceBadge({
  remoteTarget,
  workspaceIdentity,
  connectionKind,
}: {
  remoteTarget?: RemoteTarget | null;
  workspaceIdentity?: string;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
}) {
  const sourceServerId = parseRemoteWorkspaceIdentity(workspaceIdentity ?? "")?.sourceServerId;
  const deviceInput = useRemoteDevicePresentationInput(sourceServerId);
  const { intl } = useCodezIntl();
  // Bugfix：上游 3.17.1 删除了旧 SettingsMachine（连同 settings.machine.local/remote 两个文案），
  // 迁移时若只取设备名，远端来源徽标会丢掉「（远程）」后缀，用户无法区分本机与所属服务器的统计。
  // 这里恢复原 fork 的文案组合：设备名只复用管理快照的展示输入，不为此发起 attachment，
  // 也不改变按所属服务器路由的统计口径；connectionKind 仍是服务解析权威，标签不反向推断路由。
  const deviceName =
    formatRemoteDeviceName(
      deviceInput?.target ?? remoteTarget ?? undefined,
      deviceInput?.displayName,
    ) ?? intl.formatMessage({ id: "settings.machine.unknownRemote" });
  const label =
    connectionKind === "local-ready"
      ? intl.formatMessage({ id: "settings.scope.localDevice" })
      : intl.formatMessage({ id: "settings.machine.remote" }, { name: deviceName });
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
