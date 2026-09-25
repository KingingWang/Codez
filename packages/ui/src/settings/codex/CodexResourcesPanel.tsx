import { useEffect, useState } from "react";
import {
  DesktopCommandIds,
  codexMcpOauthResponseSchema,
  nativeBrowserCuaMcpDescriptorResultSchema,
} from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  classifyCodexNativeBrowserCua,
  codexAuthorizationUrl,
  codexPluginInstallRequest,
  installCodexNativeBrowserCuaMcp,
  isCodexNativeBrowserCuaConfigured,
} from "./codexSettingsData.js";
import { CodexConfirmButton, CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

export function CodexSkillsPanel({ controller }: { controller: CodexSettingsController }) {
  const text = useCodexMessages();
  const state = controller.snapshot.skills;
  const disabled = controller.busy || controller.loading || !controller.enabled;
  return (
    <CodexSection title={text.skills}>
      {state?.error ? <CodexNotice error>{state.error}</CodexNotice> : null}
      {state?.data?.data.flatMap((entry) =>
        entry.errors.map((error) => (
          <CodexNotice key={`${entry.cwd}:${error.path}`} error>
            {error.path}: {error.message}
          </CodexNotice>
        )),
      )}
      {state?.data?.data.flatMap((entry) =>
        entry.skills.map((skill) => (
          <div
            key={`${entry.cwd}:${skill.path}`}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-ui-base">
                {skill.name} · {skill.enabled ? text.enabled : text.disabled}
              </p>
              <p className="break-words text-ui-sm text-foreground-subtle">{skill.description}</p>
              <p className="break-all font-mono text-ui-sm text-foreground-subtlest">
                {skill.path} · {skill.scope}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() =>
                void controller.run(async () => {
                  await controller.request({
                    method: "skills/config/write",
                    params: { path: skill.path, enabled: !skill.enabled },
                  });
                })
              }
            >
              {skill.enabled ? text.disable : text.enable}
            </Button>
          </div>
        )),
      )}
      {state?.data && state.data.data.every((entry) => entry.skills.length === 0) ? (
        <CodexNotice>{text.empty}</CodexNotice>
      ) : null}
    </CodexSection>
  );
}

