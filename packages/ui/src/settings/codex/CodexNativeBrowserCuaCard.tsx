import { nativeBrowserCuaMcpDescriptorResultSchema } from "@codez/shared";
import { Button } from "@/components/ui/button.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import {
  classifyCodexNativeBrowserCua,
  installCodexNativeBrowserCuaMcp,
  isCodexNativeBrowserCuaConfigured,
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
}: {
  controller: CodexSettingsController;
  remote?: boolean;
  nativeBrowserCuaCapability?: string;
  descriptorOverride?: unknown;
}) {
  const text = useCodexMessages();
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
  );
}
