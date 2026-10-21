import { useEffect, useState } from "react";
import type { ICodezAgentService } from "@codez/services";
import { codexCapabilitySource } from "@/capabilities/codexCapabilities.js";

export type CodexNativeHostStatus = "pending" | "native" | "legacy";

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
export function useCodexNativeHostStatus(
  agentService: Pick<ICodezAgentService, "helloConversationV4"> | undefined,
  workspace: { workspacePath: string; workspaceIdentity?: string },
  enabled: boolean,
): CodexNativeHostStatus {
  const identity = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const probeEnabled = enabled && Boolean(agentService?.helloConversationV4);
  const [resolution, setResolution] = useState<{
    agentService: Pick<ICodezAgentService, "helloConversationV4"> | undefined;
    identity: string;
    probeEnabled: boolean;
    status: CodexNativeHostStatus;
  }>(() => ({
    agentService,
    identity,
    probeEnabled,
    status: probeEnabled ? "pending" : "legacy",
  }));

  // React 会先渲染新 workspace/Host，再运行 effect。若沿用上一轮的 legacy/native
  // 结果，这一个渲染窗口可能误发不兼容的 setFollowupMode；未匹配当前探测目标时
  // 直接视为 pending，直到 hello 给出权威结论。
  const resolutionMatchesCurrentTarget =
    resolution.agentService === agentService &&
    resolution.identity === identity &&
    resolution.probeEnabled === probeEnabled;
  const status: CodexNativeHostStatus = !probeEnabled
    ? "legacy"
    : resolutionMatchesCurrentTarget
      ? resolution.status
      : "pending";

  useEffect(() => {
    if (!probeEnabled || !agentService?.helloConversationV4) {
      setResolution({ agentService, identity, probeEnabled, status: "legacy" });
      return undefined;
    }
    let cancelled = false;
    setResolution({ agentService, identity, probeEnabled, status: "pending" });
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (!cancelled) {
          setResolution({
            agentService,
            identity,
            probeEnabled,
            status: codexNativeHostFromHello(hello) ? "native" : "legacy",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolution({ agentService, identity, probeEnabled, status: "legacy" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, identity, probeEnabled]);
  return status;
}

export function useCodexNativeHost(
  agentService: Pick<ICodezAgentService, "helloConversationV4"> | undefined,
  workspace: { workspacePath: string; workspaceIdentity?: string },
  enabled: boolean,
): boolean {
  return useCodexNativeHostStatus(agentService, workspace, enabled) === "native";
}
