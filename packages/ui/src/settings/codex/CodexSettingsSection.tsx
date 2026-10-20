import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { useCodexSettings } from "@/hooks/useCodexSettings.js";
import { CodexAgentsPanel } from "./CodexAgentsPanel.js";
import { CodexAccountPanel } from "./CodexAccountPanel.js";
import { CodexConfigPanel } from "./CodexConfigPanel.js";
import { CodexHooksPanel } from "./CodexHooksPanel.js";
import { CodexMcpPanel } from "./CodexMcpPanel.js";
import { CodexPluginsPanel, CodexSkillsPanel } from "./CodexResourcesPanel.js";
import { CodexHistoryPanel } from "./CodexHistoryPanel.js";
import { CodexMemoryPanel } from "./CodexMemoryPanel.js";
import { CodexProvidersPanel } from "./CodexProvidersPanel.js";
import { CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";
import { useCodexNativeBrowserCuaCapability } from "./useCodexNativeBrowserCua.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useCodexModelCatalog } from "@/hooks/useCodexModelCatalog.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { CodexTitleModelSettings } from "./CodexTitleModelSettings.js";

export type CodexSettingsPanel =
  | "account"
  | "models"
  | "providers"
  | "skills"
  | "agents"
  | "hooks"
  | "mcp"
  | "plugins"
  | "config"
  | "history"
  | "memory";
const PANELS: CodexSettingsPanel[] = [
  "account",
  "models",
  "providers",
  "skills",
  "agents",
  "hooks",
  "mcp",
  "plugins",
  "config",
  "history",
  "memory",
];
const CODEX_CORE_PANELS: CodexSettingsPanel[] = ["account", "models", "config", "history"];
interface CodexSettingsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  sessionId?: string;
  remoteSessionId?: string;
  initialPanel?: CodexSettingsPanel;
  onboarding?: boolean;
  /**
   * 嵌在 SettingsPage 时为 true：外层已提供侧栏一级导航与页面大标题，
   * 独立分区（memory/providers/agents/mcp/plugins/skills）直接展示对应面板，
   * 不再重复渲染顶部 10 个横向按钮或冗余的 Codex 头部。
   */
  embeddedInSettingsPage?: boolean;
  /**
   * 内部面板切换回调：嵌在 SettingsPage 时将面板同步到外层侧栏；
   * 无独立侧栏入口的面板归属 Codex，并由调用方保留其内部选中态。
   */
  onPanelChange?: (panel: CodexSettingsPanel) => void;
}

export function CodexSettingsSection(props: CodexSettingsSectionProps) {
  // 同路径的远端身份与 attachment 切换也必须清空表单/授权 URL，不能只以路径复用。
  return (
    <CodexSettingsContent
      key={JSON.stringify([
        props.workspaceIdentity?.trim() || props.workspacePath,
        props.sessionId,
        props.remoteSessionId,
        props.initialPanel,
      ])}
      {...props}
    />
  );
}

