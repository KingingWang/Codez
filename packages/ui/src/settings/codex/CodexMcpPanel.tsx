import { useMemo, useState } from "react";
import { codexMcpOauthResponseSchema } from "@codez/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { codexAuthorizationUrl } from "./codexSettingsData.js";
import { CodexNativeBrowserCuaCard } from "./CodexNativeBrowserCuaCard.js";
import { CodexMcpServerForm } from "./CodexMcpServerForm.js";
import { CodexConfirmButton, CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import {
  EMPTY_CODEX_MCP_FORM,
  codexMcpConfigToForm,
  codexMcpFormToConfig,
  codexProjectRootFromDotFolder,
  deleteCodexUserMcpServer,
  listCodexMcpServers,
  readCodexMcpProjectLayers,
  saveCodexUserMcpServer,
  setCodexUserMcpServerEnabled,
  trustCodexProject,
  type CodexMcpServerEntry,
  type CodexMcpServerFormState,
  type CodexMcpStatusView,
} from "./codexMcpSettings.js";
import { useCodexMessages } from "./messages.js";

export function CodexMcpPanel({
  controller,
  remote = false,
  nativeBrowserCuaCapability,
  descriptorOverride,
  nativeBrowserControlEnabled,
  onNativeBrowserControlEnabledChange,
  workspacePath,
  workspaceIdentity,
}: {
  controller: CodexSettingsController;
  remote?: boolean;
  nativeBrowserCuaCapability?: string;
  descriptorOverride?: unknown;
  /** 内置浏览器 Agent 工具开关；由 SettingsPage 层经 useSettings 注入，缺省不渲染开关。 */
  nativeBrowserControlEnabled?: boolean;
  onNativeBrowserControlEnabledChange?: (enabled: boolean) => void | Promise<void>;
  workspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const text = useCodexMessages();
  const platform = usePlatform();
  const state = controller.snapshot.mcp;
  const configState = controller.snapshot.config;
  const [authorization, setAuthorization] = useState<{ name: string; url: string } | null>(null);
  const [form, setForm] = useState<CodexMcpServerFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const disabled = controller.busy || controller.loading || !controller.enabled;

  const statuses = useMemo(() => {
    const map = new Map<string, CodexMcpStatusView>();
    for (const server of state?.data?.data ?? [])
      map.set(server.name, {
        runtimeStatus: server.runtimeStatus,
        authStatus: server.authStatus,
        toolCount: Object.keys(server.tools).length,
        toolsError: server.toolsError,
      });
    return map;
  }, [state?.data]);
  const entries = useMemo(
    () => listCodexMcpServers(configState?.data, statuses),
    [configState?.data, statuses],
  );
  const untrustedProjectLayer = useMemo(
    () => readCodexMcpProjectLayers(configState?.data).find((layer) => layer.disabledReason),
    [configState?.data],
  );

  // 项目层写入经 bridge 控制面（mcp/projectConfigWrite），在 workspace 所属机器上落盘；
  // bridge 写后已自行 reload，controller.run 再统一刷新快照。
  const projectWrite = (params: {
    action: "upsert" | "delete" | "set-enabled";
    name: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    dotCodexFolder?: string;
  }) => {
    if (!workspacePath) return;
    const target = { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
    void controller.run(async () => {
      await controller.services.codezAgentService.writeCodexProjectMcpConfig({
        ...target,
        ...params,
      });
    });
  };

  const submitForm = () => {
    if (!form) return;
    let config: Record<string, unknown>;
    try {
      config = codexMcpFormToConfig(form);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      return;
    }
    setFormError(null);
    const name = form.name.trim();
    if (form.scope === "project") {
      projectWrite({
        action: "upsert",
        name,
        config,
        ...(form.dotCodexFolder ? { dotCodexFolder: form.dotCodexFolder } : {}),
      });
      setForm(null);
      return;
    }
    void controller
      .run(async () => {
        await saveCodexUserMcpServer(controller, name, config);
      })
      .then((ok) => {
        if (ok) setForm(null);
      });
  };

  const scopeBadge = (entry: CodexMcpServerEntry) => {
    const label =
      entry.scope === "user"
        ? text.mcpScopeUser
        : entry.scope === "project"
          ? entry.layerDisabled
            ? text.mcpScopeProjectUntrusted
            : text.mcpScopeProject
          : text.mcpScopeBuiltin;
    return <Badge variant={entry.scope === "builtin" ? "outline" : "secondary"}>{label}</Badge>;
  };

  const renderEntry = (entry: CodexMcpServerEntry) => (
    <div
      key={`${entry.scope}:${entry.dotCodexFolder ?? ""}:${entry.name}`}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-ui-base">{entry.name}</p>
          {scopeBadge(entry)}
          {!entry.enabled ? <Badge variant="outline">{text.disabled}</Badge> : null}
        </div>
        <p className="text-ui-sm text-foreground-subtle">
          {entry.status
            ? `${entry.status.runtimeStatus ?? text.notConnected} · ${entry.status.authStatus} · ${text.tools}: ${entry.status.toolCount}`
            : entry.enabled
              ? text.notConnected
              : text.disabled}
        </p>
        {entry.status?.toolsError ? (
          <CodexNotice error>{entry.status.toolsError}</CodexNotice>
        ) : null}
        {entry.scope === "builtin" ? <CodexNotice>{text.mcpBuiltinHelp}</CodexNotice> : null}
        {!entry.manageable && entry.scope !== "builtin" ? (
          <CodexNotice>{text.mcpUnmanagedName}</CodexNotice>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {entry.manageable ? (
          <Switch
            size="sm"
            checked={entry.enabled}
            disabled={disabled}
            aria-label={`${entry.name}`}
            onCheckedChange={(checked) => {
              if (entry.scope === "project") {
                projectWrite({
                  action: "set-enabled",
                  name: entry.name,
                  enabled: checked,
                  ...(entry.dotCodexFolder ? { dotCodexFolder: entry.dotCodexFolder } : {}),
                });
              } else {
                runUserWrite(() => setCodexUserMcpServerEnabled(controller, entry.name, checked));
              }
            }}
          />
        ) : null}
        {entry.manageable ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setFormError(null);
              setForm(
                codexMcpConfigToForm(
                  entry.name,
                  entry.rawConfig,
                  entry.scope === "project" ? "project" : "user",
                  entry.dotCodexFolder,
                ),
              );
            }}
          >
            {text.mcpEdit}
          </Button>
        ) : null}
        {entry.manageable ? (
          <CodexConfirmButton
            label={text.remove}
            disabled={disabled}
            onConfirm={() => {
              if (entry.scope === "project") {
                projectWrite({
                  action: "delete",
                  name: entry.name,
                  ...(entry.dotCodexFolder ? { dotCodexFolder: entry.dotCodexFolder } : {}),
                });
              } else {
                runUserWrite(() => deleteCodexUserMcpServer(controller, entry.name));
              }
            }}
          />
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || (entry.status?.authStatus ?? "unsupported") === "unsupported"}
          onClick={() =>
            void controller.run(async () => {
              const result = codexMcpOauthResponseSchema.parse(
                await controller.request({
                  method: "mcpServer/oauth/login",
                  params: { name: entry.name },
                }),
              );
              const url = codexAuthorizationUrl(result.authorizationUrl);
              setAuthorization({ name: entry.name, url });
              platform.openExternal(url);
            })
          }
        >
          {text.oauth}
        </Button>
      </div>
    </div>
  );

  const runUserWrite = (operation: () => Promise<void>) => {
    void controller.run(operation);
  };

  return (
    <CodexSection title={text.mcp}>
      {state?.error ? <CodexNotice error>{state.error}</CodexNotice> : null}
      {configState?.error ? <CodexNotice error>{configState.error}</CodexNotice> : null}
      {!configState?.data && !configState?.error ? (
        <CodexNotice>{text.mcpConfigUnavailable}</CodexNotice>
      ) : null}
      <CodexNativeBrowserCuaCard
        controller={controller}
        remote={remote}
        nativeBrowserCuaCapability={nativeBrowserCuaCapability}
        descriptorOverride={descriptorOverride}
        nativeBrowserControlEnabled={nativeBrowserControlEnabled}
        onNativeBrowserControlEnabledChange={onNativeBrowserControlEnabledChange}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={disabled || !configState?.data}
          onClick={() => {
            setFormError(null);
            setForm({ ...EMPTY_CODEX_MCP_FORM });
          }}
        >
          {text.mcpAdd}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            void controller.run(async () => {
              await controller.request({ method: "config/mcpServer/reload" });
            })
          }
        >
          {text.reload}
        </Button>
      </div>
      {untrustedProjectLayer?.disabledReason ? (
        <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
          <CodexNotice error>{untrustedProjectLayer.disabledReason}</CodexNotice>
          <CodexNotice>{text.mcpProjectUntrustedHelp}</CodexNotice>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              runUserWrite(() =>
                trustCodexProject(
                  controller,
                  codexProjectRootFromDotFolder(untrustedProjectLayer.dotCodexFolder),
                ),
              )
            }
          >
            {text.mcpTrustProject}
          </Button>
        </div>
      ) : null}
      {form ? (
        <CodexMcpServerForm
          form={form}
          creating={!form.originalName}
          disabled={disabled}
          busy={controller.busy}
          {...(formError ? { error: formError } : {})}
          onChange={setForm}
          onSubmit={submitForm}
          onCancel={() => setForm(null)}
        />
      ) : null}
      {entries.map(renderEntry)}
      {entries.length === 0 && !state?.error && !form ? (
        <CodexNotice>{text.empty}</CodexNotice>
      ) : null}
      {authorization ? (
        <div className="space-y-2">
          <CodexNotice>
            {authorization.name}: {text.pending}
          </CodexNotice>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => platform.openExternal(authorization.url)}
          >
            {text.openBrowser}
          </Button>
        </div>
      ) : null}
    </CodexSection>
  );
}
