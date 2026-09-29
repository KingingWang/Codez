import { useEffect, useState } from "react";
import type { IServiceAccessor } from "@codez/services";
import {
  codexCapabilitySource,
  projectCodexCapabilities,
} from "@/capabilities/codexCapabilities.js";

/**
 * 读取 Host hello 的 autoReviewApprovals 能力投影（specs/codex-permission-modes.md）。
 * "帮我审批"（approvalsReviewer:"auto_review"）依赖原生 guardian approval；
 * fail-closed：hello 缺失、探测失败或旧 peer 缺省字段都按不可用处理，
 * 只有明确 supported 才返回 true（composer 据此展示 edit 档）。
 */
export function useCodexAutoReviewApprovals(services: IServiceAccessor, enabled: boolean): boolean {
  const [supported, setSupported] = useState(false);
  const agentService = services.codezAgentService;
  useEffect(() => {
    let cancelled = false;
    setSupported(false);
    if (!enabled || !agentService?.helloConversationV4) return;
    void agentService
      .helloConversationV4()
      .then((hello) => {
        if (cancelled) return;
        const projection = projectCodexCapabilities(codexCapabilitySource(hello));
        setSupported(projection.autoReviewApprovals.status === "supported");
      })
      .catch(() => {
        if (!cancelled) setSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentService, enabled]);
  return supported;
}
