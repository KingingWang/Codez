import { useCallback, useEffect, useMemo, useState } from "react";
import type { ICodezAgentService } from "@codez/services";
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
  isDesktop = true,
): CodexFeatureAvailability {
  const identity = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const [revision, setRevision] = useState(0);
  const [source, setState] = useState<{ available: false } | { available: true; codex?: unknown }>({
    available: false,
  });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!isDesktop || !agentService?.helloConversationV4) {
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
  }, [agentService, identity, revision, isDesktop]);

  const availability = useMemo(() => projectCodexCapabilities(source).messageFeedback, [source]);
  const onRuntimeRestart = runtime?.onRuntimeRestart;
  const onRuntimeLifecycle = runtime?.onRuntimeLifecycle;
  useEffect(
    () =>
      isDesktop
        ? bindRuntimeCapabilityRefresh({ onRuntimeRestart, onRuntimeLifecycle }, refresh)
        : undefined,
    [onRuntimeRestart, onRuntimeLifecycle, refresh, isDesktop],
  );

  return availability;
}

export function isCodexMessageFeedbackAvailable(
  availability: CodexFeatureAvailability,
  isDesktop = true,
): boolean {
  // 根因：共享 SessionPane 曾把 legacy/Web hello 缺少 Codex authority 误判为
  // 不支持反馈。仅桌面应用 Codex gate，其他 surface 保留既有反馈命令。
  return !isDesktop || availability.status === "supported";
}
