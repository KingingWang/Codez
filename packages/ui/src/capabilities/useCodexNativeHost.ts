import { useEffect, useState } from "react";
import type { ICodezAgentService } from "@codez/services";
import { codexCapabilitySource } from "@/capabilities/codexCapabilities.js";

/** hello 响应 → 对端 Host 是否为 Codex bridge（纯函数，供 hook 与测试共用）。 */
export function codexNativeHostFromHello(hello: { capabilities?: unknown }): boolean {
  const source = codexCapabilitySource(hello);
  // codexUnavailable（探测失败）与旧 peer 缺省 codex 面都不是 bridge 事实。
  return source.available && source.codex !== undefined;
}

/**
 * 对端 Host 是否为 Codex bridge（hello.capabilities 携带 codex 能力投影）。
 * 手机远控等无桌面 catalog 的链路据此开启 native 排队/引导入口；
 * fail-closed：hello 缺失、探测失败或旧 peer 缺省字段都按非 Codex 处理，
 * 此时 composer 保持旧 followupMode 语义，不出现原生选择器。
 */
export function useCodexNativeHost(
  agentService: Pick<ICodezAgentService, "helloConversationV4"> | undefined,
  workspace: { workspacePath: string; workspaceIdentity?: string },
  enabled: boolean,
): boolean {
  const identity = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const [native, setNative] = useState(false);
  useEffect(() => {
    setNative(false);
    if (!enabled || !agentService?.helloConversationV4) return undefined;
    let cancelled = false;
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (!cancelled) setNative(codexNativeHostFromHello(hello));
      })
      .catch(() => {
        if (!cancelled) setNative(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, identity, enabled]);
  return native;
}
