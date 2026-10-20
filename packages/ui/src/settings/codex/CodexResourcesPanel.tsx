import { useState } from "react";
import { Blocks, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { codexPluginInstallRequest } from "./codexSettingsData.js";
import { CodexConfirmButton, CodexNotice } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";
export function CodexSkillsPanel({ controller }: { controller: CodexSettingsController }) {
  const text = useCodexMessages();
  const state = controller.snapshot.skills;
  const disabled = controller.busy || controller.loading || !controller.enabled;
  const skillEntries =
    state?.data?.data.flatMap((entry) =>
      entry.skills.map((skill) => ({ cwd: entry.cwd, skill })),
    ) ?? [];
  return (
    <div className="space-y-6">
      <SettingsResourceGroupHeader count={skillEntries.length} title={text.skills} />
      {state?.error ? <CodexNotice error>{state.error}</CodexNotice> : null}
      {state?.data?.data.flatMap((entry) =>
        entry.errors.map((error) => (
          <CodexNotice key={`${entry.cwd}:${error.path}`} error>
            {error.path}: {error.message}
          </CodexNotice>
        )),
      )}
      <SettingsResourceList
        items={skillEntries}
        getKey={({ cwd, skill }) => `${cwd}:${skill.path}`}
        renderItem={({ skill }) => (
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover">
            <div
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
              aria-hidden="true"
            >
              <WandSparkles className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-ui-base font-medium text-foreground">
                  {skill.name}
                </span>
                <span className="inline-flex min-h-5 items-center rounded-md bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
                  {skill.enabled ? text.enabled : text.disabled}
                </span>
              </div>
              {skill.description ? (
                <p className="mt-0.5 break-words text-ui-sm text-foreground-subtle">
                  {skill.description}
                </p>
              ) : null}
              <p className="mt-0.5 break-all font-mono text-ui-xs text-foreground-subtlest">
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
        )}
      />
      {state?.data && skillEntries.length === 0 ? <CodexNotice>{text.empty}</CodexNotice> : null}
    </div>
  );
}

export function CodexPluginsPanel({ controller }: { controller: CodexSettingsController }) {
  const text = useCodexMessages();
  const [source, setSource] = useState("");
  const state = controller.snapshot.plugins;
  const disabled = controller.busy || controller.loading || !controller.enabled;
  return (
    <div className="space-y-6">
      <h3 className="text-ui-base font-medium text-foreground">{text.plugins}</h3>
      {state?.error ? <CodexNotice error>{state.error}</CodexNotice> : null}
      {state?.data?.marketplaceLoadErrors.map((error) => (
        <CodexNotice key={error.marketplacePath} error>
          {error.marketplacePath}: {error.message}
        </CodexNotice>
      ))}
      <SettingsGroupCard>
        <form
          className="flex flex-wrap items-end gap-2 p-4"
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
          <label className="min-w-0 flex-1 space-y-1 text-ui-sm text-foreground-subtle">
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
      </SettingsGroupCard>
      {state?.data?.marketplaces.map((marketplace) => (
        <div key={`${marketplace.name}:${marketplace.path}`} className="space-y-3">
          <SettingsResourceGroupHeader
            count={marketplace.plugins.length}
            title={marketplace.name}
            actions={
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
            }
          />
          {marketplace.path ? (
            <p className="break-all font-mono text-ui-xs text-foreground-subtle">
              {marketplace.path}
            </p>
          ) : null}
          <SettingsResourceList
            items={marketplace.plugins}
            getKey={(plugin) => plugin.id}
            renderItem={(plugin) => {
              const pluginTarget = `${plugin.name} (${marketplace.name}, ${plugin.id})`;
              const restricted =
                plugin.availability !== "AVAILABLE" ||
                plugin.installPolicy === "NOT_AVAILABLE" ||
                plugin.mustShowInstallationInterstitial;
              return (
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-hover">
                  <div
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
                    aria-hidden="true"
                  >
                    <Blocks className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-ui-base font-medium text-foreground">
                      {plugin.name}
                    </p>
                    <p className="mt-0.5 text-ui-sm text-foreground-subtle">
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
            }}
          />
        </div>
      ))}
      {state?.data?.marketplaces.length === 0 ? <CodexNotice>{text.empty}</CodexNotice> : null}
    </div>
  );
}