export function CodexMcpPanel({
  controller,
  remote = false,
  nativeBrowserCuaCapability,
  descriptorOverride,
}: {
  controller: CodexSettingsController;
  remote?: boolean;
  nativeBrowserCuaCapability?: string;
  descriptorOverride?: unknown;
}) {
  const text = useCodexMessages();
  const platform = usePlatform();
  const state = controller.snapshot.mcp;
  const [authorization, setAuthorization] = useState<{ name: string; url: string } | null>(null);
  const [loadedDescriptor, setLoadedDescriptor] = useState<unknown>();
  const descriptor = descriptorOverride ?? loadedDescriptor;
  const [descriptorError, setDescriptorError] = useState<string | undefined>();
  const disabled = controller.busy || controller.loading || !controller.enabled;
  useEffect(() => {
    let cancelled = false;
    setLoadedDescriptor(undefined);
    setDescriptorError(undefined);
    const capabilityAllows =
      nativeBrowserCuaCapability === "degraded" || nativeBrowserCuaCapability === "supported";
    if (remote || !capabilityAllows || typeof platform.executeDesktopCommand !== "function") return;
    void platform
      .executeDesktopCommand(DesktopCommandIds.GetCodexNativeBrowserCuaMcpDescriptor)
      .then((value) => {
        if (!cancelled) setLoadedDescriptor(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDescriptorError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [nativeBrowserCuaCapability, platform, remote]);
  const parsedDescriptor = descriptor
    ? nativeBrowserCuaMcpDescriptorResultSchema.safeParse(descriptor)
    : undefined;
  const activeDescriptor = parsedDescriptor?.success ? parsedDescriptor.data : undefined;
  if (descriptor && !activeDescriptor) setDescriptorError("Invalid Desktop browser descriptor");
  const configured = isCodexNativeBrowserCuaConfigured(
    controller.snapshot.config?.data,
    activeDescriptor?.runtimeInstalled ? activeDescriptor : undefined,
  );
  const nativeStatus = classifyCodexNativeBrowserCua({
    capability: nativeBrowserCuaCapability,
    remote,
    descriptor: activeDescriptor?.runtimeInstalled ? activeDescriptor : undefined,
    descriptorError,
    configured,
  });
  const nativeDisabled = disabled || nativeStatus !== "not-configured";
  let nativeStatusMessage: string;
  switch (nativeStatus) {
    case "configured":
      nativeStatusMessage = text.nativeBrowserCuaConfigured;
      break;
    case "unsupported":
      nativeStatusMessage = text.nativeBrowserCuaUnsupported;
      break;
    case "runtime-missing":
      nativeStatusMessage = text.nativeBrowserCuaRuntimeMissing;
      break;
    case "service-not-running":
      nativeStatusMessage = text.nativeBrowserCuaServiceNotRunning;
      break;
    case "descriptor-unavailable":
      nativeStatusMessage = text.nativeBrowserCuaDescriptorUnavailable;
      break;
    default:
      nativeStatusMessage = text.nativeBrowserCuaNotConfigured;
  }
  const nativeServer = state?.data?.data.find(
    (server) => server.name === "codez-desktop-browser-cua",
  );
  return (
    <CodexSection title={text.mcp}>
      {state?.error ? <CodexNotice error>{state.error}</CodexNotice> : null}
      <div className="space-y-2 rounded-lg bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-ui-base">{text.nativeBrowserCuaTitle}</p>
            <p className="text-ui-sm text-foreground-subtle">{nativeStatusMessage}</p>
            <p className="text-ui-sm text-foreground-subtle">{text.nativeBrowserCuaDegraded}</p>
            <p className="text-ui-sm text-foreground-subtle">
              {text.nativeBrowserCuaStatuses} {nativeServer?.runtimeStatus ?? text.notConnected} ·{" "}
              {nativeServer?.authStatus ?? "unknown"} · {text.tools}:{" "}
              {nativeServer ? Object.keys(nativeServer.tools).length : 0}
            </p>
            {nativeServer?.toolsError ? (
              <CodexNotice error>{nativeServer.toolsError}</CodexNotice>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={nativeDisabled}
            onClick={() =>
              void controller.run(async () => {
                if (!activeDescriptor?.runtimeInstalled)
                  throw new Error(text.nativeBrowserCuaRuntimeMissing);
                await installCodexNativeBrowserCuaMcp(controller, activeDescriptor);
              })
            }
          >
            {text.nativeBrowserCuaInstall}
          </Button>
        </div>
      </div>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() =>
          void controller.run(async () => {
            await controller.request({ method: "config/mcpServer/reload" });
          })
        }
      >
        {text.reload}
      </Button>
      {state?.data?.data.map((server) => (
        <div
          key={server.name}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-ui-base">{server.name}</p>
            <p className="text-ui-sm text-foreground-subtle">
              {server.runtimeStatus ?? text.notConnected} · {server.authStatus} · {text.tools}:{" "}
              {Object.keys(server.tools).length}
            </p>
            {server.toolsError ? <CodexNotice error>{server.toolsError}</CodexNotice> : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || server.authStatus === "unsupported"}
            onClick={() =>
              void controller.run(async () => {
                const result = codexMcpOauthResponseSchema.parse(
                  await controller.request({
                    method: "mcpServer/oauth/login",
                    params: { name: server.name },
                  }),
                );
                const url = codexAuthorizationUrl(result.authorizationUrl);
                setAuthorization({ name: server.name, url });
                platform.openExternal(url);
              })
            }
          >
            {text.oauth}
          </Button>
        </div>
      ))}
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
      {state?.data?.data.length === 0 ? <CodexNotice>{text.empty}</CodexNotice> : null}
    </CodexSection>
  );
}

export function CodexPluginsPanel({ controller }: { controller: CodexSettingsController }) {
  const text = useCodexMessages();
  const [source, setSource] = useState("");
  const state = controller.snapshot.plugins;
  const disabled = controller.busy || controller.loading || !controller.enabled;
  return (
    <CodexSection title={text.plugins}>
      {state?.error ? <CodexNotice error>{state.error}</CodexNotice> : null}
      {state?.data?.marketplaceLoadErrors.map((error) => (
        <CodexNotice key={error.marketplacePath} error>
          {error.marketplacePath}: {error.message}
        </CodexNotice>
      ))}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.run(async () => {
            await controller.request({
              method: "marketplace/add",
              params: { source: source.trim() },
            });
            setSource("");
          });
        }}
      >
        <label className="min-w-0 flex-1 space-y-1 text-ui-sm">
          {text.source}
          <Input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={disabled}
          />
        </label>
        <Button type="submit" variant="outline" disabled={disabled || !source.trim()}>
          {text.add}
        </Button>
      </form>
      {state?.data?.marketplaces.map((marketplace) => (
        <div
          key={`${marketplace.name}:${marketplace.path}`}
          className="space-y-3 border-t border-border pt-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h4 className="text-ui-base font-medium">{marketplace.name}</h4>
              {marketplace.path ? (
                <p className="break-all font-mono text-ui-sm text-foreground-subtle">
                  {marketplace.path}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  void controller.run(async () => {
                    await controller.request({
                      method: "marketplace/upgrade",
                      params: { marketplaceName: marketplace.name },
                    });
                  })
                }
              >
                {text.upgrade}
              </Button>
              <CodexConfirmButton
                label={text.remove}
                disabled={disabled}
                onConfirm={() =>
                  void controller.run(async () => {
                    await controller.request({
                      method: "marketplace/remove",
                      params: { marketplaceName: marketplace.name },
                    });
                  })
                }
              />
            </div>
          </div>
          {marketplace.plugins.map((plugin) => {
            const restricted =
              plugin.availability !== "AVAILABLE" ||
              plugin.installPolicy === "NOT_AVAILABLE" ||
              plugin.mustShowInstallationInterstitial;
            return (
              <div
                key={plugin.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-ui-base">{plugin.name}</p>
                  <p className="text-ui-sm text-foreground-subtle">
                    {plugin.installed
                      ? `${text.installed} · ${plugin.enabled ? text.enabled : text.disabled}`
                      : plugin.availability}
                  </p>
                  {restricted ? <CodexNotice>{text.consent}</CodexNotice> : null}
                </div>
                {plugin.installed ? (
                  <CodexConfirmButton
                    label={text.uninstall}
                    disabled={disabled}
                    onConfirm={() =>
                      void controller.run(async () => {
                        await controller.request({
                          method: "plugin/uninstall",
                          params: { pluginId: plugin.id },
                        });
                      })
                    }
                  />
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || Boolean(restricted)}
                    onClick={() =>
                      void controller.run(async () => {
                        await controller.request(codexPluginInstallRequest(marketplace, plugin));
                      })
                    }
                  >
                    {text.install}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {state?.data?.marketplaces.length === 0 ? <CodexNotice>{text.empty}</CodexNotice> : null}
    </CodexSection>
  );
}
