import { nativeBrowserCuaMcpDescriptorResultSchema } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  classifyCodexNativeBrowserCua,
  cleanupCodexNativeBrowserCuaLegacyMcp,
  getCodexNativeBrowserCuaLegacyRegistration,
} from "./codexSettingsData.js";
import { CodexNotice } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";
import { useCodexNativeBrowserCuaDescriptor } from "./useCodexNativeBrowserCua.js";

/**
 * 原生浏览器 MCP 卡片：Codex 设置的 MCP 面板与设置→浏览器分区共用同一个组件，
 * 描述符读取、状态分类与配置动作只有这一处实现，两个入口不会漂移
 * （spec: codex-desktop-native-browser-cua「Settings Browser section surfacing」）。
 */
export function CodexNativeBrowserCuaCard({
  controller,
  remote = false,
  nativeBrowserCuaCapability,
  descriptorOverride,
  nativeBrowserControlEnabled,
  onNativeBrowserControlEnabledChange,
}: {
  controller: CodexSettingsController;
  remote?: boolean;
  nativeBrowserCuaCapability?: string;
  descriptorOverride?: unknown;
  /**
   * 全局开关状态与变更回调（spec: codex-desktop-native-browser-cua「Global enable toggle」）。
   * 由父级经 useSettings 注入（update 先落盘再经 syncAppSettings 即时通知 Main）；
   * 缺省（测试/非设置上下文）不渲染开关，状态展示按开启处理。
   */
  nativeBrowserControlEnabled?: boolean;
  onNativeBrowserControlEnabledChange?: (enabled: boolean) => void | Promise<void>;
}) {
  const text = useCodexMessages();
  const nativeBrowserControlOn = nativeBrowserControlEnabled !== false;
  const loaded = useCodexNativeBrowserCuaDescriptor(nativeBrowserCuaCapability, remote);
  const descriptor = descriptorOverride ?? loaded.descriptor;
  const state = controller.snapshot.mcp;
  const disabled = controller.busy || controller.loading || !controller.enabled;
  const parsedDescriptor = descriptor
    ? nativeBrowserCuaMcpDescriptorResultSchema.safeParse(descriptor)
    : undefined;
  const activeDescriptor = parsedDescriptor?.success ? parsedDescriptor.data : undefined;
  // 解析失败与读取失败同属描述符不可用；派生计算替代原渲染期 setState，行为等价。
  const descriptorError =
    loaded.error ??
    (descriptor && !activeDescriptor ? "Invalid Desktop browser descriptor" : undefined);
  const legacyRegistration = getCodexNativeBrowserCuaLegacyRegistration(
    controller.snapshot.config?.data,
    activeDescriptor?.runtimeInstalled ? activeDescriptor : undefined,
  );
  const nativeStatus = classifyCodexNativeBrowserCua({
    capability: nativeBrowserCuaCapability,
    remote,
    descriptor: activeDescriptor?.runtimeInstalled ? activeDescriptor : undefined,
    descriptorError,
  });
  const legacyCleanupDisabled =
    disabled || nativeStatus !== "active" || legacyRegistration !== "codez-generated";
  let nativeStatusMessage: string;
  if (!nativeBrowserControlOn) {
    nativeStatusMessage = text.nativeBrowserControlDisabled;
  } else
    switch (nativeStatus) {
      case "active":
        nativeStatusMessage = text.nativeBrowserCuaActive;
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
    }
  const nativeServer = state?.data?.data.find(
    (server) => server.name === "codez-desktop-browser-cua",
  );
  return (
    <div className="space-y-2 rounded-lg bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-ui-base">{text.nativeBrowserCuaTitle}</p>
          <p className="text-ui-sm text-foreground-subtle">{nativeStatusMessage}</p>
          {/* 降级说明只在能力确实 degraded 时展示；unsupported 时再显示「Browser 命令可用」是误报。 */}
          {nativeBrowserCuaCapability === "degraded" ? (
            <p className="text-ui-sm text-foreground-subtle">{text.nativeBrowserCuaDegraded}</p>
          ) : null}
          <p className="text-ui-sm text-foreground-subtle">
            {text.nativeBrowserCuaStatuses} {nativeServer?.runtimeStatus ?? text.notConnected} ·{" "}
            {nativeServer?.authStatus ?? "unknown"} · {text.tools}:{" "}
            {nativeServer ? Object.keys(nativeServer.tools).length : 0}
          </p>
          {nativeServer?.toolsError ? (
            <CodexNotice error>{nativeServer.toolsError}</CodexNotice>
          ) : null}
          {legacyRegistration === "customized" ? (
            <p className="text-ui-sm text-warning">{text.nativeBrowserCuaLegacyCustomized}</p>
          ) : null}
          {legacyRegistration === "unknown" ? (
            <p className="text-ui-sm text-warning">{text.nativeBrowserCuaLegacyUnknown}</p>
          ) : null}
          {controller.snapshot.config?.error ? (
            <CodexNotice error>{controller.snapshot.config.error}</CodexNotice>
          ) : null}
        </div>
        {onNativeBrowserControlEnabledChange ? (
          <div className="flex items-center gap-2">
            <Switch
              checked={nativeBrowserControlOn}
              onCheckedChange={(checked) => void onNativeBrowserControlEnabledChange(checked)}
              aria-label={text.nativeBrowserControlToggle}
            />
            <span className="text-ui-sm text-foreground-subtle">
              {text.nativeBrowserControlToggle}
            </span>
          </div>
        ) : null}
        {legacyRegistration === "codez-generated" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={legacyCleanupDisabled}
            onClick={() =>
              void controller.run(async () => {
                if (!activeDescriptor?.runtimeInstalled)
                  throw new Error(text.nativeBrowserCuaRuntimeMissing);
                await cleanupCodexNativeBrowserCuaLegacyMcp(controller, activeDescriptor);
              })
            }
          >
            {text.nativeBrowserCuaLegacyCleanup}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
