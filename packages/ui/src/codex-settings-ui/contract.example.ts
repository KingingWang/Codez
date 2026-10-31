import type { CodexSettingsRpcPort } from "./contract.js";

/** 本地 path fallback 的显式只读请求；远端调用仍须补齐既有 identity。 */
export function codexConfigReadExample(
  port: CodexSettingsRpcPort,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return port.codexRequest({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    request: { method: "config/read" },
  });
}
