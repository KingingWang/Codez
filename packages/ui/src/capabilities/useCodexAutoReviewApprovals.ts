import { useCallback, useEffect, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import {
  codexCapabilitySource,
  projectCodexCapabilities,
} from "@/capabilities/codexCapabilities.js";
import {
  bindRuntimeCapabilityRefresh,
  type RuntimeRefreshSource,
} from "@/capabilities/useCodexDesktopFileRewindCapability.js";

/** hello 响应 → autoReviewApprovals 是否明确 supported（纯函数，供 hook 与测试共用）。 */
export function codexAutoReviewApprovalsSupported(hello: { capabilities?: unknown }): boolean {
  return (
    projectCodexCapabilities(codexCapabilitySource(hello)).autoReviewApprovals.status ===
    "supported"
  );
}

/**
 * 读取 Host hello 的 autoReviewApprovals 能力投影（specs/codex-permission-modes.md）。
 * "帮我审批"（approvalsReviewer:"auto_review"）依赖原生 guardian approval；
 * fail-closed：hello 缺失、探测失败或旧 peer 缺省字段都按不可用处理，
 * 只有明确 supported 才返回 true（composer 据此展示 edit 档）。
 * runtime 重启 / transport 替换后重新 hello，刷新期间回落不可用，
 * 避免能力面长期滞留旧运行时的事实（与 file rewind capability 同模式）。
 */
export function useCodexAutoReviewApprovals(
  services: IServiceAccessor,
  enabled: boolean,
  runtime?: RuntimeRefreshSource,
): boolean {
  const [supported, setSupported] = useState(false);
  const [revision, setRevision] = useState(0);
  const agentService = services.codezAgentService;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    setSupported(false);
    if (!enabled || !agentService?.helloConversationV4) return;
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (!cancelled) setSupported(codexAutoReviewApprovalsSupported(hello));
      })
      .catch(() => {
        if (!cancelled) setSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, enabled, revision]);
  const onRuntimeRestart = runtime?.onRuntimeRestart;
  const onRuntimeLifecycle = runtime?.onRuntimeLifecycle;
  useEffect(
    () => bindRuntimeCapabilityRefresh({ onRuntimeRestart, onRuntimeLifecycle }, refresh),
    [onRuntimeRestart, onRuntimeLifecycle, refresh],
  );
  return supported;
}
