import type { CodezProvider } from "@codez/shared";

export function resolveWorkspaceHeaderProvider(
  activeTaskProvider: CodezProvider | null,
  selectedProvider: CodezProvider,
): CodezProvider {
  // 当前 task 打开时，Header 应展示 task 自己的 provider；
  // 否则在“仅切换新建任务 provider”后会误显示成 workspace 级选择，和当前会话上下文不一致。
  return activeTaskProvider ?? selectedProvider;
}
