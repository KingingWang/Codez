import type { CodexModelSelectionPort, CodexModelSelectionWorkspaceTarget } from "./contract.js";

export const modelWorkspaceExample = {
  workspacePath: "/workspace/example",
} satisfies CodexModelSelectionWorkspaceTarget;

/** 默认读取也携带 workspace；模型/effort 不由示例补成虚假的选择。 */
export function workspaceModelViewExample(service: CodexModelSelectionPort) {
  return service.getView({ selection: null, workspace: modelWorkspaceExample });
}
