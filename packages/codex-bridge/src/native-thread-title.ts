import { isInjectedCodexContextTitle } from "@codez/shared";
import type { CodexThread } from "./codex-types.js";

export function nativeThreadTitle(thread: CodexThread): string {
  if (thread.name != null) return thread.name;
  // 修复原因：某些 Codex rollout 的首个 user-role item 是注入的环境块。
  // 原生 preview 未收敛到真实 UserMessage 前，不能把该块投成任务标题。
  return isInjectedCodexContextTitle(thread.preview) ? "" : thread.preview;
}
