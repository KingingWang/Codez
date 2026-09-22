import type { ConversationSnapshot, SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

export function resolveCodexPrewarmConfig(
  draft: Partial<SessionConfigState>,
): Partial<SessionConfigState> | undefined {
  const selection = draft.modelSelection;
  if (!selection?.providerId || !selection.modelId || !draft.mode) return undefined;
  // 展示层空 thought/provider 不是原生配置；native 明确拒绝空 reasoning_effort。
  return {
    mode: draft.mode,
    planEnabled: draft.planEnabled ?? false,
    modelSelection: selection,
    provider: selection.providerId,
    model: selection.modelId,
    ...(selection.options?.reasoningLevel ? { thought: selection.options.reasoningLevel } : {}),
  };
}

export function isQueueSendNowAvailable(
  nativeCodex: boolean,
  availability: ConversationSnapshot["availability"]["sendQueuedNow"] | undefined,
): boolean {
  // 原生 busy 队列不能抢占；旧 UI 的 Steer 按钮曾忽略 availability 并发送必拒绝的命令。
  return !nativeCodex || availability?.allowed === true;
}

export function isCodexComposerBusy(
  snapshot: Pick<ConversationSnapshot, "control"> | null | undefined,
): boolean {
  const control = snapshot?.control;
  return Boolean(
    control &&
    (control.phase === "running" ||
      control.phase === "prewarming" ||
      control.canStop ||
      control.stopState === "stopping"),
  );
}

export function codexSubmissionMatchesThread(
  submission: ComposerSubmissionConfig,
  config: Partial<SessionConfigState>,
): boolean {
  const selected = submission.modelSelection;
  const current = config.modelSelection;
  // bridge 投影已将 readOnly/workspaceWrite 统一为 build；不能把 readonly 当成权限变更。
  return (
    selected.providerId === (current?.providerId ?? config.provider) &&
    selected.modelId === (current?.modelId ?? config.model) &&
    (selected.options?.reasoningLevel === undefined ||
      selected.options.reasoningLevel === (current?.options?.reasoningLevel ?? config.thought)) &&
    submission.mode === config.mode &&
    submission.planEnabled === (config.planEnabled ?? false)
  );
}

export function codexSubmissionSettingsAllowed(
  submission: ComposerSubmissionConfig,
  snapshot: Pick<ConversationSnapshot, "control" | "config"> | null | undefined,
  requestedDelivery?: string,
): boolean {
  // 空闲 queue 也会复用 native 线程配置；startNow 可由 native 先中断再更新设置。
  const constrained =
    requestedDelivery === "queue" ||
    (requestedDelivery !== "startNow" && isCodexComposerBusy(snapshot));
  return (
    !constrained || Boolean(snapshot && codexSubmissionMatchesThread(submission, snapshot.config))
  );
}
