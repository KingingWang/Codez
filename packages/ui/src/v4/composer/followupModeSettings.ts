import type { AppSettings } from "@codez/shared";
import type { InputRouting, SessionConfigState } from "@codez/shared/codez-protocol-v4";

export function resolveAppFollowupMode(
  settings: AppSettings | null | undefined,
): SessionConfigState["followupMode"] | null {
  if (!settings) return null;
  return settings.codezInteractionBehavior === "guide" ? "guide" : "queue";
}

export function resolveOppositeFollowupDelivery(
  mode: SessionConfigState["followupMode"],
): "startNow" | "queue" {
  // queue 模式的修饰键发送曾被解释成 guide；“立即发送”实际是队列既有的抢占语义。
  return mode === "guide" ? "queue" : "startNow";
}

export function resolveComposerFollowupDelivery({
  nativeCodex,
  busy,
  nativeIntent,
  followupMode,
  reverse,
}: {
  nativeCodex: boolean;
  busy: boolean;
  nativeIntent: "queue" | "guide";
  followupMode?: SessionConfigState["followupMode"];
  reverse: boolean;
}): "startNow" | "queue" | "guide" | undefined {
  // 原因：Codex 快照的 followupMode 固定为 queue，且桌面不接受旧
  // setFollowupMode；仅靠投影模式无法表达用户选中的引导。显式意图随
  // 本次命令提交，空闲仍交给 native startNow，旧运行时行为保持不变。
  if (nativeCodex) {
    if (!busy) return undefined;
    return reverse ? resolveOppositeFollowupDelivery(nativeIntent) : nativeIntent;
  }
  return reverse && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined;
}

export function shouldEnableModifiedEnterSubmit({
  inputRoutingMode,
}: {
  inputRoutingMode: InputRouting["mode"];
}): boolean {
  return inputRoutingMode !== "reject";
}

export function shouldReverseFollowupDeliveryForPointer({
  enabled,
  metaKey = false,
  ctrlKey = false,
  isApplePlatform,
}: {
  enabled: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isApplePlatform?: boolean;
}): boolean {
  return (
    enabled &&
    (isApplePlatform === undefined
      ? metaKey || ctrlKey
      : isPrimaryFollowupModifierPressed({ isApplePlatform, metaKey, ctrlKey }))
  );
}

export function isPrimaryFollowupModifierPressed({
  isApplePlatform,
  metaKey = false,
  ctrlKey = false,
}: {
  isApplePlatform: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return isApplePlatform ? metaKey : ctrlKey;
}

interface FollowupModifierTooltip {
  delivery: "startNow" | "queue";
  shortcut: string;
  titleId: "chat.followup.sendNow" | "chat.followup.addToQueue";
}

export function resolveFollowupModifierTooltip({
  enabled,
  canSend,
  modifierPressed,
  followupMode,
  isApplePlatform,
}: {
  enabled: boolean;
  canSend: boolean;
  modifierPressed: boolean;
  followupMode: SessionConfigState["followupMode"] | undefined;
  isApplePlatform: boolean;
}): FollowupModifierTooltip | null {
  if (!enabled || !canSend || !modifierPressed || !followupMode) return null;
  const delivery = resolveOppositeFollowupDelivery(followupMode);
  return {
    delivery,
    shortcut: isApplePlatform ? "⌘ + Enter" : "Ctrl + Enter",
    titleId: delivery === "startNow" ? "chat.followup.sendNow" : "chat.followup.addToQueue",
  };
}
