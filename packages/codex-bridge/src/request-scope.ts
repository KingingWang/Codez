import { codexRequestSchema, type CodexRequest } from "@zcode/shared";
import type { CodexRpcPort } from "./contract.js";
import { array, object } from "./json.js";

function mismatch(): never {
  throw Object.assign(new Error("Request workspace scope mismatch"), { code: -32602 });
}

/** Verify explicit identities without removing the existing local-path fallback. */
export function assertWorkspaceScope(params: unknown, cwd: string, workspaceId: string): void {
  if (!params || typeof params !== "object" || !("workspace" in params) || !params.workspace)
    return;
  const workspace = object(params.workspace);
  if (workspace.workspacePath !== undefined && workspace.workspacePath !== cwd) mismatch();
  const identity =
    typeof workspace.workspaceIdentity === "string"
      ? workspace.workspaceIdentity.trim()
      : undefined;
  if (identity && identity !== workspaceId) mismatch();
  if (
    workspace.workspaceKey &&
    workspace.workspaceKey !== workspaceId &&
    workspace.workspaceKey !== cwd
  )
    mismatch();
}

export async function scopedNativeRequest(
  value: unknown,
  rpc: CodexRpcPort,
  cwd: string,
): Promise<CodexRequest> {
  const parsed = codexRequestSchema.safeParse(value);
  if (!parsed.success)
    throw Object.assign(new Error("Invalid native settings request"), { code: -32602 });
  const request = parsed.data;
  const params = object(request.params ?? {});
  if (params.cwd !== undefined && params.cwd !== null && params.cwd !== cwd) mismatch();
  if (
    params.cwds !== undefined &&
    params.cwds !== null &&
    (!Array.isArray(params.cwds) || params.cwds.some((path) => path !== cwd))
  )
    mismatch();
  // 仅白名单方法还不够：cwd/cwds 不能扩大当前 attachment 的工作区读权限。
  if (request.method === "config/read") return { ...request, params: { ...params, cwd } };
  if (request.method === "skills/list" || request.method === "plugin/list")
    return { ...request, params: { ...params, cwds: [cwd] } };
  if (
    ["plugin/read", "plugin/install"].includes(request.method) &&
    typeof params.marketplacePath === "string"
  ) {
    const response = object(await rpc.request("plugin/list", { cwds: [cwd] }));
    if (
      !array(response.marketplaces).some((entry) => object(entry).path === params.marketplacePath)
    )
      mismatch();
  }
  return request;
}