function CodexSettingsContent(props: CodexSettingsSectionProps) {
  const text = useCodexMessages();
  const controller = useCodexSettings(props);
  const [panel, setPanel] = useState<CodexSettingsPanel>(props.initialPanel ?? "account");
  const isEmbeddedCodexCore =
    props.embeddedInSettingsPage === true && CODEX_CORE_PANELS.includes(panel);
  const isEmbeddedStandaloneSection = props.embeddedInSettingsPage === true && !isEmbeddedCodexCore;
  const baseWorkspaceServices = useBaseWorkspaceServices();
  // 修复原因：WorkspaceSettingsLayer 会注入当前远端 workspace 的 ServiceProvider；
  // 自动标题的全局默认与 workspaceIdentity 覆盖以及本机浏览器控制开关都属于控制端偏好，
  // 读写必须固定走控制端 baseServices，避免写入远端 Source Server 的 setting.json 或读回远端旧默认值。
  const {
    settings: appSettings,
    error: appSettingsError,
    update: updateAppSettings,
  } = useSettings({ services: baseWorkspaceServices });
  const titleModelCatalog = useCodexModelCatalog({
    workspacePath: props.workspacePath ?? "",
    workspaceIdentity: props.workspaceIdentity,
    remoteSessionId: props.remoteSessionId,
    enabled: panel === "models" && controller.enabled,
  });
  const nativeBrowserCuaCapability = useCodexNativeBrowserCuaCapability(
    controller.services,
    controller.remote,
  );
  const handleSelectPanel = (nextPanel: CodexSettingsPanel) => {
    setPanel(nextPanel);
    props.onPanelChange?.(nextPanel);
  };
  return (
    <div data-testid="codex-settings" className="space-y-6 text-ui-base text-foreground">
      {!props.embeddedInSettingsPage ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-ui-lg font-medium">{text.title}</h2>
            <p className="mt-1 text-ui-sm text-foreground-subtle">{text.subtitle}</p>
            {props.workspacePath ? (
              <p className="mt-1 break-all font-mono text-ui-sm text-foreground-subtlest">
                {text.scope}: {props.workspaceIdentity?.trim() || props.workspacePath}
              </p>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!controller.enabled || controller.busy || controller.loading}
            onClick={() => void controller.refresh()}
          >
            {text.refresh}
          </Button>
        </div>
      ) : isEmbeddedCodexCore ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SettingsSegmentedTabs
            value={panel}
            items={CODEX_CORE_PANELS.map((id) => ({
              value: id,
              label: text[id],
            }))}
            onValueChange={handleSelectPanel}
          />
          <SettingsResourceHeaderActions
            refreshLabel={text.refresh}
            refreshing={controller.loading}
            refreshDisabled={!controller.enabled || controller.busy || controller.loading}
            onRefresh={() => void controller.refresh()}
          />
        </div>
      ) : null}
      {!controller.enabled ? (
        <CodexNotice>{text.workspace}</CodexNotice>
      ) : (
        <div key={controller.formKey} className="space-y-6">
          {!isEmbeddedStandaloneSection && !props.embeddedInSettingsPage ? (
            <CodexNotice>{text.mutations}</CodexNotice>
          ) : null}
          {controller.loading ? <CodexNotice>{text.loading}</CodexNotice> : null}
          {controller.error ? (
            <div className="space-y-1">
              <CodexNotice error>{text.failed}</CodexNotice>
              <CodexNotice error>{controller.error}</CodexNotice>
            </div>
          ) : null}
          {!props.onboarding && !props.embeddedInSettingsPage ? (
            <nav aria-label={text.title} className="flex flex-wrap gap-1">
              {PANELS.map((id) => (
                <Button
                  key={id}
                  variant={panel === id ? "secondary" : "ghost"}
                  size="sm"
                  aria-current={panel === id ? "page" : undefined}
                  onClick={() => handleSelectPanel(id)}
                >
                  {text[id]}
                </Button>
              ))}
            </nav>
          ) : null}
          <div hidden={panel !== "account"}>
            <CodexAccountPanel controller={controller} />
          </div>
          {panel === "models" || panel === "config" ? (
            <>
              <CodexConfigPanel key={panel} controller={controller} advanced={panel === "config"} />
              {panel === "models" && props.workspacePath ? (
                <CodexTitleModelSettings
                  key={props.workspaceIdentity?.trim() || props.workspacePath}
                  settings={appSettings}
                  catalog={titleModelCatalog.catalog}
                  catalogError={titleModelCatalog.error}
                  workspacePath={props.workspacePath}
                  workspaceIdentity={props.workspaceIdentity}
                  settingsError={appSettingsError}
                  update={updateAppSettings}
                />
              ) : null}
            </>
          ) : null}
          {panel === "skills" ? <CodexSkillsPanel controller={controller} /> : null}
          {panel === "agents" ? (
            <CodexAgentsPanel
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              remoteSessionId={props.remoteSessionId}
            />
          ) : null}
          {panel === "hooks" ? (
            <CodexHooksPanel
              controller={controller}
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              hideSectionTitle={isEmbeddedStandaloneSection}
            />
          ) : null}
          {panel === "mcp" ? (
            <CodexMcpPanel
              controller={controller}
              remote={controller.remote}
              nativeBrowserCuaCapability={nativeBrowserCuaCapability}
              nativeBrowserControlEnabled={appSettings?.nativeBrowserControlEnabled !== false}
              onNativeBrowserControlEnabledChange={(enabled) =>
                updateAppSettings({ nativeBrowserControlEnabled: enabled })
              }
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
            />
          ) : null}
          {panel === "plugins" ? <CodexPluginsPanel controller={controller} /> : null}
          {panel === "memory" ? (
            <CodexMemoryPanel
              controller={controller}
              hideSectionTitle={isEmbeddedStandaloneSection}
            />
          ) : null}
          {panel === "providers" ? (
            <CodexProvidersPanel
              controller={controller}
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
            />
          ) : null}
          {panel === "history" ? (
            <CodexHistoryPanel
              agentService={controller.services.codezAgentService}
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              sessionId={props.sessionId ?? ""}
            />
          ) : null}
          {!props.onboarding && !props.embeddedInSettingsPage ? (
            <CodexNotice>{text.parity}</CodexNotice>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function CodexCapabilityNotice({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const text = useCodexMessages();
  return (
    <CodexSection title={text.unsupported}>
      <CodexNotice>{text.parity}</CodexNotice>
      {onOpenSettings ? (
        <Button variant="outline" onClick={onOpenSettings}>
          {text.openSettings}
        </Button>
      ) : null}
    </CodexSection>
  );
}
