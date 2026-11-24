import {
  CODEZ_AGENT_PROVIDER,
  CODEZ_AGENT_PROVIDER_LABEL,
  type CodezProvider,
} from "@codez/shared";

export const CODEZ_AGENT_PROVIDERS: CodezProvider[] = [CODEZ_AGENT_PROVIDER];

export const CODEZ_AGENT_PROVIDER_LABELS: Record<CodezProvider, string> = {
  glm: CODEZ_AGENT_PROVIDER_LABEL,
};

export function supportsCodezSessionFork(provider: CodezProvider): boolean {
  void provider;
  // 功能开关：fork 入口恢复对所有 Codez provider 开放；实际可操作性仍由 task 状态、
  // assistant 目标和运行中保护 guard 控制，避免把 active/failed 分支暴露为可 fork。
  return true;
}

export function shouldHideCodezSessionForkAction(provider: CodezProvider): boolean {
  return !supportsCodezSessionFork(provider);
}
