import { useCallback, useEffect, useMemo, useState } from "react";
import type { ICodezAgentService } from "@/codex-capability-ui/contract.js";
import {
  codexCapabilitySource,
  projectCodexCapabilities,
  type CodexFeatureAvailability,
} from "@/capabilities/codexCapabilities.js";
import {
  bindRuntimeCapabilityRefresh,
  type RuntimeRefreshSource,
} from "@/capabilities/useCodexDesktopFileRewindCapability.js";

/**
 * 逐条消息反馈（点赞/点踩）能力门控。
 *
 * 原生 Codex 的 app-server 只有 `feedback/upload` 上报通道，没有 per-message
 * feedback API；bridge 因此显式投影 `messageFeedback: "unsupported"`。UI 必须
 * 在 unsupported/unavailable 时隐藏点赞/点踩，而不是渲染一个点了再静默回滚的死按钮
 * （specs/codex-desktop-capabilities.md「UI rules」）。
 */
export function useCodexMessageFeedbackCapability(
  agentService: Pick<ICodezAgentService, "helloConversationV4"> | undefined,
  workspace: { workspacePath: string; workspaceIdentity?: string },
  runtime?: RuntimeRefreshSource,
  nativeCodex = true,
): CodexFeatureAvailability {
  const identity = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const [revision, setRevision] = useState(0);
  const [source, setState] = useState<{ available: false } | { available: true; codex?: unknown }>({
    available: false,
  });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!nativeCodex || !agentService?.helloConversationV4) {
      setState({ available: false });
      return undefined;
    }
    let cancelled = false;
    setState({ available: false });
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (!cancelled) setState(codexCapabilitySource(hello));
      })
      .catch(() => {
        if (!cancelled) setState({ available: false });
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, identity, revision, nativeCodex]);

  const availability = useMemo(() => projectCodexCapabilities(source).messageFeedback, [source]);
  const onRuntimeRestart = runtime?.onRuntimeRestart;
  const onRuntimeLifecycle = runtime?.onRuntimeLifecycle;
  useEffect(
    () =>
      nativeCodex
        ? bindRuntimeCapabilityRefresh({ onRuntimeRestart, onRuntimeLifecycle }, refresh)
        : undefined,
    [onRuntimeRestart, onRuntimeLifecycle, refresh, nativeCodex],
  );

  return availability;
}

export function isCodexMessageFeedbackAvailable(
  availability: CodexFeatureAvailability,
  nativeCodex = true,
): boolean {
  // 根因：设备类型不能代替 Host 事实，native 手机同样没有逐条反馈 API。
  // native 应用能力门禁；真正的 legacy/Web 仍保留其反馈命令。
  return !nativeCodex || availability.status === "supported";
}
