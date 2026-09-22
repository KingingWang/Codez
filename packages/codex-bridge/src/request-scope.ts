import { codexRequestSchema, type CodexRequest } from "@zcode/shared";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CodexRpcPort } from "./contract.js";
import { array, object } from "./json.js";

function mismatch(): never {
  throw Object.assign(new Error("Request workspace scope mismatch"), { code: -32602 });
}

async function sameExecutionPath(value: unknown, cwd: string): Promise<boolean> {
  if (value === cwd) return true;
  if (typeof value !== "string" || !isAbsolute(value)) return false;
  try {
    // macOS /var 与 /private/var（及目录 junction）可指向同一 cwd；不能用字符串误拒绝。
    const [requested, current] = await Promise.all([realpath(value), realpath(cwd)]);
    return requested === current;
  } catch {
    return false;
  }
}

/** Compare filesystem paths, never coalesce explicit Host identities. */
export async function scopeWorkspaceParams(
  params: unknown,
  cwd: string,
  workspaceId: string,
): Promise<unknown> {
  if (!params || typeof params !== "object" || !("workspace" in params) || !params.workspace)
    return params;
  const workspace = object(params.workspace);
  const identity =
    typeof workspace.workspaceIdentity === "string"
      ? workspace.workspaceIdentity.trim()
      : undefined;
  if (identity && identity !== workspaceId) mismatch();
  if (
    workspace.workspacePath !== undefined &&
    !(await sameExecutionPath(workspace.workspacePath, cwd))
  )
    mismatch();
  if (
    workspace.workspaceKey &&
    workspace.workspaceKey !== workspaceId &&
    !(await sameExecutionPath(workspace.workspaceKey, cwd))
  )
    mismatch();
  if (workspace.workspacePath === undefined || workspace.workspacePath === cwd) return params;
  // 仅执行路径规范化；保留 Host 已授权的 path-fallback 身份，避免订阅隔离 key 漂移。
  return {
    ...params,
    workspace: { ...workspace, workspacePath: cwd, workspaceIdentity: identity || workspaceId },
  };
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
  if (
    params.cwd !== undefined &&
    params.cwd !== null &&
    !(await sameExecutionPath(params.cwd, cwd))
  )
    mismatch();
  if (
    params.cwds !== undefined &&
    params.cwds !== null &&
    (!Array.isArray(params.cwds) ||
      (await Promise.all(params.cwds.map((path) => sameExecutionPath(path, cwd)))).some(
        (same) => !same,
      ))
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
