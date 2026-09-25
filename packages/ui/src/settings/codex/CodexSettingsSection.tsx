import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import type { IServiceAccessor } from "@codez/services";
import { useCodexSettings } from "@/hooks/useCodexSettings.js";
import { CodexAgentsPanel } from "./CodexAgentsPanel.js";
import { CodexAccountPanel } from "./CodexAccountPanel.js";
import { CodexConfigPanel } from "./CodexConfigPanel.js";
import { CodexMcpPanel, CodexPluginsPanel, CodexSkillsPanel } from "./CodexResourcesPanel.js";
import { CodexHistoryPanel } from "./CodexHistoryPanel.js";
import { CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

type Panel = "account" | "models" | "skills" | "agents" | "mcp" | "plugins" | "config" | "history";
const PANELS: Panel[] = [
  "account",
  "models",
  "skills",
  "agents",
  "mcp",
  "plugins",
  "config",
  "history",
];
interface CodexSettingsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  sessionId?: string;
  remoteSessionId?: string;
  initialPanel?: Panel;
  onboarding?: boolean;
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
  const [panel, setPanel] = useState<Panel>(props.initialPanel ?? "account");
  const nativeBrowserCuaCapability = useCodexNativeBrowserCuaCapability(
    controller.services,
    controller.remote,
  );
  return (
    <div data-testid="codex-settings" className="space-y-4 text-ui-base text-foreground">
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
      {!controller.enabled ? (
        <CodexNotice>{text.workspace}</CodexNotice>
      ) : (
        <div key={controller.formKey} className="space-y-4">
          <CodexNotice>{text.mutations}</CodexNotice>
          {controller.loading ? <CodexNotice>{text.loading}</CodexNotice> : null}
          {controller.error ? (
            <div className="space-y-1">
              <CodexNotice error>{text.failed}</CodexNotice>
              <CodexNotice error>{controller.error}</CodexNotice>
            </div>
          ) : null}
          {!props.onboarding ? (
            <nav aria-label={text.title} className="flex flex-wrap gap-1">
              {PANELS.map((id) => (
                <Button
                  key={id}
                  variant={panel === id ? "secondary" : "ghost"}
                  size="sm"
                  aria-current={panel === id ? "page" : undefined}
                  onClick={() => setPanel(id)}
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
            <CodexConfigPanel key={panel} controller={controller} advanced={panel === "config"} />
          ) : null}
          {panel === "skills" ? <CodexSkillsPanel controller={controller} /> : null}
          {panel === "agents" ? (
            <CodexAgentsPanel
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              remoteSessionId={props.remoteSessionId}
            />
          ) : null}
          {panel === "mcp" ? (
            <CodexMcpPanel
              controller={controller}
              remote={controller.remote}
              nativeBrowserCuaCapability={nativeBrowserCuaCapability}
            />
          ) : null}
          {panel === "plugins" ? <CodexPluginsPanel controller={controller} /> : null}
          {panel === "history" ? (
            <CodexHistoryPanel
              agentService={controller.services.codezAgentService}
              workspacePath={props.workspacePath}
              workspaceIdentity={props.workspaceIdentity}
              sessionId={props.sessionId ?? ""}
            />
          ) : null}
          {!props.onboarding ? <CodexNotice>{text.parity}</CodexNotice> : null}
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

function useCodexNativeBrowserCuaCapability(
  services: IServiceAccessor,
  remote: boolean,
): string | undefined {
  const [state, setState] = useState<{ capability?: string } | undefined>(undefined);
  const agentService = services.codezAgentService;
  useEffect(() => {
    let cancelled = false;
    setState(undefined);
    if (remote || !agentService?.helloConversationV4) return;
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (!cancelled) setState({ capability: hello.capabilities.codex?.nativeBrowserCuaMcp });
      })
      .catch(() => {
        if (!cancelled) setState(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, remote]);
  return state?.capability;
}
