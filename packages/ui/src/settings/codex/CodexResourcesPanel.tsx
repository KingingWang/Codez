import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { codexPluginInstallRequest } from "./codexSettingsData.js";
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
              aria-label={`${skill.enabled ? text.disable : text.enable} ${skill.name} (${skill.scope}: ${skill.path})`}
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
                aria-label={`${text.upgrade} ${marketplace.name}`}
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
                targetLabel={marketplace.name}
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
            const pluginTarget = `${plugin.name} (${marketplace.name}, ${plugin.id})`;
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
                    targetLabel={pluginTarget}
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
                    aria-label={`${text.install} ${pluginTarget}`}
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
