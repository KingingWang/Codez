import { codexRequestSchema, type CodexRequest } from "@codez/shared";
import { resolve } from "node:path";
import type { BridgeControlContext, CodexRpcPort } from "./contract.js";
import { sameExecutionPath } from "./execution-path.js";
import { array, object } from "./json.js";
import {
  OFFICIAL,
  ensureOfficialRegistered,
  trustOfficialPluginHooks,
} from "./control-official-plugins.js";

function mismatch(): never {
  throw Object.assign(new Error("Request workspace scope mismatch"), { code: -32602 });
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

export interface NativeRequestOutcome {
  result: unknown;
  afterResponse?: () => Promise<void>;
}

/**
 * 设置 → Codex 面板的原生透传入口。读路径保持纯透传，但官方市场语义与商店
 * 控制面对齐：plugin/* 之前确保内置官方市场已注册（面板才能看到官方插件）；
 * 内置官方市场不可经原生 marketplace/remove 移除；官方市场 upgrade 先走
 * CDN 刷新管线；官方插件原生安装后补齐钩子信任。
 */
export async function handleCodexNativeRequest(
  params: unknown,
  context: BridgeControlContext,
  publishWorkspaceConfig: () => Promise<void>,
): Promise<NativeRequestOutcome> {
  // 先解析信封识别官方插件相关方法：scopedNativeRequest 对 plugin/read 与
  // plugin/install 会用原生 plugin/list 校验 marketplacePath，注册必须先于该校验。
  const envelope = codexRequestSchema.safeParse(params);
  if (envelope.success && envelope.data.method.startsWith("plugin/"))
    await ensureOfficialRegistered(context);
  const request = await scopedNativeRequest(params, context.rpc, context.cwd);
  const requestParams = object(request.params ?? {});
  if (request.method === "marketplace/remove" && requestParams.marketplaceName === OFFICIAL)
    throw Object.assign(new Error("The built-in official marketplace cannot be removed"), {
      code: -32000,
    });
  if (request.method === "marketplace/upgrade" && requestParams.marketplaceName === OFFICIAL) {
    if (!context.officialPlugins)
      throw Object.assign(new Error("Official catalog is not available"), { code: -32000 });
    try {
      await context.officialPlugins.refresh();
    } catch {
      throw Object.assign(
        new Error("Official ZCode catalog refresh failed verification; old catalog retained"),
        { code: -32000 },
      );
    }
    // 本地物化市场没有原生可升级的远端；刷新已原子换入新目录，plugin/list 重新读盘即生效。
    return { result: { selectedMarketplaces: [OFFICIAL], upgradedRoots: [], errors: [] } };
  }
  const result = await context.rpc.request(request.method, request.params);
  if (
    request.method === "plugin/install" &&
    context.officialPlugins &&
    typeof requestParams.marketplacePath === "string" &&
    resolve(requestParams.marketplacePath) === resolve(context.officialPlugins.path)
  ) {
    // 与商店安装路径一致：官方插件原生安装后补齐钩子信任；失败保持未信任，不回滚安装。
    await trustOfficialPluginHooks(context, `${String(requestParams.pluginName)}@${OFFICIAL}`);
  }
  return {
    result,
    afterResponse: async () => {
      if (
        [
          "config/value/write",
          "config/batchWrite",
          "account/logout",
          "skills/config/write",
        ].includes(request.method)
      ) {
        await publishWorkspaceConfig();
      }
    },
  };
}
