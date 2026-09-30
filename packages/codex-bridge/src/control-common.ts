import { z } from "zod";
import type { BridgeControlContext, CodexRpcPort } from "./contract.js";
import {
  isRelaxedThread,
  projectThreadMode,
  type NativePermissionDefaults,
  type TurnPermissionIntent,
} from "./command-input.js";
import type { JsonObject } from "./json.js";

export class ControlError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: { method: string; reason: string },
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export function unsupported(method: string, reason: string): never {
  throw new ControlError(-32601, `${method}: ${reason}`, { method, reason });
}

export function input<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ControlError(-32602, `Invalid parameters for ${method}`, {
      method,
      reason: result.error.message,
    });
  }
  return result.data;
}

export function checkWorkspace(
  workspace: { workspacePath: string },
  context: BridgeControlContext,
  method: string,
): void {
  if (workspace.workspacePath !== context.cwd) {
    throw new ControlError(-32602, "Workspace does not match this bridge attachment", {
      method,
      reason: "workspace_mismatch",
    });
  }
}

export async function readPages<T>(
  context: BridgeControlContext,
  method: string,
  schema: z.ZodType<T>,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const pageSchema = z.object({ data: z.array(schema), nextCursor: z.string().nullable() });
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = pageSchema.parse(
      await context.rpc.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }),
    );
    rows.push(...result.data);
    if (!result.nextCursor) return rows;
    if (seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new ControlError(-32000, "Codex pagination did not terminate", {
    method,
    reason: "invalid_pagination",
  });
}

export const configResponseSchema = z.object({
  config: z.object({
    model: z.string().nullable().optional(),
    model_provider: z.string().nullable().optional(),
    model_reasoning_effort: z.string().nullable().optional(),
    sandbox_mode: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .nullable()
      .optional(),
    // workspace-write 的生效细节（可写根/网络等）；custom 恢复时保真透传。
    sandbox_workspace_write: z
      .object({
        writable_roots: z.array(z.string()).optional(),
        network_access: z.boolean().optional(),
        exclude_tmpdir_env_var: z.boolean().optional(),
        exclude_slash_tmp: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    approval_policy: z.unknown().optional(),
    approvals_reviewer: z.enum(["user", "auto_review", "guardian_subagent"]).nullable().optional(),
    mcp_servers: z
      .record(
        z.string(),
        z.object({
          command: z.string().optional(),
          url: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
});

export async function readConfig(context: BridgeControlContext) {
  return configResponseSchema.parse(
    await context.rpc.request("config/read", { cwd: context.cwd, includeLayers: false }),
  ).config;
}

/**
 * 读取 config.toml 生效权限值（specs/codex-permission-modes.md）。
 * custom 档从放宽态切回时用它显式恢复原生默认；读取失败或值不可映射时返回
 * undefined，由调用方回退 workspaceWrite + on-request + user 基线。
 */
export async function readNativePermissionDefaults(
  context: BridgeControlContext,
): Promise<NativePermissionDefaults | undefined> {
  let config: z.infer<typeof configResponseSchema>["config"];
  try {
    config = await readConfig(context);
  } catch {
    // 固定文案，不携带路径/配置内容；不阻断提交（spec 失败语义）。
    process.stderr.write(
      "Codex desktop bridge warn: config/read failed while restoring custom permission mode; falling back to the workspace-write baseline.\n",
    );
    return undefined;
  }
  // sandbox_mode → 原生 v2 SandboxPolicy（camelCase 线格式）；
  // granular permission profile 等未知形态不可映射，交由调用方基线兜底。
  const workspaceWrite = config.sandbox_workspace_write;
  const sandboxPolicy =
    config.sandbox_mode === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : config.sandbox_mode === "workspace-write"
        ? {
            type: "workspaceWrite",
            writableRoots: workspaceWrite?.writable_roots ?? [],
            networkAccess: workspaceWrite?.network_access ?? false,
            excludeTmpdirEnvVar: workspaceWrite?.exclude_tmpdir_env_var ?? false,
            excludeSlashTmp: workspaceWrite?.exclude_slash_tmp ?? false,
          }
        : config.sandbox_mode === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : undefined;
  // approval_policy 只透传 bridge 档位使用的两种；untrusted/on-failure 等交由基线兜底。
  const approvalPolicy =
    config.approval_policy === "on-request" || config.approval_policy === "never"
      ? config.approval_policy
      : undefined;
  // guardian_subagent 是 auto_review 的旧别名（serde alias），统一投影为 auto_review。
  const approvalsReviewer =
    config.approvals_reviewer === "auto_review" || config.approvals_reviewer === "guardian_subagent"
      ? "auto_review"
      : config.approvals_reviewer === "user"
        ? "user"
        : undefined;
  if (!sandboxPolicy && !approvalPolicy && !approvalsReviewer) return {};
  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  };
}

/**
 * 计算本次请求的权限意图（specs/codex-permission-modes.md）：
 * 仅档位相对线程投影发生迁移时下发覆盖，避免每次提交重置原生会话内已授权；
 * custom 从放宽态（完全访问沙箱 / AI 代批）切回时读取 config.toml 生效值恢复，
 * 读取失败回退空 defaults（= workspaceWrite + on-request + user 基线）。
 */
export async function turnPermissionIntent(
  context: BridgeControlContext,
  thread: JsonObject,
  mode: string | undefined,
): Promise<TurnPermissionIntent> {
  const apply = mode !== undefined && mode !== projectThreadMode(thread);
  if (!apply || mode !== "custom" || !isRelaxedThread(thread)) return { apply };
  return { apply, configDefaults: (await readNativePermissionDefaults(context)) ?? {} };
}

/**
 * 抢占共用的中断步骤（specs/codex-desktop-adapter.md）：interrupt 响应以 TurnAborted 为界，返回时线程已空闲。
 * 失败静默——turn 可能恰好已自然完成；紧随的 start 请求以原生线程状态做最终裁决，
 * 线程仍忙时由它原样报错，不能在这里用兜底分支掩盖。
 */
export async function preemptByInterrupt(
  rpc: CodexRpcPort,
  native: { threadId: string },
  turnId: string,
): Promise<void> {
  try {
    await rpc.request("turn/interrupt", { ...native, turnId });
  } catch {
    // 抢占尝试不以前置中断成败为门禁；最终一致性由紧随的 start 请求裁决。
  }
}
