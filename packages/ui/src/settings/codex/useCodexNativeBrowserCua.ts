import { useEffect, useState } from "react";
import { DesktopCommandIds } from "@codez/shared";
import type { IServiceAccessor } from "@codez/services";
import { usePlatform } from "@/hooks/usePlatform.js";

/**
 * 读取 Host hello 的 nativeBrowserCuaMcp 能力投影。
 * 远端工作区或缺少 helloConversationV4 时保持 undefined，由分类器按 unsupported 处理；
 * UI 不得自行探测或从 MCP 状态推断能力（spec: codex-desktop-native-browser-cua）。
 */
export function useCodexNativeBrowserCuaCapability(
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

/**
 * 仅在能力允许（degraded/supported）、本地桌面且平台命令存在时向 Main 读取描述符。
 * 结果原样透传，schema 校验由调用方负责，避免 hook 内产生第二份事实。
 */
export function useCodexNativeBrowserCuaDescriptor(
  capability: string | undefined,
  remote: boolean,
): { descriptor?: unknown; error?: string } {
  const platform = usePlatform();
  const [state, setState] = useState<{ descriptor?: unknown; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    setState({});
    const capabilityAllows = capability === "degraded" || capability === "supported";
    if (remote || !capabilityAllows || typeof platform.executeDesktopCommand !== "function") return;
    void platform
      .executeDesktopCommand(DesktopCommandIds.GetCodexNativeBrowserCuaMcpDescriptor)
      .then((value) => {
        if (!cancelled) setState({ descriptor: value });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [capability, platform, remote]);
  return state;
}
